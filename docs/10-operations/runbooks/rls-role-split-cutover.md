# Runbook — RLS Role Split Cutover (Steps 1–2 Done, Steps 3–4 Pending)

> Status: Steps 1 (role split) + 2 (`SET LOCAL` plumbing) shipped behind the
> current connection string. Production RLS rollout (step 3) is NOT done.
> Source: `docs/spikes/rls-pooling-spike.md`, migration `041`, `db/tests/007`.

## Current state

- Role `iptv_app` (`LOGIN`, `NOBYPASSRLS`) exists; pilot grants cover only
  `USAGE ON SCHEMA crm` + `SELECT/INSERT/UPDATE/DELETE ON crm.customers`.
- `crm.customers` has `ENABLE ROW LEVEL SECURITY` + `tenant_isolation` policy
  (`USING`/`WITH CHECK` on `app.tenant_id`, fail-closed when unset).
- Every command transaction runs `SELECT set_config('app.tenant_id', $1, true)`
  first (`withTenantTransaction` in `@iptv/database`, adopted by
  `KyselyCommandDb.withTransaction`).
- The app still connects as the owner/superuser (`iptv`), which bypasses RLS —
  so the policy is currently inert in production. This is intentional until
  step 3. Do NOT treat RLS as enforced until the cutover below is complete.

## Dual connection path

| Traffic                 | Role      | Connection string env | Pooling          |
| ----------------------- | --------- | --------------------- | ---------------- |
| Migrations / DDL / jobs | owner     | `DATABASE_URL`        | direct, never pooled |
| Application DML         | `iptv_app`| `APP_DATABASE_URL`    | pooled (transaction mode only after step 4 cert) |

`applyMigrations` already takes any connection string — pass the owner URL.
`createDb` already takes any connection string — the app switches by pointing
it at `APP_DATABASE_URL`. No code change is needed for either; only config.

Local cutover rehearsal (disposable DB, never production):

```powershell
$owner = "postgresql://iptv:iptv@localhost:5432/iptv_rls_test"
$env:TEST_DATABASE_URL = $owner
pnpm --filter @iptv/database test
Get-Content -Raw "db\tests\007_rls_app_role_pilot.sql" `
  | docker exec -i iptv-postgres-1 psql -U iptv -d iptv_rls_test -v ON_ERROR_STOP=1 -f -
```

## Cutover checklist (step 3 gate, all required before switching)

1. Per-domain policy + `GRANT` rollout beyond `crm.customers` (97 `tenant_id`
   tables; global tables need explicit allow-list policies, not the tenant
   template).
2. `tenant_id`-leading index verified per newly enforced table
   (`crm.customers` already has `customers_status_idx`).
3. `EXPLAIN` on hot paths (`platform.outbox_messages`,
   `finance.financial_ledger_entries`) with policies on.
4. `ALTER ROLE iptv_app PASSWORD '...'` via the approved secrets path
   (Infisical ADR-0014 when implanted; operator vault until then), then set
   `APP_DATABASE_URL` to the `iptv_app` connection string.
5. Repeat the spike checks through the real app pool: tenant A/B isolation,
   fail-closed with no context, cross-tenant write blocked, owner sees all.
6. Keep the owner string on the migration job only; audit that no app
   deployment still carries it.

## What breaks if the order is inverted

Switching the app to `iptv_app` before the context plumbing + grants for a
table ship means fail-closed reads (0 rows = total outage on that table) or
`permission denied` writes. Switching without step 4 (pooler cert) risks
tenant-context leak across pooled connections. Either failure reverts by
pointing the app back at the owner string — record which revision runs where
before flipping.
