# @iptv/workflows — W1-08 worker substrate

`WorkflowPort` (`enqueue` / `registerHandler` / `tick`) with two substrates:

- **`LocalWorkflowAdapter` (default)** — in-process handlers + due-task scan
  on `tick()`. Tasks live **in memory only**: a restart drops every queued
  task. This is explicitly **NOT durable** and makes **no** durable-workflow
  claim. Failure isolation: one throwing handler counts as failed and never
  stops the rest of the tick.
- **`HatchetWorkflowAdapter` (Wave-0-gated, never default)** — F12 vertical
  slice over the published SDK `@hatchet-dev/typescript-sdk` (pinned
  `1.37.0`, `optionalDependencies`, dynamic `import()` only). Lifecycle:
  `registerHandler(name, fn, taskOptions?)` → `start()` (connect with
  bounded retry, declare tasks, create + start worker in background) →
  `enqueue()` → `cancel(runId)` → `stop()` (graceful, terminal).
  `durable: true` is returned ONLY after the engine accepts the trigger (a
  run id exists); every other outcome throws fail-closed. `tick()` stays a
  compatibility no-op (the engine drives execution server-side).
- **`createWorkflowAdapter(env, opts?)`** — Hatchet when a client token
  resolves AND the SDK is installed; otherwise local with a logged warning.
  Construction performs no network I/O.

Env (canonical, as read by the SDK `util/config-loader`):

- `HATCHET_CLIENT_TOKEN` (required for Hatchet; absent ⇒ local),
- `HATCHET_CLIENT_HOST_PORT` / `HATCHET_CLIENT_API_URL` (endpoint),
- `HATCHET_CLIENT_NAMESPACE` (optional).

Legacy compat (deprecated, warn-once, canonical wins): `HATCHET_API_TOKEN`
⇒ token, `HATCHET_SERVER_URL` ⇒ API URL. Empty string counts as absent.

Execution policy per handler (`retries`, `executionTimeout`/`scheduleTimeout`
as Go duration strings, `backoffMaxSeconds`) maps onto the SDK task
declaration. Delayed `runAt` is NOT mapped yet: future-dated tasks are
refused fail-closed instead of running early.

Idempotency (at-least-once, never exactly-once): the caller
`idempotencyKey` is propagated as run input `__dedupeKey` (visible to the
handler for effect dedupe) and dedupes in-flight triggers per key within
process lifetime; cross-restart effect dedupe stays with the domain
handler's own idempotency/fencing. Payloads must not define the reserved
keys `__task` / `__dedupeKey`.

Tests (`vitest run`): local semantics + factory fallback
(`workflows.unit.test.ts`); the durable slice against the in-process
`FakeHatchetEngine` — happy path, crash/restart resume without repeating a
recorded side effect, provider-unavailable retry/exhaustion, cancel,
graceful shutdown, env wiring, and a conditional real-SDK wiring proof
(`hatchet-durable.test.ts`). `FakeHatchetEngine` is exported for reuse and
is explicitly test-only (never durable).
