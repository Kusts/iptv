# @iptv/api

NestJS + Fastify control-plane API. Owns the `/v1` HTTP surface, the command
bus, the durable inbox/outbox, provider/gateway ports and the opt-in
scheduler. Business rules live in the owning contexts under `src/`; shared
primitives live in the `@iptv/*` packages. Chronological delivery record:
`CHANGELOG.md`.

## Run

```sh
pnpm install
pnpm --filter @iptv/api dev     # build + watch (http://localhost:3001)
pnpm --filter @iptv/api build
pnpm --filter @iptv/api start
pnpm --filter @iptv/api test
```

`dev`/`start` load `apps/api/.env` and then the repo-root `.env`
(`--env-file-if-exists`). Point `DATABASE_URL` at a local PostgreSQL
(`docker compose up -d postgres`).

Tests need `TEST_DATABASE_URL` pointing at a **disposable, empty** database:
integration files apply all migrations themselves via `applyMigrations` in
`beforeAll`. Without it, integration files skip and the unit tests (memory
store, no network) still run. `vitest.config.ts` pins `maxWorkers: 1` and
`testTimeout: 15000` because integration files share one database and assert
on global outbox/inbox state. Never point tests at a database with real data.

Turbo does not load `.env`; export `TEST_DATABASE_URL` in the shell before
running the suite.

## Env

`packages/config` validates the boot subset (Zod); everything else is read
directly at the point of use and is safe to leave unset.

