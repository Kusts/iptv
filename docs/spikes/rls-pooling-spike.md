# Spike Wave 0 — PostgreSQL RLS multi-tenant + pooling

- Date: 2026-09-29. Owner: database-engineer (spike MVP-RLS-01).
- Environment (pinned): PostgreSQL 17.11 (image `postgres:17-alpine`, container
  `iptv-postgres-1`, `max_connections=100`), local docker compose DB.
- Baseline refs: `docs/15-implementation-baseline/19-open-items-and-validation.md`
  (RLS = defense-in-depth target; promotion needs pooling/background-worker proof
  without unsafe bypass) and `10-integrations-certification.md`.
- Test artifact: `db/tests/006_rls_spike.sql` (rolled-back transaction, zero
  persistent change). No production migration was created in this spike.

## 1. What was proven (real output)

Run (against the local container, no secret printed, nothing persisted):

```powershell
Get-Content -Raw "db\tests\006_rls_spike.sql" `
  | docker exec -i iptv-postgres-1 psql -U iptv -d iptv -v ON_ERROR_STOP=1 -f -
```

Result: **PASS** — all six checks emitted NOTICE and the transaction rolled back:

- `spike app role iptv_app_spike confirmed NOBYPASSRLS`
- `tenant A isolation OK: 1 own row per table, 0 cross-tenant rows`
- `tenant B isolation OK: 1 own row per table, 0 cross-tenant rows`
- `fail-closed OK: no tenant context => 0 rows`
- `cross-tenant write blocked OK (WITH CHECK => insufficient_privilege)`
- `owner bypass OK: superuser sees both tenants (BYPASSRLS)` + `ROLLBACK`

Post-run verification (queries, not the spike): `rls_on = 0` across all 109 user
tables, `spike_role_left = 0`, `spike_policies_left = 0` — the spike left no
residue, and the existing `002_tenant_isolation.sql` FK defense is untouched.

Representative tables: `crm.customers` and `communication.conversations` — both
carry `tenant_id uuid NOT NULL REFERENCES control.tenants(id)` plus a composite
`(tenant_id, person_id) REFERENCES identity.persons(tenant_id, id)` FK, i.e. the
same shape as most of the 97 `tenant_id` tables. Pattern proven:

```sql
ALTER TABLE crm.customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm.customers
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

Two iterations were needed to get there (recorded, not hidden): `SET LOCAL ROLE`
leaks across `DO` blocks inside one transaction, and so does `SET LOCAL
app.tenant_id` — each block must `RESET ROLE` / `RESET app.tenant_id` first.
That leak is itself a finding: connection/transaction-scoped context must be
reset explicitly, which is exactly the discipline pooling requires (see §3).

## 2. What works today vs what is missing for production

Works today (no code change):

- Tenant column discipline: 97/109 tables carry `tenant_id`; composite
  `(tenant_id, id)` FKs (e.g. `customers_person_fk`, `conversations_person_fk`)
  already reject cross-tenant *writes* at the FK level (`002_tenant_isolation`).
- Outbox/inbox reliability pattern is polling-based (`next_attempt_at` /
  `inbox_processing_idx`), not `LISTEN`/`NOTIFY` — grep over `db/migrations`,
  `packages`, `apps` finds zero `LISTEN`/`NOTIFY`. Nothing to redesign for a
  pooler on that axis.
- Kysely (`kysely@0.28.8`) over `pg@8.16.3` issues parameterized queries via the
  extended protocol (unnamed statements); no persistent `PREPARE` in app code.

Missing for production RLS (do NOT flip the switch yet):

1. **Role split.** Today there is exactly one login role, `iptv`, which is
   superuser + `BYPASSRLS` — with it, any `ENABLE ROW LEVEL SECURITY` is a
   no-op for the app path. Production needs at minimum: `iptv_owner`
   (DDL/migrations, `BYPASSRLS`), `iptv_app` (`NOBYPASSRLS`, only the DML grants
   each table needs — the spike grants `SELECT, INSERT, UPDATE, DELETE` on just
   the two tables), and optionally a read-only role. `FORCE ROW LEVEL SECURITY`
   should be evaluated for tables the owner also queries with tenant context.
