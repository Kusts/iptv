# @iptv/workflows — W1-08 worker substrate

`WorkflowPort` (`enqueue` / `registerHandler` / `tick`) with two substrates:

- **`LocalWorkflowAdapter` (default)** — in-process handlers + due-task scan
  on `tick()`. Tasks live **in memory only**: a restart drops every queued
  task. This is explicitly **NOT durable** and makes **no** durable-workflow
  claim. Failure isolation: one throwing handler counts as failed and never
  stops the rest of the tick.
- **`HatchetWorkflowAdapter` (Wave-0-gated, never default)** — constructed
  only when `HATCHET_API_TOKEN` is set; SDK presence is checked with
  `require.resolve` (no load, no network), and the constructor throws when
  config or SDK is absent so `createWorkflowAdapter` falls back to local with
  a logged warning. `tick()` is a compatibility no-op (Hatchet would drive
  execution server-side). **`enqueue()` fails closed**: it throws instead of
  ever returning `{ durable: true }`, because this adapter creates no
  scheduled run and persists nothing — asserting durability would be a false
  guarantee, and reporting `durable: false` would silently drop the task
  (there is no in-memory queue behind this substrate). A real durable path
  requires the SDK workflow-name mapping certified at W0-04.
- **`createWorkflowAdapter(env)`** — Hatchet when configured, otherwise
  local; any Hatchet construction failure falls back to local with a logged
  warning.

Env: `HATCHET_API_TOKEN`, `HATCHET_SERVER_URL` (both optional; see
`packages/config` and the repo `.env.example`).