| Var | Default | Effect |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`/`test`/`production`; production tightens CORS and the auth secret. |
| `PORT` | `3001` | Listen port. |
| `LOG_LEVEL` | `info` | Fastify log level. |
| `DATABASE_URL` | unset | Owner/RLS-bypass connection; used for migrations/DDL only. **Rejected at boot when non-blank in a `NODE_ENV=production` API process.** |
| `APP_DATABASE_URL` | unset | Application pool connection (RLS app role). Outside production it falls back to `DATABASE_URL`, then `TEST_DATABASE_URL`; **in production it is mandatory and must be a URL-encoded, control-character-free `pg://`/`postgres://`/`postgresql://` URI with a non-empty host and database name, whose authority username is exactly `iptv_app`, with canonical lowercase literal query keys, no repeated parameter and no `user=`, `role=`, `options=` or host/port/database query parameter.** |
| `TEST_DATABASE_URL` | unset | Disposable DB for integration tests only; **rejected at boot when non-blank in a `NODE_ENV=production` API process**. |
| `DATABASE_OWNER_URL` | unset | Alternative owner-only spelling some deployment tooling may carry; never used as a connection, inspected only to reject non-blank in production — **rejected at boot when non-blank in a `NODE_ENV=production` API process**. |
| `POSTGRES_PASSWORD` | unset | Owner/superuser password (docker compose); never needed by the API. **Rejected at boot when non-blank in a `NODE_ENV=production` API process** (repo blank-means-absent rule). `PGPASSWORD` is covered by the driver-consumed row below and is stricter. |
| `PGOPTIONS` | unset | libpq/driver startup options; forwarded to server startup outside the URI and could request a role change (e.g. `-c role=owner`), subject to server-side membership/privileges this guard does not verify. **Rejected at boot when non-blank in a `NODE_ENV=production` API process.** |
| `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` / `PGSSLMODE` / `PGSSLNEGOTIATION` / `PGPASSWORD` / `PGOPTIONS` | unset | Variables the pg driver itself consumes. **Rejected in production when supplied at all** — only an empty string counts as absent, whitespace included, because the driver would consume a whitespace value just as readily. |
| `PGAPPNAME` | unset | Driver/server application name. Ordinary values (spaces included) are legal; **rejected at boot in production when it contains an ASCII control character** (NUL/tab/newline), which would otherwise reach driver startup parameters and server logs. |
| `BETTER_AUTH_SECRET` | dev-only value | Session-token pepper for `packages/auth`; **must** be overridden in production. |
| `BETTER_AUTH_URL` | unset | Auth base URL hint. |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:3000` outside production, `[]` (deny all) in production | Comma-separated exact `http(s)://host[:port]` origins. No wildcard, no path/query/hash. |
| `API_SCHEDULER_ENABLED` | `0` | `1` arms the in-process scheduler loop (non-durable). |
| `API_SCHEDULER_TICK_SECONDS` | `60` | Tick interval in seconds (5–3600). |
| `HATCHET_API_TOKEN` / `HATCHET_SERVER_URL` | unset | Select the Hatchet workflow adapter (Wave-0-gated; falls back to local with a warning). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Set (+ `OTEL_SDK_DISABLED=false`) to export OTLP-http telemetry. |
| `OTEL_SDK_DISABLED` | `true` | `false` allows SDK construction when an endpoint is set. |
| `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` | unset | Future placeholders (interface boundary only, unused today). |
| `INFISICAL_SITE_URL` / `INFISICAL_PROJECT_ID` / `INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET` | unset | Enable the real `@iptv/secrets` adapter; all four must be present or the Noop port is used. |
| `INFISICAL_ENVIRONMENT` | `development` | Fallback environment; refs carry their own. |
| `PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID` | unset | UUID of the single disposable provider account real trial dispatches may use. |
| `WAHA_BASE_URL` / `WAHA_API_KEY` | unset | Select the WAHA messaging gateway; otherwise `LocalEchoGateway`. |
| `WAHA_SESSION` | `default` | Expected WAHA session name per tenant. |
| `ASAAS_ADAPTER` | `echo` | `real` selects the Asaas port; requires `ASAAS_API_KEY` + `ASAAS_BASE_URL`. |
| `ASAAS_API_KEY` / `ASAAS_BASE_URL` | unset | Asaas credentials/endpoint for the real adapter. |
| `REFUND_APPROVAL_TTL_HOURS` | `168` | Approved-refund decision TTL before it is rejected as stale. |
| `PROVIDER_OPS_ADAPTER` | `manual` | `echo` resolves provider operations deterministically in-process. |
| `PROVIDER_ECHO_OUTCOME` | `success` | `success`/`failed`/`unknown` for the echo ops adapter. |
| `PROVIDER_READBACK_EFFECT` | `NOT_APPLIED` | Stub readback answer for `provider.reconcile`. |
| `PROVIDER_DISPATCH_MODE` | `inline` | `durable` enables the leased provider dispatch drained by the scheduler. **Required with exactly `durable` when `NODE_ENV=production`** — any other value fails `loadConfig` at boot. |
| `PROVIDER_DISPATCH_TIMEOUT_MS` / `PROVIDER_DISPATCH_LEASE_MS` / `PROVIDER_GENERIC_READBACK_TIMEOUT_MS` | built-in defaults | Provider dispatch/readback budgets. |
| `PROVIDER_TRIAL_READBACK_TIMEOUT_MS` / `PROVIDER_TRIAL_READBACK_MIN_FUTURE_MS` | built-in defaults | Trial readback budgets. |
| `SUPPLIER_BALANCE_ADAPTER` | `manual` | `echo` returns a stub supplier balance. |
| `SUPPLIER_BALANCE_ECHO_MINOR` / `SUPPLIER_BALANCE_ECHO_CURRENCY` | `100000` / `BRL` | Stub balance values. |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `AGENT_MODEL` | unset | Agent model gateway; without a key the deterministic Echo gateway is used. |

### Production configuration fail-fast

`loadConfig()` (`@iptv/config`) runs in `main.ts` **before** the optional
observability initialization and before the Nest app is created, so an invalid
production env is a boot failure, never a silently-degraded runtime. With
`NODE_ENV=production` these keys are mandatory:

- `BETTER_AUTH_SECRET` — the dev-only default is rejected.
- `PROVIDER_DISPATCH_MODE` — must be exactly `durable` (no case folding, no
  trimming). Unset, empty (empty means absent), `inline`, typo, `DURABLE` or
  `durable ` all throw `invalid environment configuration: PROVIDER_DISPATCH_MODE
  must be exactly "durable" …`, naming the variable and the value seen. The
  durable dispatcher is the only certified executor for real provider writes, so
  the historical silent `inline` fallback must never reach production.
  Outside production the key is unvalidated and
  `providerDispatchModeFromEnv()` keeps its inline fallback.
