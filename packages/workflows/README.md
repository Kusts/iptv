# @iptv/workflows — W1-08 worker substrate

`WorkflowPort` (`enqueue` / `registerHandler` / `tick`) with two substrates:

- **`LocalWorkflowAdapter` (default)** — in-process handlers + due-task scan
  on `tick()`. Tasks live **in memory only**: a restart drops every queued
  task. This is explicitly **NOT durable** and makes **no** durable-workflow
  claim. Failure isolation: one throwing handler counts as failed and never
  stops the rest of the tick.
- **`HatchetWorkflowAdapter` (Wave-0-gated, never default)** — constructed
  only when `HATCHET_API_TOKEN` is set; the `@hatchet-dev/hatchet` SDK is an
  **optional** dependency loaded via dynamic `import()` behind env, so a
  missing package/config can never break boot or build. `tick()` is a
  compatibility no-op (Hatchet drives execution server-side). Concrete
  workflow-name mapping is pinned at W0-04 certification.
- **`createWorkflowAdapter(env)`** — Hatchet when configured, otherwise
  local; any Hatchet construction failure falls back to local with a logged
  warning.

Env: `HATCHET_API_TOKEN`, `HATCHET_SERVER_URL` (both optional; see
`packages/config` and the repo `.env.example`).
