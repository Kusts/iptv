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
> complete AND the app is pointed at `APP_DATABASE_URL`. Since 2026-10-05 a
> production boot without `APP_DATABASE_URL` logs a loud `RLS BYPASSED`
> warning at startup (`warnOnOwnerFallback`, `apps/api/src/app.module.ts`) so
> the inert state cannot pass unnoticed.
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
`TEST_DATABASE_URL`, so cutover = set `APP_DATABASE_URL` + restart, no code
change. Migrations/DDL MUST keep using `DATABASE_URL` (owner, direct, never
pooled) — never point the migration job at `APP_DATABASE_URL`.

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
tenant-context leak across pooled connections. Either failure reverts by
pointing the app back at the owner string — record which revision runs where
before flipping.

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
  (`warnOnOwnerFallback` in `apps/api/src/app.module.ts`). The SQL proof
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

## Platform enrollment design decision (OPEN — blocks cutover with billing/finance)

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

Pattern 1 is the default candidate (smaller bypass surface, matches the
certified 043/009 discipline). The known index gap also lands with this
slice: `outbox_pending_idx` lacks a `tenant_id` prefix (finding from
2026-09-29, above). Until platform + billing (+ `billing.tenant_channels`
043-shaped resolver) + finance enroll, the global cutover stays BLOCKED.