- `APP_DATABASE_URL` — must be set, non-blank, free of ASCII control characters,
  and a parseable **PostgreSQL** URI (`pg://`, `postgres://` or `postgresql://`) that
  states its **target explicitly**: a non-empty **host** in the authority and a
  non-empty **database name** in the path (an empty host or path would let the
  driver fall back to ambient `PGHOST`/`PGDATABASE` or a libpq default). Its
  **authority username is exactly `iptv_app`**, with **no `user=`, `role=`,
  `options=` or `host=`/`port=`/`database=`/`db=`/`dbname=` query parameter**
  (case-insensitive). Per the node-postgres
  connection-string reference, `user` is the driver identity override (it
  replaces the authority username at connect time) and `options` is forwarded to
  server startup as command-line options — it could therefore request a role
  change (e.g. `options=-c role=owner`), and whether that request succeeds
  depends on server-side role membership/privileges, which **this guard does not
  verify**. `role` is denied **by policy**: it is not claimed to change identity
  in the current driver, but no production URL needs it and denying it removes a
  whole class of identity-shaped parameters. The `host`/`port`/`database`/`db`/
  `dbname` keys are refused because they would override the target the URI
  already states. Ordinary settings (`sslmode`,
  `application_name`, `connect_timeout`, …) stay legal. There is **no production
  fallback** to `DATABASE_URL` or `TEST_DATABASE_URL`. Blank counts as absent
  (remove a bare `APP_DATABASE_URL=` placeholder); a value with leading/trailing
  whitespace is rejected too, never silently trimmed — it is a credential, and
  repairing it at boot would hide the misconfiguration. Interior spaces are fine.
  Rejected: owner/superuser usernames (`iptv`, `postgres`), case variants
  (`IPTV_APP`), percent-encoded forms (`iptv%5Fapp`), non-PostgreSQL schemes,
  malformed URIs, ASCII control characters anywhere in the value (tab/LF/CR are
  stripped by URL parsing and could smuggle a different connection string) and
  `user`/`role`/`options` overrides.
- URI components are screened individually: the username, the password, the raw
  hostname, query string **and the database path** must carry well-formed percent escapes
  and must not decode to an ASCII control character. `new URL` keeps
  `%00`/`%09` encoded in those components while `URLSearchParams` decodes them
  into **real** control characters, so `application_name=api%00user%00postgres`
  (or a `db%00x` database name) would otherwise reach the driver intact. A
  percent-encoded **space** in a password (`p%20cret`) stays legal, and an
  accepted URL is kept byte-exact.
- A **URI fragment is forbidden**: any literal `#` is refused, including a bare
  trailing `#` whose parsed fragment would be empty. A fragment is not part of
  the PostgreSQL connection contract, so it is rejected rather than parsed or
  silently dropped. An **encoded `%23`** inside a component is not a delimiter
  and stays ordinary encoded data (`p%23cret`, `/iptv%23`) — it is refused only
  if it decodes to an ASCII control character.
- `sslnegotiation`, when present, must be exactly `postgres` or `direct` — it is
  echoed back by the driver/server, so an invalid value is refused here with
  credential-free text instead of downstream.
