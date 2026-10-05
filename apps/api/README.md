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
integration files apply the 46 migrations themselves via `applyMigrations` in
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
| `DATABASE_URL` | unset | Owner/RLS-bypass connection; used for migrations/DDL. |
| `APP_DATABASE_URL` | unset | Preferred application pool connection (RLS app role); falls back to `DATABASE_URL`, then `TEST_DATABASE_URL`. |
| `TEST_DATABASE_URL` | unset | Disposable DB for integration tests only. |
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

`loadConfig()` (`@iptv/config`) runs in `main.ts` before the Nest app is created,
so an invalid production env is a boot failure, never a silently-degraded
runtime. With `NODE_ENV=production` two keys are mandatory:

- `BETTER_AUTH_SECRET` — the dev-only default is rejected.
- `PROVIDER_DISPATCH_MODE` — must be exactly `durable` (no case folding, no
  trimming). Unset, empty (empty means absent), `inline`, typo, `DURABLE` or
  `durable ` all throw `invalid environment configuration: PROVIDER_DISPATCH_MODE
  must be exactly "durable" …`, naming the variable and the value seen. The
  durable dispatcher is the only certified executor for real provider writes, so
  the historical silent `inline` fallback must never reach production.
  Outside production the key is unvalidated and
  `providerDispatchModeFromEnv()` keeps its inline fallback.

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
observability → config → Nest → request-id → observability hook → CORS →
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
  calls `initObservability()` first inside try/catch; Fastify `onRequest`
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