2. **97-table rollout, not 2.** Policy + per-table `GRANT` + `tenant_id` index
   verification for every tenant table; global tables (`control.tenants`,
   `provider.providers`, `agent.agent_releases`, …) need explicit allow-list
   policies, not the tenant template.
3. **Context plumbing in the app.** `packages/database/src/db.ts` builds one
   `pg.Pool` (`max` default 10, no timeouts) consumed directly by the API
   (`apps/api/src/app.module.ts`). No place today sets `app.tenant_id`, and the
   spike proves fail-closed behavior (no context ⇒ 0 rows): switching the app
   role without plumbing the context first is a guaranteed total outage. The
   context must be `SET LOCAL` as the first statement of **every**
   tenant transaction (single auto-commit statements cannot use `SET LOCAL` —
   they need a `withTransaction` wrapper or the RLS check must degrade to a
   statement-safe form).
4. **Migration-runner path.** `migrate.ts` holds a session-level
   `pg_advisory_lock` on a dedicated pooled connection for the whole run. That
   is incompatible with transaction-mode pooling — migrations must run on a
   direct (or session-mode) connection as the owner role, never through the
   app pool.

## 3. Pooling recommendation (pgBouncer) and risk to current code

Recommended shape when a pooler is introduced:

- Migrations/owner traffic: direct connection, owner role. Never pooled.
- App traffic: pgBouncer **transaction mode** is acceptable *only* with: (a)
  `SET LOCAL app.tenant_id` per transaction + reset discipline (§1 leak lesson);
  (b) no session-level advisory locks on pooled connections (move the
  migration lock to the direct path); (c) no persistent prepared statements
  through the pooler (`server_reset_query`, default `ignore_startup_parameters`
  handling; Kysely/`pg` defaults are compatible as long as nobody adds named
  prepares). Session mode removes (a)–(c) constraints at the cost of lower
  connection reuse — prefer it if tenant-context plumbing cannot be proven
  first.
- Sizing/timeouts (starting point, measure before fixing): app `Pool` max sized
  against pgBouncer `default_pool_size` and PG `max_connections=100`
  (e.g. pool 20/instance only if instance count × 20 + owner + headroom ≤ 100);
  `connectionTimeoutMillis ≈ 5000`, `idleTimeoutMillis ≈ 30000`,
  `statement_timeout ≈ 30s`, `idle_in_transaction_session_timeout ≈ 60s`
  (catches leaked `SET LOCAL` transactions). None of these are set today.

Risks to current code if pooling lands without the above: tenant-context leak
across pooled connections (cross-tenant reads — the exact failure RLS is meant
to stop); migration advisory-lock silently not serializing (concurrent migrate
runs); fail-closed outage on missing context; policy overhead on hot paths
(`platform.outbox_messages`, `finance.financial_ledger_entries`) without
`tenant_id`-leading index verification.

## 4. Risks carried forward

- Owner-vs-app: a single superuser connection string (`DATABASE_URL`) serves
  both DDL and app DML today; RLS is theater until the role split + grant
  discipline ships and every new migration is reviewed for `GRANT`/policy.
- Migrations-as-superuser: any `ALTER … FORCE ROW LEVEL SECURITY` or policy
  change must be append-only migrations with the advisory-lock path intact.
- `LISTEN`/`NOTIFY`: absent today (verified by grep); if any future workflow
  (Hatchet local scheduler, outbox drain) adopts it, transaction-mode pooling
  breaks it — keep the polling pattern or pin those workers to session mode.
- 97-table policy surface: each policy is a query-rewrite on every access;
  roll out per domain with `EXPLAIN` on the hot queries, not in one big bang.

## 5. Recommendation

**Keep RLS as defense-in-depth target; do NOT promote to production yet.**
Next ordered steps: (1) role split + owner-direct migration path; (2) per-txn
`SET LOCAL app.tenant_id` plumbing behind a `withTransaction` helper with
reset-on-checkout tests; (3) per-domain policy rollout (crm/communication
first — this spike is the template) with index + `EXPLAIN` evidence;
(4) pgBouncer transaction-mode certification repeating *this* spike through
the pooler (tenant A/B + fail-closed + owner bypass) before any `FORCE RLS`.
Inconclusive-or-missing evidence on any step keeps the gate closed per the
Wave 0 spike rule; the happy-path demo above is necessary but not sufficient.
