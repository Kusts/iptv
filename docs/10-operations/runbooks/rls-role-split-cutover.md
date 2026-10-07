# Runbook — RLS Role Split Cutover (Steps 1–4 Executed on Disposable DBs)

> Status: Steps 1 (role split) + 2 (`SET LOCAL` plumbing) shipped behind the
> current connection string. Steps 3 (per-domain rollout crm/communication)
> + 4 (cutover rehearsal + pooler cert) EXECUTED 2026-09-29 against disposable
> databases only — see execution log below. Control + identity enrolled
> 2026-10-05 (migration `047`, SQL proof `db/tests/012`, integration test
> `rls-control-identity.integration.test.ts`) — also disposable DBs only; see
> the second execution log. The app still connects as the
> owner/superuser (`iptv`), which bypasses RLS — the policy is currently inert
> in production. Do NOT treat RLS as enforced until the cutover checklist is
> complete AND the app is pointed at `APP_DATABASE_URL`. Production boot now
> fails closed without a valid restricted `APP_DATABASE_URL` (exact
> `iptv_app` authority, no privileged/test env vars in the API process —
> `assertNoPrivilegedDatabaseEnv` + `validateProductionAppDatabaseUrl` in
> `packages/config`, enforced by both `loadConfig` and
> `resolveAppConnectionString` in `apps/api/src/app.module.ts`): a
> not-yet-cut-over production API refuses to boot by design, so the guard
> proves the CONFIGURED identity only — it does not prove the connected
> role's effective privileges, enable RLS, or complete the cutover.
> Source: `docs/spikes/rls-pooling-spike.md`, migrations `041`/`042`/`043`/`047`,
> `db/tests/006`/`007`/`008`/`009`/`012`.

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
`resolveAppConnectionString` (`apps/api/src/app.module.ts`) selects the API
pool string with precedence `APP_DATABASE_URL` → `DATABASE_URL` →
`TEST_DATABASE_URL` outside production, so a local/pre-cutover setup keeps
working unchanged; with `NODE_ENV=production` there is NO fallback — the
resolver enforces the same restricted-`APP_DATABASE_URL` rule and throws.
Cutover = set `APP_DATABASE_URL` + restart, no code change.
Migrations/DDL MUST keep using `DATABASE_URL` (owner, direct, never
pooled) — never point the migration job at `APP_DATABASE_URL`.

> **Boot guard (engineering only, NOT the cutover).** With
> `NODE_ENV=production` the API process now *requires* `APP_DATABASE_URL` with
> **no fallback** to `DATABASE_URL`/`TEST_DATABASE_URL`, and it must be a
> `postgres://`/`postgresql://` URI whose authority username is **exactly
> `iptv_app`**, with **no `user=`, `role=`, `options=` or `host=`/`port=`/
> `database=`/`db=`/`dbname=` query parameter** and **no repeated parameter**
> (`pg://` is accepted alongside `postgres://`/`postgresql://`; query keys must be
> canonical lowercase because the driver consumes lowercase parameters; TLS
> settings must not be ambiguous — `ssl=false` is refused because the installed
> parser leaves it truthy, libpq-compat `verify-ca` needs a non-blank
> `sslrootcert` parameter while `verify-full` does not, `ssl`/`sslmode` together or
> `sslnegotiation=direct` with TLS explicitly disabled are refused — while TLS
> itself is not mandated)
> Explicit TLS disable (`ssl=0` or `sslmode=disable`) is also refused with
> nonblank `sslcert`, `sslkey` or `sslrootcert`: certificate options can
> override `ssl=0`, while the `sslmode=disable` combination remains conflicting
> and may trigger certificate-file handling.
> (`user` is the driver identity override; `options` is forwarded to server
> startup and could request a role change, e.g. `-c role=owner` — whether that
> succeeds depends on server-side role membership/privileges, which this guard
> does **not** verify; `role` is denied **by policy**, with no claim about
> current driver behavior; the target keys would override the target the URI
> already states). The URI must also state its **target explicitly** — non-empty
> host and database name — so the driver cannot fall back to ambient
> `PGHOST`/`PGDATABASE`. The value must also contain no ASCII control
> characters — tab/LF/CR
> are stripped by URL parsing and could smuggle a different connection string.
> The URI username, password, hostname, raw query string and database path must
> additionally have
> well-formed percent escapes and must not decode to an ASCII control character
> (`URLSearchParams` turns `%00`/`%09` into real control characters), URI
> fragments are forbidden (any literal `#`, including a bare trailing one; an
> encoded `%23` inside a component stays ordinary data), and
> `sslnegotiation` must be exactly `postgres` or `direct`. `PGAPPNAME` is allowed
> but refused when it contains an ASCII control character.
> The guard also
> refuses a
> non-blank `DATABASE_URL`, `DATABASE_OWNER_URL`, `TEST_DATABASE_URL`,
> `POSTGRES_PASSWORD`, `PGPASSWORD` or `PGOPTIONS` in the API env (`PGOPTIONS`
> feeds the same driver startup options from outside the URI), plus the
> driver-consumed target/transport variables `PGHOST`, `PGPORT`, `PGDATABASE`,
> `PGUSER`, `PGSSLMODE`, `PGSSLNEGOTIATION` — for those, only an empty string
> counts as absent.
> `loadConfig` and the pool
> factory `resolveAppConnectionString` share one implementation
> (`apps/api/README.md` → "Production configuration fail-fast").
>
> This is a fail-closed *precondition* on the **configured** identity only: it
> changes no grants, policies, migrations or pool mode, does not make the app
> role RLS-enforced, and does not unblock any checklist item below. It never
> queries the server, so it does **not** prove the connected role's effective
> privileges — `iptv_app` could still be a superuser, own tables, hold
> `BYPASSRLS`/`CREATEROLE` or belong to an owner role. Verifying that is a
> separate, server-side step. A production API whose env is not yet cut over
> will now refuse to start — that is intended; do not "fix" it by re-adding
> `DATABASE_URL` to the API env.

Local cutover rehearsal (disposable DB, never production):

```powershell
$owner = "postgresql://iptv:iptv@localhost:5432/iptv_rls_test"
$env:TEST_DATABASE_URL = $owner
pnpm --filter @iptv/database test
Get-Content -Raw "db\tests\007_rls_app_role_pilot.sql" `
  | docker exec -i iptv-postgres-1 psql -U iptv -d iptv_rls_test -v ON_ERROR_STOP=1 -f -
