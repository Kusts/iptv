# @iptv/observability — W1-12 telemetry skeleton

OpenTelemetry traces/logs/metrics with end-to-end correlation, plus the
Langfuse boundary (interface only).

## DECISION: api-only default, SDK optional

This package depends **only on `@opentelemetry/api` (pinned `1.9.1`)**.
With no OTLP endpoint configured the API stays on its global no-op
tracer: `withSpan` runs the wrapped function directly with effectively
zero overhead and **zero network calls**. The full SDK
(`@opentelemetry/sdk-trace-node` + `@opentelemetry/exporter-trace-otlp-http`
+ metrics reader) is loaded via dynamic `import()` **only** inside
`initObservability()` when `OTEL_EXPORTER_OTLP_ENDPOINT` is set **and**
`OTEL_SDK_DISABLED=false`. Those packages are therefore optional at
runtime: missing deps/config never break boot — the bootstrap catches and
keeps the noop path with a logged warning.

**Upgrade path:** `pnpm add` the SDK + OTLP exporter packages, then fill in
`configureOtlp()` (NodeTracerProvider + OTLPTraceExporter + registration,
plus a PeriodicExportingMetricReader when an OTLP metrics endpoint is set —
otherwise metrics stay in-process only). No call site changes: every
consumer uses `withSpan` / `recordCommandExecuted` / `recordWebhookReceived`.

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
  ops/tests); OTLP metric export only when an endpoint is configured.

## Langfuse

`LangfusePort` + `NoopLangfuseAdapter` only — boundary documented, **no
dependency, no network**. Real tracing of agent runs lands after Wave-0
certification and is never constructed by default.

Env: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SDK_DISABLED` (default `"true"`),
`LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` (future placeholders, commented
in `.env.example`).