- TLS settings are validated for ambiguity, not required: **TLS is not mandated
  globally** (that is deployment-specific), only invalid/duplicated/conflicting
  settings are refused. `pg://` is accepted alongside `postgres://` and
  `postgresql://`. The URI must be **URL-encoded per the node-postgres docs**:
  a literal space anywhere is refused (use `%20`) because the installed parser
  **rewrites** a URI that contains one, which could make the driver's view of a
  percent-encoded query key differ from the WHATWG-validated one. Query keys must
  be **canonical lowercase literals** (`SSLMODE=` / `SslMode=` and percent-encoded
  names such as `ssl%6dode=` are refused: the driver consumes lowercase
  parameter names, so a mixed-case or encoded name would be read differently by
  the driver than by this validator). **Values** may remain percent-encoded, and
  forbidden keys stay rejected case-insensitively. A query
  parameter must not be **repeated** (case-insensitively, before parsing —
  `pg-connection-string` assigns parameters onto an object, so a repeat is
  last-value-wins and the effective setting would depend on order).
  `ssl` must be exactly `true|1|0`; **`ssl=false` is refused** because the
  installed pg parser leaves it as a non-empty (truthy) string and so would not
  disable TLS — use `ssl=0` or `sslmode=disable`. `sslmode` must be one of
  `disable|prefer|require|verify-ca|verify-full|no-verify`, plus `allow` only
  with `uselibpqcompat=true` (where `no-verify` is unavailable); **libpq-compat
  `verify-ca` additionally requires a non-blank `sslrootcert` value** — the
  installed pg parser throws without it. `verify-full` is **not** gated this way:
  per the node-postgres documentation it uses `{}` (system CA + identity
  verification), so it stays legal without a custom root certificate. In both
  cases only the **parameter** is checked, never whether a certificate file is
  readable or valid on the server.
  `uselibpqcompat` must be exactly `true|false`; setting `ssl` **and** `sslmode`
  together is refused as ambiguous; and `sslnegotiation=direct` is refused while
  TLS is explicitly disabled (`sslmode=disable`, or `ssl=0`). Error text names
  the allowed set, never the rejected value. Explicit TLS disable (`ssl=0` or
  `sslmode=disable`) also cannot be combined with nonblank `sslcert`, `sslkey` or
  `sslrootcert` parameters: the driver can let certificate options override
  `ssl=0`, while `sslmode=disable` with certificate options remains conflicting
  and may trigger certificate-file handling. The guard rejects both combinations.
- `DATABASE_URL` / `DATABASE_OWNER_URL` / `TEST_DATABASE_URL` /
  `POSTGRES_PASSWORD` — must be **absent** (non-blank is a boot error naming the
  variable), even when `APP_DATABASE_URL` is valid: owner roles bypass RLS, a
  test database is never a production target, and a password has no business in
  the API env. Blank (including whitespace) counts as absent here — the repo
  rule.
- `PGPASSWORD` / `PGOPTIONS` / `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` /
  `PGSSLMODE` / `PGSSLNEGOTIATION` — must be **genuinely unset**: the pg driver
  consumes these directly, so **only an empty string counts as absent** and a
  whitespace-only value is refused like any other supplied setting.
  `PGOPTIONS` feeds driver startup `options` from outside the URI (the same
  unverified role-change vector the URI rule closes) and the target/transport
  variables would derive the connection from outside the validated URI. Keep
  those in the migration/DDL job env only
  (`docs/10-operations/runbooks/rls-role-split-cutover.md`).

Error text names the variable and the rule only — **the connection value and its
credentials are never printed**.

`resolveAppConnectionString()` (`apps/api/src/app.module.ts`) calls the same
two `@iptv/config` helpers (`assertNoPrivilegedDatabaseEnv` +
`validateProductionAppDatabaseUrl`) that `loadConfig` runs, so the `DB` provider
fails closed on exactly the same rules even when it is reached without
`loadConfig` having validated the env. There is no second copy of the rules to
drift. Development/test precedence (`APP_DATABASE_URL` → `DATABASE_URL` →
`TEST_DATABASE_URL` → `null`) is unchanged, and every one of those variables —
plus `POSTGRES_PASSWORD`/`PGPASSWORD` and an owner URL — stays legal there.

> **Scope — configured identity only.** This guard proves what the API process
> is *configured* to connect as. It never queries the server, so it does **not**
> prove the connected role's effective privileges (`SUPERUSER`, membership in an
> owner role, `BYPASSRLS`, `CREATEROLE`), does not enable RLS and does not
> complete any cutover step. No grants, policies, migrations or pool mode
> changed; the app still runs as owner until the per-domain cutover checklist in
> `docs/10-operations/runbooks/rls-role-split-cutover.md` is complete, and
> nothing here is RLS/cutover certification.

