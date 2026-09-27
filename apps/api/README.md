# @iptv/api — W1-08 worker + W1-12 observability

## What exists (Wave 1 remainder)

- **Scheduler** (`src/scheduler/`): opt-in in-process loop (`SchedulerService`,
  `API_SCHEDULER_ENABLED=1`, tick `API_SCHEDULER_TICK_SECONDS` default 60s).
  Each tick runs the worker-eligible `*_due` commands per tenant found by a
  platform-level due-scan (`trial.expire_due`, `order.expire_due`,
  `charge.expire_due`, `renewal.reminders_due`, `renewal.expire_overdue_due`,
  `subscription.expire_cycles_due` — commands stay tenant-scoped), drains
  deferred webhook rows (`WahaWebhookService.drainPending`,
  `AsaasWebhookService.drainPending`), then drains the outbox (limit 25 each)
  so one tick converges. Per-task try/catch with structured error logs: one
  failing task never kills the loop. `OnModuleDestroy` clears the interval
  (graceful shutdown; scheduler failure never touches the API critical path).
  `GET /v1/health` reports `{scheduler: enabled|disabled, tickSeconds}`.
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

## Ops env flags

| Flag | Default | Effect |
|---|---|---|
| `API_SCHEDULER_ENABLED` | `0` | `1` arms the in-process scheduler loop (non-durable). |
| `API_SCHEDULER_TICK_SECONDS` | `60` | Tick interval in seconds (clamped 5–3600). |
| `HATCHET_API_TOKEN` / `HATCHET_SERVER_URL` | unset | Set to select the Hatchet adapter (Wave-0-gated; needs the optional SDK or falls back to local). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Set (+ `OTEL_SDK_DISABLED=false`) to export OTLP-http telemetry. |
| `OTEL_SDK_DISABLED` | `true` | `false` allows SDK construction when an endpoint is set. |
| `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` | unset | Future placeholders (boundary only, unused today). |

# @iptv/api — Wave 8: Support + HITL center

## What exists (Wave 8)

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
- **HITL center** (`src/human-review/` extensions): `GET
  /v1/human-reviews/center` aggregates OPEN work from the four existing
  queues (human reviews, comm exceptions, billing exceptions, recovery
  tasks) into normalized `{source, id, kind, summary, ageMinutes, sla,
  deepLink}` — read-model only, no table restructured.
  `POST /v1/human-reviews/:id/claim` assigns + `ACKNOWLEDGE`s (same-user
  idempotent, stealing rejected). Staleness follows the `hitl.sla` policy
  family (defaults warn ≥4h, breach ≥24h; explicit `sla_due_at` breaches on
  deadline).
- Migration `202609262100_021_support_hitl_center.sql` (only the genuinely
  missing pieces: `support_tickets.assignee_user_id` + membership FK and
  `support.ticket.read` / `support.incident.write` / `knowledge.read|write`
  seeds, mirrored in `packages/auth`; `support.ticket.write` predates from
  012).

# @iptv/api — Wave 6: Subscriptions + Fulfillment

## What exists (Wave 6)

- **Subscriptions** (`src/subscription/`): `subscription.activate_from_order`
  (SETTLED order with a PLAN line → PENDING_ACTIVATION + first PENDING
  cycle + PENDING entitlements; a CONFIRMED payment alone never suffices),
  `subscription.activate` (fulfillment postcondition SUCCEEDED →
  ACTIVE + cycle OPEN + entitlement grants + `provider_evidence`
  `ACTIVATION_POSTCONDITION` + credential notification; idempotent),
  `subscription.cancel_at_period_end` (flag only — access continues through
  the cycle; ENDED only via `subscription.expire_cycles_due` closing past-end
  cycles, never a renewal — Wave 9), `subscription.resume`,
  `subscription.suspend` (gated on the `subscription.suspension` policy
  family, safe default DENY with explicit reason — never a late webhook),
  `subscription.reinstate`. Reads `GET /v1/subscriptions[/:id]` carry the
  computed projection (`RENEWAL_DUE`/`GRACE`/`OVERDUE`, never stored).
  Lifecycle transitions emit nothing: `subscription.*` are known registry
  gaps with no public v1 (audit-only by design).
- **Fulfillment** (`src/fulfillment/`): `fulfillment.request_for_subscription`
  creates a `subscription.provision` operation through the Wave 4
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

# @iptv/api — Wave 2: CRM + Communications

## What exists

- **CRM** (`src/crm/`): `person.register`, `lead.capture` (status `NEW`),
  `lead.transition` (explicit owning-context map over the migration-002
  status set; invalid → `precondition_failed`). Queries:
  `GET /v1/crm/persons[/:id]`, `GET /v1/crm/leads[/:id]`.
  Emits registry-listed `person.created.v1`, `lead.created.v1` only.
  **Never creates `crm.customers`** (Wave 5).
- **Communications** (`src/communications/`): `MessagingGatewayPort` with
  `WahaGatewayAdapter` (env `WAHA_BASE_URL`/`WAHA_API_KEY`) and
  `LocalEchoGateway` default (no network, `echo:` ids). Manual human
  commands only — no autonomous/AI sends: `conversation.start_manual`,
  `message.send_manual`, `conversation.assign|release|close`,
  `message.ingest`, `exception.resolve`. Suppression or `DENIED`
  preference → `forbidden`. Gateway unknown effect → delivery `QUEUED` +
  conversation `PAUSED`/`RECONCILE_REQUIRED`, never retried blindly.
- **Webhook** (`POST /v1/webhooks/waha/:tenantKey`, public): tenant from
  `communication.tenant_channels`, timing-safe `X-Waha-Secret` check,
  inbox insert-once dedupe (`provider=waha`), `202` fast ack, then
  normalize via `WAHANormalizer` → `message.ingest`. `?defer=1` leaves
  rows `RECEIVED` for `WahaWebhookService.drainPending()` (future
  Hatchet worker handoff). Unknown events → 202, no domain mutation.
- **Exceptions**: `GET /v1/communications/exceptions` (default `OPEN`) +
  `exception.resolve` (`map` → creates conversation, `discard` needs a
  reason). All audited by the `CommandBus`.

## Run

```powershell
$env:TEST_DATABASE_URL="postgresql://postgres:<pw>@127.0.0.1:5450/<db>"
pnpm typecheck; pnpm lint; pnpm test; pnpm build
```

Without `TEST_DATABASE_URL`, integration files skip and unit tests
(memory store, no network) still run. Never point tests at a shared
database with real data: integration files share one `TEST_DATABASE_URL`
and run sequentially (`maxWorkers: 1` in `vitest.config.ts`).

## Seed note

`db/seeds/001_pilot_baseline.sql` keeps the OPEN WhatsApp conversation on
the **Cliente Exemplo** person (not on Lead Exemplo). Ingest matches an
inbound sender via `identity.identities` → most recent open conversation,
so seeded traffic for `seed-whatsapp-customer-001` lands there; anything
unmatched lands in the exception queue.
