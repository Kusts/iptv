# @iptv/observability — OpenTelemetry traces/logs/metrics (env-gated)

OpenTelemetry traces/logs/metrics with end-to-end correlation, plus the
Langfuse boundary (interface only).

## DECISION: env-gated OTLP, noop default

This package ships the OTLP SDK + exporters
(`@opentelemetry/sdk-trace-node@2.12.0`, `sdk-metrics@2.12.0`,
`sdk-logs@0.223.0`, OTLP/HTTP exporters `@0.223.0`, `api@1.9.1`) as
**installed dependencies**, but providers are constructed **only** inside
`initObservability()` when `OTEL_EXPORTER_OTLP_ENDPOINT` is set **and**
`OTEL_SDK_DISABLED=false`. With no endpoint configured the API stays on its
global no-op tracer: `withSpan` runs the wrapped function directly with
effectively zero overhead and **zero network calls**, counters stay
in-process only, and `emitLog` writes stdout JSON without exporting. Missing
config never breaks boot — the bootstrap catches and keeps the noop path
with a logged warning. `shutdownObservability()` flushes exporters and
returns to the noop path (used by the proof script and tests).

Proven end-to-end (`scripts/otlp-proof.mjs` against a local stub receiver):
1 trace (821 B) + metric export (3 reqs, 3585 B) + 1 log (845 B) — see
`docs/16-pilot-closure/P6-OBSERVABILITY.md`. The same proof runs automated in
the package suite (`pnpm --filter @iptv/observability test` →
`test/otlp-proof.test.ts`, loopback stub, all three signals required).

## Correlation

- HTTP boundary (`apps/api` Fastify `onRequest` hook): extracts W3C
  `traceparent` → `trace_id` (generated when absent/invalid), mirrors
  `x-trace-id` on the response, and propagates the id into the request
  context so logs include `trace_id` + Fastify `request.id`.
- `withSpan(name, attrs, fn)`: span-per-operation wrapper. Attributes are
  sanitized (`sanitizeAttributes` drops `secret|token|password|payload…`
  keys) — **never** attach payloads, secrets, tokens, message bodies or PII.
- Instrumented: `CommandBus.execute` (attrs: command name, tenant, result
  code), `MessagingGatewayPort.sendText` (gateway name, tenant), Asaas port
  calls (adapter name, operation), webhook ingress `processRow`/`drainPending`
  (provider, tenant).
- Metrics: in-process `commands_executed_total{command,code}` +
  `webhooks_received_total{provider,outcome}` counters (`readCounters()` for
  ops/tests), mirrored to OTLP counters when an endpoint is configured.
- Logs: `emitLog(level, msg, attrs)` — one sanitized JSON line to stdout
  always, plus an OTLP log record when enabled (same attribute denylist:
  never payloads, secrets, tokens, bodies or PII).

## Langfuse

`LangfusePort` + `NoopLangfuseAdapter` only — boundary documented, **no
dependency, no network**. Real tracing of agent runs lands after Wave-0
certification and is never constructed by default.

Env: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SDK_DISABLED` (default `"true"`),
`OTEL_METRIC_EXPORT_INTERVAL_MS` (default `60000`, min `1000`),
`LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` (future placeholders, commented
in `.env.example`).