### Browser CORS

Browser CORS is an explicit-origin allowlist only (never `*`, never
reflected). The API serves `GET, HEAD, POST, OPTIONS` with no credentialed
CORS (`credentials: false`) and allows `authorization`, `content-type`,
`x-request-id`, `traceparent`, `x-tenant-context-revision`,
`idempotency-key`, and `asaas-access-token` request headers. CORS only
controls browser response visibility — it does not replace Bearer/session
auth, webhook shared-secret checks, or tenant membership/revision guards, and
no allowed header by itself grants tenant access.

## Surface index

One line per real directory under `src/`.

| Dir | Surface |
| --- | --- |
| `agent/` | Copilot/customer-agent runtime under `v1/agent`: ask, execute, context, eval runs, release store, CRM lookup tool. |
| `analytics/` | Metric catalog + projections and math under `v1` (exact minor units / integer basis points, never floats). |
| `audit/` | Append-only writer for `platform.audit_log` (correlation id from the request id). |
| `auth/` | `v1/auth` login/logout/session plus guards (auth context, tenant-context revision, permissions). |
| `billing/` | Charges/refunds, double-entry ledger, settlement, refund reviews, Asaas port + `POST /v1/webhooks/asaas/:tenantKey`. |
| `capabilities/` | `v1/capabilities` catalog of provider/agent capabilities with readiness and autonomy levels. |
| `commands/` | Command bus: idempotency, result codes, audit + event/outbox emission, Kysely persistence. |
| `commerce/` | `v1/orders` catalog/offers/orders with immutable price snapshots and exact money math. |
| `communications/` | `v1/communications` conversations/messages/exceptions over the messaging gateway port, plus the WAHA adapter, risk state and `POST /v1/webhooks/waha/:tenantKey`. |
| `crm/` | `v1/crm` persons and leads (owning context; never creates customers). |
| `experiments/` | Deterministic assignment + store and `v1` reads/writes for experiments. |
| `finance/` | Cost-allocation ingest and `v1` finance reads over the financial ledger. |
| `fulfillment/` | `v1/fulfillment` provider operations for subscriptions (probe/manual/echo) with capability gates. |
| `growth/` | Campaigns, message intents, quiet hours, budget caps and attribution under `v1`. |
| `human-review/` | `v1/human-reviews` HITL lifecycle, claim, decisions and the aggregated center. |
| `inbox/` | Durable inbox: insert-once dedupe + envelope normalization for inbound events. |
| `inventory/` | Supplier app catalog, app trials, license assets and supplier credit/balance operations. |
| `knowledge/` | `v1/knowledge` items, versions, solutions, corrections, gaps, freshness and search. |
| `outbox/` | `v1/admin/outbox` drain of domain events plus the local transport. |
| `partners/` | Partners/reseller core, credit orders, membership and academy under `v1`. |
| `policy/` | `v1/policies` layered policy resolution (platform → tenant → context) for autonomy decisions. |
| `provider/` | `v1/provider` operations/evidence/health, the `ProviderOpsPort`, secret-ref gate and the leased durable dispatcher (`v1/admin/provider-dispatch`). |
| `referral/` | Referral qualification/attribution and the append-only reward ledger under `v1`. |
| `renewal/` | `v1/renewals` cycle renewal plus `v1/recovery-tasks` recovery/dunning. |
| `scheduler/` | Opt-in in-process tick loop (due commands → webhook drains → outbox drain). |
| `subscription/` | `v1/subscriptions` lifecycle, cycles, entitlements and the computed status projection. |
| `support/` | `v1` tickets, incidents and problems with the canonical transition maps. |
| `tenants/` | `v1` tenants list/switch/create and `/v1/me`. |
| `trial/` | `v1/trials` lifecycle, compatibility (`v1/compatibility`) and trial readback. |

