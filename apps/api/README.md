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