```

## Cutover checklist (step 3 gate, all required before switching)

> ⛔ GLOBAL CUTOVER IS BLOCKED. `crm`, `communication` (041/042: 13
> tenant-scoped tables) and `control` + `identity` (047: 3 identity tables +
> `feature_flags` hybrid + global grants) are RLS-enrolled or granted. Every
> other domain (`platform`, `billing`, `finance`, `trial`, `subscription`,
> `commerce`, `catalog`, `inventory`, `support`, `knowledge`, `agent`,
> `referral`, `loyalty`, `renewal`, `growth`, `partners`, `analytics`,
> `experiments`, `security`, `entitlement`, `provider`) has NO grants/policies
> for `iptv_app` yet, so a global switch to `APP_DATABASE_URL` today means
> fail-closed reads (0 rows) or `permission denied` writes on all of those
> tables — total outage outside the enrolled domains. Do NOT cut over globally
> until the per-domain sequence below is complete for EVERY domain the app
> touches: per-domain inventory (tenant-scoped vs global tables) → grants +
> RLS policies (append-only migration) → SQL proof test (`db/tests/0NN`) →
> rehearsal through the real app path (tenant A/B isolation, fail-closed,
> cross-tenant write blocked, owner bypass) → then, and only then, cutover.
> Domain rollouts land one migration + one SQL test at a time; this runbook
> tracks which domains are enrolled.

Enrolled domains: `crm`, `communication` (041/042 + pre-context resolver 043);
`control` + `identity` (047/048 + membership resolvers + enrollment 049 —
`identity` fully enrolled, `control.feature_flags` hybrid policy,
`control.tenant_memberships`/`control.membership_roles` enrolled with the
pre-context reads rerouted through `SECURITY DEFINER` resolvers; see the
2026-10-06 enrollment log below).

1. [DONE 2026-09-29] Per-domain policy + `GRANT` rollout beyond
   `crm.customers`: migration `042` enforces all 12 remaining tenant-scoped
   tables in scope (`crm.leads`, `crm.customer_health_snapshots` +
   10 `communication.*` tables — see execution log). Zero global tables
   exist in `crm`/`communication` scope, so no allow-list exception policy
   was needed (asserted by `db/tests/008`).
2. [DONE 2026-09-29] `tenant_id`-leading index verified per newly enforced
   table (43 indexes checked — all 12 tables covered, no index migration
   needed). `EXPLAIN` evidence below. KNOWN GAP: `outbox_pending_idx`
   (`platform.outbox_messages`) lacks a `tenant_id` prefix — include a
   tenant-leading index when the `platform` domain enrolls (finding, not
   created: out of this step's scope).
3. [DONE 2026-09-29] `EXPLAIN` on hot paths with policies on (in-scope
   tables as `iptv_app`; `platform`/`finance` hot tables as owner baselines
   — they are not RLS-enrolled yet, so no app-role plan exists for them).
4. [REHEARSED, NOT APPLIED] `ALTER ROLE iptv_app PASSWORD '...'` via the approved secrets path
   (Infisical ADR-0014 when implanted; operator vault until then), then set
   `APP_DATABASE_URL` to the `iptv_app` connection string. Rehearsal proved
   the path on a disposable DB (4/4 checks as `iptv_app` through
   `withTenantTransaction`); the real `.env`/`DATABASE_URL` were NOT touched.
5. [PENDING against the real cutover] Repeat the spike checks through the real app pool: tenant A/B isolation,
   fail-closed with no context, cross-tenant write blocked, owner sees all.
6. Keep the owner string on the migration job only; audit that no app
   deployment still carries it.

## Pre-context lookups (migration 043, 2026-09-29)

`communication.tenant_channels` is RLS-enforced, so the WAHA ingress
(`WahaWebhookService.resolveChannel`) cannot use a direct `SELECT`: it runs
BEFORE any tenant context exists, and under `iptv_app` that read
fail-closes to 0 rows (every webhook would 404 after cutover). Migration
`043` adds the narrow escape hatch
`communication.resolve_tenant_channel(p_tenant_key text)` — `SECURITY
DEFINER`, owner-held, fixed `search_path`, revoked from `PUBLIC`, `EXECUTE`
to `iptv_app` only — returning the `ACTIVE` channel row for the routing key
and touching no other table. The service calls it via raw SQL; the resolved
`tenantId` feeds `withTenantTransaction` for everything after. Proof:
`db/tests/009` (pre-context lookup as `iptv_app`, direct read stays 0 rows,
ACTIVE-only, unknown/`DISABLED` → 0 rows, per-tenant containment).

Billing note (NOT yet applied): `billing.tenant_channels` is NOT
RLS-enrolled — the billing domain has no grants/policies, so
`AsaasWebhookService.resolveChannel` keeps its direct `SELECT` for now.
Apply this same `SECURITY DEFINER` resolver pattern there at billing-domain
rollout time (migration + SQL test + service switch, same shape as 043/009).

## What breaks if the order is inverted

Switching the app to `iptv_app` before the context plumbing + grants for a
table ship means fail-closed reads (0 rows = total outage on that table) or
`permission denied` writes. Switching without step 4 (pooler cert) risks
tenant-context leak across pooled connections. The production boot guard in
this branch deliberately removes the former owner fallback: do not roll back
to a production API build that uses `DATABASE_URL` as its runtime pool, and do
not restore owner credentials to the API environment. A production rollback is
valid only to a previously validated release that also uses `APP_DATABASE_URL`
with the restricted role and is schema-compatible. If no such release exists,
hold the deployment before cutover or fail closed and forward-fix; do not bypass
the guard to regain availability. Record the exact revision and connection role
for every attempted deployment.

## Steps 3–4 execution log (2026-09-29, database-engineer MVP-RLS-03)

Environment: PostgreSQL 17.11 (`iptv-postgres-1`), disposable databases
`iptv_rls_step3` (migrations + SQL tests), `iptv_rls_vitest` (fresh, vitest),
`iptv_rls_cutover` (password rehearsal), `iptv_rls_pool` (pooler cert).
Dev database `iptv` and real `.env`/`DATABASE_URL` were NOT touched.

### Step 3 — rollout migration 042

`db/migrations/202609300002_042_rls_crm_communications_rollout.sql`
(append-only): `USAGE` on schemas `crm`/`communication`, full DML grants to
`iptv_app`, `ENABLE ROW LEVEL SECURITY` + `tenant_isolation`
(`USING`/`WITH CHECK` on `app.tenant_id`, fail-closed) on all 12 tables:

- `crm.leads`, `crm.customer_health_snapshots` (`crm.customers` already
  enforced by 041 — 13 enforced tables total after this step);
- `communication.conversations`, `communication.messages`,
  `communication.message_deliveries`, `communication.communication_preferences`,
  `communication.communication_suppressions`,
  `communication.conversation_control_events`,
  `communication.tenant_channels`, `communication.exceptions`,
  `communication.message_intents`, `communication.scheduled_contacts`.

Global-table inventory: every `crm`/`communication` table carries
`tenant_id uuid NOT NULL` — ZERO global tables in scope, so no allow-list
exception policy exists or is needed. `db/tests/008` asserts this
programmatically (fails if a `tenant_id`-less table ever appears without an
exception policy).

### Step 3 — index validation (no index migration needed)

43 indexes inventoried on the 12 tables; each table has at least one
`tenant_id`-leading btree (explicit composite or the
`(tenant_id, id)` unique constraint). Hot-query plans AS `iptv_app`
(200 messages + 20 leads fixture, `EXPLAIN (ANALYZE, BUFFERS)`):

| Query | Plan (RLS on) | Cost | Exec |
|---|---|---|---|
| Q1 messages by `(tenant_id, conversation_id)` | Index Only Scan `messages_conversation_time_idx` (+ RLS one-time filter) | 0.31..8.33 | 0.38 ms |
| Q2 active conversations `(tenant_id, channel, status)` | Index Scan `conversations_active_idx` | 0.16..8.18 | 0.08 ms |
| Q3 leads by `(tenant_id, status)` | Index Scan `leads_status_idx` | 0.15..8.19 | 0.05 ms |

Owner baselines for not-yet-enrolled hot tables (no app-role plan possible
until their domain rollout — `iptv_app` has no grants there by design):

- Q4 `platform.outbox_messages` pending drain: Bitmap Heap + Bitmap Index
  Scan on `outbox_pending_idx`, cost 11.26..11.27 — **finding**:
  `outbox_pending_idx` is `(next_attempt_at, created_at)` with NO
  `tenant_id` prefix, so a future tenant-scoped drain cannot use an
  index-only tenant prefix. Add a tenant-leading index when `platform`
  enrolls; not created here (out of scope).
- Q5 `platform.inbox_messages` sweep: Index Scan `inbox_processing_idx`
  `(tenant_id, state, received_at)`, cost 8.17..8.18 — tenant-leading OK.
- Q6 `finance.financial_ledger_entries` by transaction: Bitmap Heap +
  Bitmap Index Scan on tenant-leading index, cost 4.19..11.32 — OK.

### Step 3 — SQL tests (direct + pooler)

- `db/tests/008_rls_crm_communications_rollout.sql` (new): preconditions on
  all 13 tables, allow-list assertion, 6-table isolation sample
  (tenant A/B, fail-closed, cross-tenant writes → `42501`), owner bypass.
- Results direct (`iptv_rls_step3`): **006 PASS, 007 PASS, 008 PASS**
  (all NOTICEs emitted, fixtures rolled back).
- Results through PgBouncer transaction mode (`iptv_rls_pool`, owner leg):
  **006 PASS, 007 PASS, 008 PASS** — `SET LOCAL`/`set_config` per-transaction
  semantics survive transaction pooling.

### Vitest

`pnpm --filter @iptv/database test` on fresh `iptv_rls_vitest`
(`TEST_DATABASE_URL`, disposable): **3 files, 16/16 PASS** — including
`migrate.integration` applying all 46 canonical migrations (through 046)
through the real `applyMigrations` runner with idempotent re-run,
and the `withTenantTransaction` app-role isolation test on the 042 surface.

### Step 4a — cutover rehearsal (disposable `iptv_rls_cutover` only)

1. Random 36-hex password generated in-shell (never printed, never stored);
   `ALTER ROLE iptv_app WITH LOGIN PASSWORD` executed ONLY in
   `iptv_rls_cutover`. Dev `iptv` and `.env` untouched.
2. Owner fixture: 2 tenants × (person, customer, conversation, lead,
   message) with fixed UUIDs.
3. Proof script (throwaway, outside repo) connecting AS `iptv_app` via
   `APP_DATABASE_URL` through the real `withTenantTransaction` wrapper:
   **4/4 PASS** — tenant A sees own rows (1 customer + 1 message), tenant B
   sees own rows, no-context reads 0 (fail-closed), cross-tenant insert
   blocked (`42501`).
4. Bottleneck: none observed — wrapper + RLS path adds sub-ms planning
   overhead (see Q1–Q3). The real-cutover risk is operational (secret
   distribution + switching the connection string), not query cost.

### Step 4b — PgBouncer certification (transaction mode)

- `docker-compose.yml`: new `pgbouncer` service under profile `pooling`
  ONLY (default path unchanged; image digest-pinned
  `edoburu/pgbouncer@sha256:4c1ca…`, PgBouncer 1.25.2 observed).
  Start: `docker compose --profile pooling up -d pgbouncer` (port 6432).
- `deploy/pgbouncer/pgbouncer.ini` (committed, non-secret):
  `pool_mode = transaction`, `server_reset_query = DISCARD ALL`.
- Auth finding (objective impediment hit and resolved): `auth_type = md5`
  FAILS against PG17 with `FATAL: server login failed: wrong password type`
  because the server stores SCRAM-SHA-256 secrets. Fix: `auth_type =
  scram-sha-256` with **plaintext** dev-only passwords in
  `deploy/pgbouncer/userlist.txt` (gitignored, LOCAL-DEV ONLY — the pooler
  needs cleartext to complete SCRAM toward the server). Generation:
  ```powershell
  '"iptv_app" "<36-hex-dev-password>"' | Set-Content deploy/pgbouncer/userlist.txt
  # + '"iptv" "<owner-dev-password>"' second line for owner-leg runs
  # then: ALTER ROLE iptv_app WITH LOGIN PASSWORD '<same>' in the test DB
  # then: docker compose --profile pooling up -d pgbouncer
  ```
- Leak probe as `iptv_app` through the pooler (one client session, three
  sequential transactions on potentially reused server connections):
  txn C sees own rows, txn D sees own rows, no-context txn sees **0 rows** —
  **PASS, no tenant-context leak**. Combined with 006/007/008 passing
  through the pooler, transaction-mode pooling is CERTIFIED for the
  enrolled domains under the `SET LOCAL`-per-transaction discipline.
- Session left stopped (`docker compose --profile pooling stop pgbouncer`);
  disposable DBs retained for re-verification (contain only test fixtures).

## Control + identity enrollment log (2026-10-05, hardening closure round)

`db/migrations/202610050000_047_rls_control_identity_rollout.sql` (append-only;
executed against disposable databases only) + `db/tests/012` +
`apps/api/test/rls-control-identity.integration.test.ts`:

- **identity fully enrolled** (tenant template from 042):
  `identity.persons`, `identity.identities`, `identity.identity_merge_reviews`
  — RLS + `tenant_isolation` (`USING`/`WITH CHECK` on `app.tenant_id`,
  fail-closed) + full DML grants to `iptv_app`.
- **`control.feature_flags` hybrid policy** (nullable `tenant_id`): `USING`
  sees `tenant_id IS NULL` (global defaults) OR the caller's tenant;
  `WITH CHECK` only allows the caller's tenant, so the app role can never
  create/overwrite a GLOBAL flag row.
- **Global control tables granted WITHOUT RLS** (deliberate — nothing to
  isolate): `control.tenants/users/auth_credentials/auth_sessions` (DML —
  the pre-context auth surface) and
  `control.roles/permissions/role_permissions` (SELECT — owner-seeded RBAC
  catalogs; isolation lives in the assignments, not the catalogs).
- **Pre-context caveat — cutover blocker NOT solved by 047**:
  `control.tenant_memberships` + `control.membership_roles` carry
  `tenant_id NOT NULL` but are read BEFORE any tenant context exists
  (`auth.listMemberships`, `PermissionsGuard.findActiveMembership` run on the
  raw pool). They receive DML grants but are deliberately NOT RLS-enrolled;
  enrolling them today would fail-close every login (0 memberships → 403).
  Unblock path DECIDED by the 2026-10-06 analysis (section below):
  a `043`-shaped `SECURITY DEFINER` membership resolver trio (superseded
  wording — the 047-era text said "pair" before the guard role-resolution
  function was added to the decision on 2026-10-06); moving the read
  inside a tenant transaction is infeasible for the true pre-context lookups
  (login/`resolveSession` exist precisely to DISCOVER the tenant).
  `db/tests/012` asserts this exception explicitly so it cannot silently grow.
- Safety rails added in the same round: `APP_DATABASE_URL` is now a validated
  config key (`packages/config`), and a production boot that resolves the API
  pool to the owner connection logs the `RLS BYPASSED` warning
  (`warnOnOwnerFallback` in `apps/api/src/app.module.ts` — superseded
  2026-10-06 by the fail-closed boot guard: `assertNoPrivilegedDatabaseEnv` +
  `validateProductionAppDatabaseUrl`, warn-only functions removed). The SQL proof
  suite (`db/tests/*.sql`) now runs in CI against a disposable database
  (`.github/workflows/ci.yml`).

## Control membership resolver analysis (2026-10-06, read-only discovery)

Question settled by code-path inventory: CAN `control.tenant_memberships` +
`control.membership_roles` be RLS-enrolled without breaking the app?
**Answer: yes — engineering-only, via the certified 043 pattern.** Findings
(all with file:symbol evidence, read-only pass over the current tree):

- **Pre-context `iptv_app` readers that would fail-close under own-tenant RLS:**
  `packages/auth/src/auth.ts:listMemberships` (called by `login` and
  `resolveSession` on the raw pool), `setActiveTenant`'s membership check
  (tenant switch), `apps/api/src/auth/permissions.guard.ts` (`findActiveMembership`
  + `listExtraRoleKeys` — every guarded request, before any
  `withTenantTransaction`), and the membership INSERTs in
  `packages/auth/src/auth.ts:register`, `apps/api/src/tenants/tenants.controller.ts:create`
  and the partners tenant-provision block. In-context readers that keep
  working untouched: `human-review/claim.commands.ts:handleClaim` and
  `support-store.ts:membershipIsActive` (both inside
  `withTenantTransaction`, tenant-filtered).
- **Breakage order if enrolled naively (047 header claim verified, one
  nuance):** login still returns 200 (credential/session tables are global)
  but with `activeTenantId = null` → `GET /v1/tenants` empty → switch 403
  `TENANT_FORBIDDEN` → every guarded route 403; the INSERT paths fail with
  `42501` (`WITH CHECK` on NULL context).
- **Outbox drain / scheduler / admin recover-reconcile do NOT read membership
  tables** — they are unaffected by THIS enrollment. The cross-tenant drain
  question belongs to the platform slice below, not here.
- **Decision (engineering):** option (A) — SECURITY DEFINER resolver trio
  (session-bound listing + switch check + guard role-resolution in one round
  trip). `control.list_memberships_for_session(p_token_hash)` (join
  `auth_sessions → tenant_memberships → tenants`, ALL-statuses session-bound —
  full parity with the pre-049 read),
  `control.check_membership_active(p_user_id, p_tenant_id)` and
  `control.resolve_membership_roles(p_user_id, p_tenant_id)` (one base-role +
  extras-array row); owner-held, `SET search_path = control, pg_temp`,
  `REVOKE ALL FROM PUBLIC`, `EXECUTE` to `iptv_app` only; then `ENABLE ROW
  LEVEL SECURITY` + plain `tenant_isolation` on both tables; swap the three
  reader call sites and wrap the three INSERT paths in
  `withTenantTransaction(<new tenant id>)` (context equals the row being
  created, so `WITH CHECK` passes). Two refinements landed during review:
  user-ACTIVE gating on the user_id-keyed functions (closes the
  suspended-user oracle at the DB layer), and the listing kept FULL-status
  parity with the pre-049 read while switch/guard remain ACTIVE-only.
  Option (B) — setting
  a tenant/user GUC earlier — was REJECTED: infeasible chicken-and-egg for the
  login discovery path, larger blast radius, no repo precedent. Option (C) —
  keeping the exception indefinitely — rejected as a permanent cross-tenant
  read over-grant on the membership graph.
- **Landing invariant:** migration `049` + `db/tests/013` (009-shaped:
  secdef/pinned search_path/`EXECUTE iptv_app`-only/narrow body/ACTIVE-only/
  unknown-or-expired token → 0 rows/per-session containment + enrolled-policy
  isolation sample + login→switch→guarded rehearsal) + the `db/tests/012`
  exception-block update + this runbook MUST land atomically in one commit —
  012 hard-fails if the tables enroll without its exception block updated
  (intended tripwire). Token-hash binding only: never raw tokens, never log
  the hash; the `user_id`-parameterized resolver variant is rejected (would
  allow membership enumeration by any app-role caller).
- **Scope note:** this closes the control domain only. Global cutover remains
  BLOCKED pending the platform/billing/finance rollouts below.

## Control membership enrollment log (2026-10-06)

Migration `049` (`db/migrations/202610060000_049_control_membership_resolvers.sql`)
landed atomically with the resolver call-site swaps, SQL proof `db/tests/013`,
the `db/tests/012` exception-block flip and this log — the atomic invariant
from the analysis above, honored:

- **Three `043`-shaped resolvers, owner-held, `SECURITY DEFINER`,
  `search_path = control, pg_temp`, `EXECUTE` to `iptv_app` only:**
  `control.list_memberships_for_session(text)` (login/`resolveSession`,
  ALL-statuses session-bound parity with the pre-049 read — ACTIVE-filtering
  happens at the login call site; unknown-or-expired token → 0 rows),
  `control.check_membership_active(uuid, uuid)` (`setActiveTenant` switch
  check) and `control.resolve_membership_roles(uuid, uuid)` (one
  base-role + extras-array row feeding `PermissionsGuard` in a single round
  trip, `MembershipLoader` contract preserved).
- **Call-site swaps:** `login` creates the session first (null active tenant),
  resolves memberships through the new session hash, then pins the first
  ACTIVE tenant; `resolveSession` passes its token hash; `setActiveTenant`
  and `PermissionsGuard` call their resolvers; the three membership INSERT
  paths (`auth.register`, `POST /v1/tenants`, partners provision) acquire
  tenant context equal to the row being created (partners pre-checks the slug before changing context and restores the source
  context in a `finally`; a concurrent same-slug race past the pre-check rolls back and surfaces as a 5xx retry rather than the business `SLUG_TAKEN` — the raw `23505`→business-error mapping gap is pre-existing and out of this slice's scope).
- **Both tables RLS-enrolled** with the plain `tenant_isolation` template;
  in-context readers (`human-review` claim, `support-store`) untouched and
  still green. Proof: `db/tests/013` (009-shaped + enrolled-policy isolation
  sample + login→switch→guard rehearsal as `iptv_app`) and
  `rls-control-identity.integration.test.ts` (enrollment + resolver coverage).
  013 additionally pins the review refinements (user-ACTIVE gating on the
  user_id-keyed functions, FULL-status listing parity) and the
  trigger-layered denial (the pre-existing 012
  `enforce_membership_role_tenant` trigger fires before RLS on
  `membership_roles`).
- **Cutover still BLOCKED:** engineering-only slice; the app still connects as
  the owner (`iptv`), and platform/billing/finance have no grants/policies yet.

## Platform enrollment design decision (SUPERSEDED — kept as history)

> SUPERSEDED 2026-10-06 by "Platform/outbox worker RLS — ACCEPTED DESIGN
> DIRECTION" below (hybrid C: separate worker process + `EXECUTE`-only narrow
> functions; pattern 1 via the API pool is REJECTED there, the global
> `outbox_pending_idx` is preserved, per-tenant claim stays deferred).
> The unsolved list below (inbox, scheduler loops, provider dispatcher, full
> worker inventory) still stands; global cutover stays BLOCKED.

`platform` carries the cross-tenant system spine
(`idempotency_keys`, `audit_log`, `domain_events`, `outbox_messages`,
`inbox_messages`) plus global catalogs (`capabilities`, `capability_events`,
`policy_documents` with nullable `tenant_id`). Tenant-scoped spine tables are
mechanically enrollable, but the **cross-tenant workers are not**: the
outbox drain (`OutboxDrainer`/dispatcher) claims `PENDING` rows across ALL
tenants with no `app.tenant_id` set — under `iptv_app` that claim
fail-closes to 0 rows and the outbox never drains. Candidate patterns,
decision deferred to the platform rollout slice:

1. Narrow `SECURITY DEFINER` claim/complete functions (043 shape): the
   drain claims a bounded batch through an owner-held, `search_path`-pinned,
   `PUBLIC`-revoked function; per-row handler work still runs inside
   `withTenantTransaction`.
2. Dedicated owner-pool connection for system workers only (outbox/inbox/
   scheduler), keeping all request-path DML on `iptv_app` — operationally
   simpler, but widens the bypass surface to worker code.

Pattern 1 was the default candidate here (smaller bypass surface, matches the
certified 043/009 discipline) — REJECTED by the accepted direction below
(the API process is the thing being isolated). The known index observation
also stands corrected by that decision: `outbox_pending_idx` lacks a
`tenant_id` prefix (finding from 2026-09-29, above) but the accepted global
claim keeps the global partial index unchanged; a lease-expiry index is
measured at implementation, not assumed. Until platform + billing (+ `billing.tenant_channels`
043-shaped resolver) + finance enroll, the global cutover stays BLOCKED.
---

# Platform/outbox worker RLS — ACCEPTED DESIGN DIRECTION

> **STATUS: ACCEPTED + PARTIALLY IMPLEMENTED (2026-10-07, issue #7) — DB
> LAYER DONE, WORKER PROCESS + STAGING PENDING, NOT CERTIFIED.**
> Migration `050` (`db/migrations/202610070000_050_platform_outbox_worker.sql`)
> creates the two roles, lease columns, audit table, four `SECURITY DEFINER`
> functions, `REVOKE FROM PUBLIC` + worker-only `EXECUTE`, executor-only RLS
> policies and the lease-recovery index; proof `db/tests/015` covers the
> single-session matrix (15/15 SQL files PASS on a zeroed disposable DB,
> seeds ×2) and `packages/database/test/outbox-worker-concurrency.integration.test.ts`
> covers real two-session SKIP LOCKED disjointness + cross-session CAS. These
> prove the DB boundary and fencing; they do NOT prove process-level items
> (the worker authenticating as its own LOGIN role end to end, backpressure
> under load, poison-row handling) or staging. Still missing: the separate
> worker process, removal of the in-process scheduler `drain(25)` (activation
> requires quiescing the legacy drain — see Rollback), staging with the new
> roles, and any certification. The paragraphs below remain the binding
> design record; "not implemented" notes inside them now refer to the
> process/staging remainder, not the DB layer.

## Scope

Only the **outbox publisher** (`platform.outbox_messages` → transport). See
"Not in scope" for what this explicitly does **not** solve.

## Current state in code (2026-10-06, read from the repository)

`apps/api/src/outbox/outbox-drainer.ts` + `apps/api/src/scheduler/scheduler.service.ts`:

- The drainer injects `"DB"` — the **API pool**, the same connection the command
  bus uses. The scheduler calls `this.outbox.drain(25)` in-process, last in the
  tick.
- Claim is **global and cross-tenant**: `WHERE state IN ('PENDING','FAILED') AND
  next_attempt_at <= now() ORDER BY created_at ASC LIMIT <n> FOR UPDATE SKIP
  LOCKED` — no `tenant_id` predicate and no tenant context set.
- Inside the claim transaction it commits `state = 'PUBLISHING'`,
  `attempt_count = attempt_count + 1`, `last_error_code = NULL`.
- Publish happens **outside** the claim transaction, then a separate
  `WHERE id = $1` update sets `PUBLISHED` (+ `published_at`) or `FAILED` (+
  `last_error_code`, `next_attempt_at = now() + 60s`).
- **There is no lease and no token/CAS fencing**: the completing UPDATE matches
  on `id` alone, so nothing stops a stale writer from overwriting a newer
  attempt's outcome.
- The table (`db/migrations/202609201530_001_platform.sql`) has
  `state IN ('PENDING','PUBLISHING','PUBLISHED','FAILED')`, `attempt_count`,
  `next_attempt_at`, `published_at`, `last_error_code`, and **no** lease-expiry
  or claim-owner column. Consequence today: a worker that dies mid-drain leaves
  rows in `PUBLISHING`, which the claim query never selects again — those rows
  are stuck permanently. A real worker design must fix that, not just restrict
  the role.
- `platform` is **not** an RLS-enrolled domain (only `crm` + `communication` +
  `identity` + `control` memberships are; see the checklist above), so the outbox table has no policy for `iptv_app`
  today, and no existing policy could express "one worker may see every tenant".

## Options considered

| Option | Shape | Verdict |
| --- | --- | --- |
| **A** | Narrow `SECURITY DEFINER` lifecycle functions in the existing schema, called by the API pool | **Rejected** — the API process is the thing being isolated, so this keeps its cross-tenant reach and makes the API role a de-facto worker executor. |
| **B** | Dedicated worker process + role with **direct table grants** (or `BYPASSRLS`) | **Rejected** — a broad grant set or `BYPASSRLS` re-creates the hole the cutover is closing, and grants drift. |
| **C** | Dedicated worker process + dedicated `LOGIN` role that owns nothing and holds **only `EXECUTE`** on four narrow static functions | **ACCEPTED** (the hybrid below). |

### Why an API DI pool is not isolation

Swapping the `DB` provider for a differently-configured pool inside the same API
process changes *when/how* connections are created, not *who* they authenticate
as. Same process, same code, same credentials → the same blast radius. Isolation
here is a **credential and privilege boundary**, which means a separate process
with its own `LOGIN` role.

### Why claim-only (a variant of A) fails

A claim-only function still leaves completion and failure as cross-tenant writes:
after publishing, the worker must set `PUBLISHED`/`FAILED` on a row belonging to
another tenant. Those updates need the same reach, so claim-only buys nothing —
it either reopens the hole on the completing UPDATE, or yields a worker that can
claim rows it cannot finish.

### Why broad worker DML / `BYPASSRLS` is rejected

Direct table grants must be enumerated and re-audited on every migration, and
`BYPASSRLS` makes the worker's RLS posture permanently invisible to review. Both
leave the worker able to read/write tenant rows outside the publish path.

### Why per-tenant claim is deferred

A per-tenant claim needs a tenant inventory/discovery query and re-opens
fairness fan-out (which tenant is served when the queue is contended). That is a
real design question and it is **deferred**, not dismissed: the implementation
must measure it before adopting it.

## Accepted design direction

- **Separate worker process.** Not the API process, not the API pool. The
  scheduler's existing `outbox.drain` call is expected to be removed once the
  worker exists — while both run they would double-publish.
- **Two roles.** A `LOGIN` role for the worker, and a `NOLOGIN NOINHERIT
  NOBYPASSRLS` **function-executor** role that owns the functions.
- **The worker gets `EXECUTE` only** on four narrow, static functions: claim,
  renew (heartbeat), complete (published), fail (failed/retry). **No direct table
  grants, no sequence grants, no `BYPASSRLS`.**
- **`REVOKE ALL … FROM PUBLIC`** on each function (and schema-level `USAGE`
  revocation as needed), so only the worker role can execute them.
- **The API cannot call these functions** — no `EXECUTE` for `iptv_app`, asserted
  by a proof test.
- **Fixed safe `search_path`** on every function (schema-qualified, no
  `pg_temp`/`public` shadowing), **static SQL only**, and a bounded `LIMIT`
  inside claim using `FOR UPDATE SKIP LOCKED`.
- **Table-scoped RLS policy for the executor role only.** Because the executor is
  deliberately `NOBYPASSRLS`, the outbox table needs a policy restricted to that
  role (`FOR ALL TO <executor>`). The worker is cross-tenant by design, so the
  policy's scope is exactly this one table and is not a pattern for other domains.
- **Server-generated lease + token + CAS fencing.** Claim returns a
  server-generated claim token and `lease_expires_at`; renew extends only while
  the token matches; complete/fail update `WHERE id = $1 AND claim_token = $2`, so
  a stale or resurrected worker cannot overwrite a newer attempt.
- **Append-only audit.** Every claim/renew/complete/fail is recorded, and the audit
  table is insert-only for the executor role.
- **At-least-once, explicitly not exactly-once.** A lease expiry means a row may
  be published twice — a paused sender can resume after its lease was reclaimed
  and re-published — so consumers must stay idempotent (the inbox already is).
  What the database *does* fence is the recorded outcome (a stale token cannot
  overwrite a newer attempt). Exactly-once delivery is **not** claimed and is not
  achievable here; fencing the external publish itself would require
  transport-side idempotency.

## Indexes

`outbox_pending_idx` (`next_attempt_at, created_at` WHERE `state IN
('PENDING','FAILED')`, migration 001) is **preserved unchanged**: the accepted
claim is still global, so the global partial index remains correct. Migration
050 CREATES a lease-expiry index (`outbox_lease_recovery_idx` on
`lease_expires_at` WHERE `state = 'PUBLISHING'`) as part of the DB protocol.
It is **provisional**: `outbox_claim` pins one `clock_timestamp()` per call so
the expiry predicate is a plain range comparison the planner *can* drive from
this index, but neither the plan choice nor the cost was measured against real
volume. Before activation, confirm the plan and shape against representative
volume (or drop it in a follow-up append-only migration if it proves
unnecessary). It is additive and harmless on rollback.

## Not in scope — explicitly unsolved

This decision does **not** cover, and must not be read as covering:

- **`platform.inbox_messages`** (inbound dedupe) — needs its own decision.
- **The scheduler's tenant-scoped due-command loops** — needs its own decision.
- **The provider dispatcher** (`provider-dispatcher.service.ts`, leased ops) —
  needs its own decision.
- **A full worker inventory.** Before any worker is built, every component that
  writes outside a tenant transaction must be inventoried; this record covers one
  component only.

## Acceptance criteria (all required before this is called done)

1. The worker connects as its own `LOGIN` role; a `current_user` proof test shows
   it is neither table owner nor `BYPASSRLS`.
2. Privilege-inventory proof test: the worker role holds `EXECUTE` on exactly the
   four functions and **zero** table/sequence privileges.
3. Proof test: `iptv_app` receives "permission denied" for every function.
4. Proof test: `PUBLIC` cannot execute any of them.
5. Stale-writer proof test: a worker holding an expired token cannot complete or
   fail a row claimed by another worker (CAS rejects).
6. Crash proof test: a killed worker leaves rows reclaimable after lease expiry —
   no permanently stuck `PUBLISHING` rows.
7. Claim-disjointness proof test: two workers never hold **current** claims on the
   same row at the same time (disjoint `SKIP LOCKED` claims, one live lease per
   row). This is the correct claim-level guarantee — it is deliberately **not**
   phrased as "never publish the same message twice": because leases expire, a
   paused or slow sender can resume and publish after its lease has already been
   reclaimed and re-published by another worker. **Duplicate or overlapping
   external publish across a lease expiry is permitted and expected**
   (at-least-once). The database-side fencing that *is* guaranteed is that the
   stale sender cannot record its outcome over the newer attempt (criterion 5).
   If absolute external-publish fencing is ever required, that is
   **transport-side** work (idempotency keys the receiver honours, or a
   transactional outbox at the consumer) and is out of scope here.
8. Tenant-scope proof test: the worker cannot read tenant tables it was never
   granted, and the audit trail records every state transition.
9. At-least-once behaviour documented for consumers, with idempotency asserted.

## Rollback

- **Activation gate (before the worker ever runs):** the gate is now a
  DATABASE live-interlock (migration `051`), not a copied env var. The
  runtime mode is authoritative in `platform.outbox_runtime_control`
  (singleton `id=1`, seed `LEGACY` gen 1); switch it ONLY through
  `platform.outbox_runtime_set(p_from, p_to, p_actor, p_expected_generation)` as the superuser
  operator (granted to nobody by design):
  `LEGACY -> QUIESCING -> WORKER` (rollback is forward-fix
  `WORKER -> QUIESCING -> LEGACY`, never a DOWN migration). Procedure:
  set `LEGACY_OUTBOX_DRAIN_ENABLED=0` (and/or stop the scheduler) →
  `GET /v1/admin/outbox/drain-state` until `inFlight = 0`
  (`waitForQuiescence` bounds the wait; a stopped trigger is NOT proof) →
  `SELECT platform.outbox_runtime_set('LEGACY','QUIESCING','<operator>', 1)`
  (the legacy drain now refuses new drains in `QUIESCING`/`WORKER` by
  consulting `platform.outbox_runtime_mode()` before every drain — same
  409 as the env kill-switch, which stays as defense in depth) → prove
  zero unfenced rows as owner
  (`SELECT count(*) FROM platform.outbox_messages WHERE state='PUBLISHING'
  AND lease_expires_at IS NULL` must be 0; rows WITH a lease never block —
  reclaim covers them) →
  `SELECT platform.outbox_runtime_set('QUIESCING','WORKER','<operator>', 2)`
  (refused while unfenced rows exist; concurrent second writers observe 0
  rows and fail via generation-CAS — pass the generation just observed via
  `platform.outbox_runtime_mode()`/control row, never a guessed number) → assert `OUTBOX_LEGACY_QUIESCED=1` AND copy the
  observed state (`OUTBOX_LEGACY_DRAIN_ENABLED=0`,
  `OUTBOX_LEGACY_IN_FLIGHT=0` — unknown refuses boot) →
  `outbox-worker check` (exit 0) → `run --once` smoke → start the loop.
  The worker needs no new hot-path call: `platform.outbox_claim` itself
  `RAISE`s outside `WORKER` mode. Disabling new ticks is necessary but not
  sufficient: a legacy `drain` already running holds no lease and completes
  by `id` alone (no CAS), so "let leases expire" does not wait for it.
- Disable the worker process and re-enable the previous drain path (API-side
  drain) — the only supported rollback, and only while the API still has that
  capability. **Never mark a claimed row `PUBLISHED` merely to clear state:**
  `outbox_complete` records an outcome; it does not deliver. A worker that
  died after claim and before publish leaves a `PUBLISHING` row whose
  delivery is UNKNOWN, and completing it would lose the message. Resolve
  worker-left rows only by: let the lease expire → reclaim with the current
  token → publish with confirmation → complete; when delivery is uncertain,
  RE-PUBLISH (at-least-once, consumers idempotent) rather than complete. A
  `PUBLISHING` row with a NULL lease left by the OLD drain is a pre-existing
  condition this migration does not repair. Once the API's cross-tenant reach
  is removed, rollback is **forward-fix only**: fix the worker, do not
  re-grant the API.
- Drop the functions/policies/grants in a new append-only migration; never edit
  or remove migration 001.
- Any new column/index is additive and stays in place on rollback — it is
  harmless and needed for a later retry.

## Revocation / rotation

- Revoke and re-grant `EXECUTE` to the worker role without restarting the
  database; the worker must fail closed on its next call.
- Rotate the worker role's password via `ALTER ROLE`; the worker must reload
  credentials without abandoning claimed rows (leases cover that gap).
- Suspected credential compromise: revoke `EXECUTE` immediately, let leases
  expire, then re-grant to a fresh role. No row state is repaired by hand — the
  reclaim path handles it.

## SQL proof tests

Implemented in `db/tests/015_platform_outbox_worker.sql` (single-session
matrix: worker-role privilege inventory, `PUBLIC` revocation,
API-cannot-execute, stale-token CAS rejection, lease-expiry reclaim,
claim-disjointness state/lease exclusion, executor RLS scoping, audit
append-only enforcement, bounds fail-closed). Real two-session concurrency
(`FOR UPDATE SKIP LOCKED` disjointness under an open row lock, and
cross-session CAS fencing) is proven by
`packages/database/test/outbox-worker-concurrency.integration.test.ts`. Still pending
before activation: the separate worker process, the quiescence of the legacy
drain, and staging with the new roles.

## Worker process + legacy quiescence (implemented 2026-10-07, issue #10)

The runtime half of this decision now exists, and migration 051 implements
the DB live-interlock protocol described above (supersedes the earlier
"no 051 was needed" note):

- **Process** `apps/outbox-worker/` (`@iptv/outbox-worker`, see its README):
  connects EXCLUSIVELY via `OUTBOX_WORKER_DATABASE_URL` (parse-time username
  must be exactly `outbox_worker`, identity query keys refused) and re-proves
  the posture on every boot (`current_user`/`session_user`, `pg_roles`
  attributes, zero memberships, no table privileges, EXECUTE on exactly the
  four functions). Boot order `config → connect → roleGuard → activation
  gate`; anything failing refuses to claim. Normal operation uses ONLY the
  four functions — no direct table SELECT/UPDATE. Loop: bounded
  claim → per-item envelope validation → publish with heartbeat renew
  (token-current, budgeted) → complete/fail; lost lease abandons without
  recording. Crash semantics A/B/C and at-least-once are documented in
  `apps/outbox-worker/README.md`. Disabled by default
  (`OUTBOX_WORKER_ENABLED=1` required).
- **Legacy quiescence** (`apps/api/src/outbox/outbox-drainer.ts`,
  `scheduler.service.ts`, `outbox.controller.ts`): the legacy drain is now
  explicitly disableable (`LEGACY_OUTBOX_DRAIN_ENABLED=0`, default `1`
  preserves current behavior), carries an in-flight gauge
  (`getDrainState()`), refuses new drains while disabled
  (`LEGACY_DRAIN_DISABLED`, POST maps to 409), is skipped by the scheduler
  tick when disabled, and exposes
  `GET /v1/admin/outbox/drain-state` (platform-admin-only) plus
  `waitForQuiescence()`/`awaitOutboxQuiescence()` for the procedure below.
  The legacy SQL itself is UNCHANGED (removal is a later slice, after
  certification).
- **Zero-coexistence proof**: the worker boot refuses unless
  `OUTBOX_LEGACY_QUIESCED=1` AND the observed legacy state is disabled with
  zero in flight (`checkActivationGate`; negative paths unit-tested); the API
  refuses legacy drains once disabled (tested, including gate-before-DB).
  Supported configurations are legacy-enabled+worker-disabled OR
  legacy-disabled+quiesced+worker-enabled — never both publishers live.
- **Activation procedure (staging/production)**: set
  `LEGACY_OUTBOX_DRAIN_ENABLED=0` (and/or stop the scheduler) →
  `GET /v1/admin/outbox/drain-state` until `inFlight = 0`
  (`waitForQuiescence` bounds the wait; a stopped trigger is NOT proof) →
  assert `OUTBOX_LEGACY_QUIESCED=1` AND copy the observed state
  (`OUTBOX_LEGACY_DRAIN_ENABLED=0`, `OUTBOX_LEGACY_IN_FLIGHT=0` — unknown
  refuses boot, never assume the API default) →
  `outbox-worker check` (exit 0) →
  `run --once` smoke → start the loop. Two worker instances are supported
  (disjoint `SKIP LOCKED` claims, stale token loses); start with one.
- **Rollback**: stop the worker (SIGTERM drains in-flight up to
  `OUTBOX_WORKER_SHUTDOWN_TIMEOUT_MS`, never forces outcomes) → confirm zero
  `PUBLISHING` rows with live leases (owner query) → only then consider
  re-enabling the legacy path. Residual `PUBLISHING` rows after a crash are
  forward-fix (restart the worker; the legacy drain cannot reclaim fenced
  rows). Never complete/fail rows artificially to clear state.
- **Staging / restore / cluster notes**: staging order is
  `postgres → migrate 001–050 (owner) → api (iptv_app, legacy disabled,
  quiesced) → outbox-worker (outbox_worker) → web`; set the worker password
  with `ALTER ROLE outbox_worker PASSWORD ...` (050 sets none) and keep it in
  the operator secret path, never in this repo. Roles are cluster-global: a
  database backup does NOT carry `outbox_worker`/`outbox_executor` — bootstrap
  them before restore/migrate on a fresh cluster (exact posture per 050, or
  the migration refuses), then rotate passwords. See
  [staging](staging-deploy.md) and [backup/restore](backup-restore.md).

Status after #10: `platform outbox DB = PASS`, `platform outbox runtime`
awaits CI green on the new suites plus a real staging/restore/cluster
rehearsal — until then it stays PENDING and the project stays
READY FOR CONTROLLED STAGING.