Cross-cutting files at the root of `src/`: `main.ts` (bootstrap order:
config → observability → Nest → request-id → observability hook → CORS →
listen → scheduler), `app.module.ts` (controllers/providers, DB and auth
factories), `api-cors.ts`, `request-id.ts`, `observability-hook.ts`,
`health.controller.ts`.

## Surface notes

### Scheduler and worker substrate

- **Scheduler** (`src/scheduler/`): opt-in in-process loop (`SchedulerService`,
  `API_SCHEDULER_ENABLED=1`, tick `API_SCHEDULER_TICK_SECONDS` default 60s).
  Each tick runs the worker-eligible `*_due` commands per tenant found by a
  platform-level due-scan (`trial.expire_due`, `order.expire_due`,
  `charge.expire_due`, `renewal.reminders_due`, `renewal.expire_overdue_due`,
  `subscription.expire_cycles_due`, `fulfillment.retry_due` — commands stay
  tenant-scoped), drains deferred webhook rows
  (`WahaWebhookService.drainPending`, `AsaasWebhookService.drainPending`,
  limit 25 each), then drains the outbox (limit 25) so one tick converges.
  A durable provider dispatch (`PROVIDER_DISPATCH_MODE=durable`) also runs
  recovery/due/reconcile passes in the same tick. Per-task try/catch with
  structured error logs: one failing task never kills the loop, and an
  overlapping tick is skipped while the previous one is in flight.
  `OnModuleDestroy` clears the interval (graceful shutdown; scheduler
  failure never touches the API critical path). `GET /v1/health` reports
  `{scheduler: enabled|disabled, tickSeconds}`.
- **Workflow substrate** (`packages/workflows`, `WORKFLOW` provider):
  `WorkflowPort` with `LocalWorkflowAdapter` default (in-memory, explicitly
  **non-durable**) and `HatchetWorkflowAdapter` (env-gated via
  `HATCHET_API_TOKEN`, optional SDK, Wave-0-gated — never default; missing
  SDK/config falls back to local with a warning).
- **Observability** (`packages/observability`, api-only default): `main.ts`
  calls `loadConfig()` first (production fail-fast) and then
  `initObservability()` inside try/catch; Fastify `onRequest`
  hook extracts/propagates W3C `traceparent` → `request.traceId` +
  `x-trace-id` response header; spans wrap `CommandBus.execute` (command,
  tenant, result code — no payloads/secrets), gateway sends, Asaas calls and
  webhook ingress/processing; in-process counters
  `commands_executed_total{command,code}` + `webhooks_received_total{provider,outcome}`.
  OTLP export only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set with
  `OTEL_SDK_DISABLED=false`. Langfuse is an interface boundary only
  (`NoopLangfuseAdapter`, no dep, no network).

### Billing webhooks (Asaas)

- **Webhook** (`POST /v1/webhooks/asaas/:tenantKey`, public): Asaas sends
  the configured authToken as the `asaas-access-token` header; the legacy
  `X-Asaas-Secret` header remains accepted as a backward-compatible alias,
  with `asaas-access-token` taking precedence when both are present. The
  presented value is checked timing-safe against that channel's secret hash
  in `billing.tenant_channels` only — there is no global fallback. A
  channel without a configured hash rejects with `503` before inbox/domain
  effects. Tenant comes from the `:tenantKey` path segment via
  `billing.tenant_channels`, never from payload content. Same pipeline shape
  as WAHA: durable inbox insert-once dedupe, `202` fast ack, then async
  normalize (`?defer=1` leaves rows `RECEIVED` for
  `AsaasWebhookService.drainPending()`).

### Support, HITL and knowledge

- **Support** (`src/support/`): owning context for Ticket/Incident/Problem.
  `support.ticket.open` (person + optional conversation ref, `NEW`) →
  `support.ticket.assign` (active same-tenant member; first assignment stamps
  `first_response_at`) → `support.ticket.transition` over the explicit
  canonical map (`NEW→TRIAGING→IN_PROGRESS→WAITING_*→RESOLVED→CLOSED`,
  `CANCELLED` terminal, reopen `RESOLVED|CLOSED→IN_PROGRESS`) →
  `support.ticket.add_solution_attempt` (`solution_id` XOR `procedure_key`
  per the 010 shape CHECK, 010 outcome enum) →
  `support.ticket.resolve` (requires a `SUCCEEDED`/`PARTIAL` attempt; with an
  explicit `solutionId` also persists a `solution_outcomes` row) →
  `support.ticket.close` / `support.ticket.reopen`. Incidents
  (`support.incident.open|update_status|resolve` over
  `DETECTED→CONFIRMED→MONITORING→RESOLVED`), problems
  (`support.problem.open`, minimal) and `link_incident`/`link_problem`
  (idempotent, `already` flag). Every entry transition emits its
  registry-listed public v1; assignment/attempts/problem-links stay
  audit-only (known gaps). Reads `GET /v1/tickets[/:id|/my-work]`,
  `/v1/incidents`, `/v1/problems`; detail carries read-only diagnostics
  joins (conversation context, links, attempts, observed outcomes).
- **Knowledge** (`src/knowledge/`): tenant-scoped `knowledge.item.create`
  (`CANDIDATE` + version 1, `solutions` row for `SOLUTION` types) /
  `update` (append-only version insert + pointer move, optimistic
  `expectedVersion`) / `archive` (→ `DEPRECATED`). Reads
  `GET /v1/knowledge/items[/:id]` (type/status/tag), `/v1/knowledge/search`
  (ILIKE over current versions — pg_trgm/FTS deferred) and
  `/v1/knowledge/suggest-for-ticket/:ticketId` (labeled token-overlap
  heuristic, never a verified answer).
- **HITL center** (`src/human-review/`): `GET /v1/human-reviews/center`
  aggregates OPEN work from the existing queues (human reviews, comm
  exceptions, billing exceptions, recovery tasks) into normalized
  `{source, id, kind, summary, ageMinutes, sla, deepLink}` — read-model only,
  no table restructured. `POST /v1/human-reviews/:id/claim` assigns +
  `ACKNOWLEDGE`s (same-user idempotent, stealing rejected). Staleness follows
  the `hitl.sla` policy family (defaults warn ≥4h, breach ≥24h; explicit
  `sla_due_at` breaches on deadline).
  A fifth source, `provider_operation`, surfaces this tenant's
  `provider_operations` parked in exact `status = 'HUMAN_REQUIRED'` (so a
  problem operation reaches the operator without polling). It is admitted by a
  SEPARATE permission, `provider.operation.read` — `support.ticket.read` (the
  route permission) is NOT widened and no role mapping changed: with the
  permission the rows join the unfiltered center and
  `?source=provider_operation` narrows to them; without it, an unfiltered
  request omits provider rows entirely (200) and an explicit
  `?source=provider_operation` is a 403 thrown before any provider read
  (unknown sources remain 400). Rows are minimal — `id`, `action`
  (as `kind`), `requested_at` and a fixed generic summary, with `deepLink`
  pointing at `GET /v1/provider/operations/:id`. No
  `requested_payload_json`/`result_summary_json`, secret ref,
  account/customer identifier, evidence, trace or raw adapter error is ever
  selected or exposed, and the center adds no resolve control for this source.
- Migration `202609262100_021_support_hitl_center.sql` (only the genuinely
  missing pieces: `support_tickets.assignee_user_id` + membership FK and
  `support.ticket.read` / `support.incident.write` / `knowledge.read|write`
  seeds, mirrored in `packages/auth`; `support.ticket.write` predates from
  012).

### Subscriptions and fulfillment

- **Subscriptions** (`src/subscription/`): `subscription.activate_from_order`
  (SETTLED order with a PLAN line → PENDING_ACTIVATION + first PENDING
  cycle + PENDING entitlements; a CONFIRMED payment alone never suffices),
  `subscription.activate` (fulfillment postcondition SUCCEEDED →
  ACTIVE + cycle OPEN + entitlement grants + `provider_evidence`
  `ACTIVATION_POSTCONDITION` + credential notification; idempotent),
  `subscription.cancel_at_period_end` (flag only — access continues through
  the cycle; ENDED only via `subscription.expire_cycles_due` closing past-end
  cycles, never a renewal), `subscription.resume`,
  `subscription.suspend` (gated on the `subscription.suspension` policy
  family, safe default DENY with explicit reason — never a late webhook),
  `subscription.reinstate`. Reads `GET /v1/subscriptions[/:id]` carry the
  computed projection (`RENEWAL_DUE`/`GRACE`/`OVERDUE`, never stored).
  Lifecycle transitions emit nothing: `subscription.*` are known registry
  gaps with no public v1 (audit-only by design).
- **Fulfillment** (`src/fulfillment/`): `fulfillment.request_for_subscription`
  creates a `subscription.provision` operation through the
  `ProviderOpsPort` (echo/manual + `provider.cinevision` capability gate);
  UNKNOWN → VERIFYING → `provider.reconcile`, FAILED → MANUAL_EXECUTION
  HumanReview with the subscription staying PENDING_ACTIVATION. Binding is
  the existing `provider_bindings` row (`entity_type=subscription`), written
  only with a real provider external ref — no new mapping table.
  Resolution/reconcile stay on `POST /v1/provider/operations/:id/...`,
  whose resume hooks continue the subscription flow.
- **Notification**: on ACTIVE, a system-originated INTERNAL/SYSTEM message
  (credential placeholder with fulfillment ref, never a secret) is appended
  with delivery QUEUED behind the manual gateway — a human-visible record,
  no automated outbound.
- Migration `202609261900_019_subscription_cycle_guard.sql` (one OPEN cycle
  per subscription via partial unique index + `subscription.read|write`
  seeds, mirrored in `packages/auth`).

### CRM and communications

- **CRM** (`src/crm/`): `person.register`, `lead.capture` (status `NEW`),
  `lead.transition` (explicit owning-context map over the migration-002
  status set; invalid → `precondition_failed`). Queries:
  `GET /v1/crm/persons[/:id]`, `GET /v1/crm/leads[/:id]`.
  Emits registry-listed `person.created.v1`, `lead.created.v1` only.
- **Communications** (`src/communications/`): `MessagingGatewayPort` with
  `WahaGatewayAdapter` (env `WAHA_BASE_URL`/`WAHA_API_KEY`) and
  `LocalEchoGateway` default (no network, `echo:` ids). Manual human
  commands only — no autonomous/AI sends: `conversation.start_manual`,
  `message.send_manual`, `conversation.assign|release|close`,
  `message.ingest`, `exception.resolve`. Suppression or `DENIED`
  preference → `forbidden`. Gateway unknown effect → delivery `QUEUED` +
  conversation `PAUSED`/`RECONCILE_REQUIRED`, never retried blindly.
- **Webhook** (`POST /v1/webhooks/waha/:tenantKey`, public): tenant from
  `communication.tenant_channels`, timing-safe `X-Waha-Secret` check
  against that channel's secret hash only (no global fallback; a channel
  without a configured hash rejects with `503` before inbox/domain
  effects), inbox insert-once dedupe (`provider=waha`), `202` fast ack, then
  normalize via `WAHANormalizer` → `message.ingest`. `?defer=1` leaves
  rows `RECEIVED` for `WahaWebhookService.drainPending()`. Unknown events →
  202, no domain mutation.
- **Exceptions**: `GET /v1/communications/exceptions` (default `OPEN`) +
  `exception.resolve` (`map` → creates conversation, `discard` needs a
  reason). All audited by the `CommandBus`.

## Seed note

`db/seeds/001_pilot_baseline.sql` keeps the OPEN WhatsApp conversation on
the **Cliente Exemplo** person (not on Lead Exemplo). Ingest matches an
inbound sender via `identity.identities` → most recent open conversation,
so seeded traffic for `seed-whatsapp-customer-001` lands there; anything
unmatched lands in the exception queue. Apply seeds only after all 46
migrations; see `db/seeds/README.md`.
