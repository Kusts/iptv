import { context, trace, type Attributes, type Counter, type Span, type Tracer } from "@opentelemetry/api";

/**
 * W1-12 observability skeleton (api-only by default).
 *
 * DECISION (documented, see README): this package's OTLP providers
 * (`NodeTracerProvider` + OTLP-http exporters for traces/metrics/logs) are
 * constructed via dynamic `import()` inside `initObservability()` ONLY when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set and `OTEL_SDK_DISABLED` is `"false"`.
 * With no endpoint configured the API stays on its global no-op
 * implementation: `withSpan` runs `fn` directly with effectively zero
 * overhead and zero network calls, counters stay in-process only, and
 * `emitLog` writes stdout JSON without exporting. Missing config never
 * breaks boot — the bootstrap catches and keeps the noop path with a logged
 * warning.
 *
 * Correlation: HTTP carries W3C `traceparent`; `extractTraceId` pulls the
 * trace id (or generates one) at the Fastify boundary and every log/span
 * carries `trace_id` + the Fastify `request.id`. NEVER attach payloads,
 * secrets, tokens, message bodies or PII as span attributes — only names,
 * ids, tenant keys and result codes.
 */

const TRACER_NAME = "iptv-api";

let enabled = false;

/** OTLP counter handles, populated only by `configureOtlp`. */
const otlpCounters = new Map<string, Counter>();

/** Minimal structural type for the OTLP logger (avoids a static sdk-logs import). */
interface OtlpLogger {
  emit(record: {
    body: string;
    severityText?: string;
    attributes?: Record<string, string | number | boolean>;
  }): void;
}

let otlpLogger: OtlpLogger | null = null;
let otlpShutdown: (() => Promise<void>) | null = null;

export interface ObservabilityState {
  enabled: boolean;
  endpoint: string | null;
}

export interface ObservabilityEnv {
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_SDK_DISABLED?: string;
  OTEL_METRIC_EXPORT_INTERVAL_MS?: string;
}

function tracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Fail-safe bootstrap. Call FIRST in `main.ts` inside try/catch (a throw
 * here must never break boot). Returns the effective state; when disabled
 * every helper below is a zero-overhead pass-through.
 */
export async function initObservability(
  env: NodeJS.ProcessEnv | ObservabilityEnv = process.env,
): Promise<ObservabilityState> {
  const endpoint = env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  const disabled = env["OTEL_SDK_DISABLED"];
  if (typeof endpoint !== "string" || endpoint.length === 0 || disabled !== "false") {
    enabled = false;
    return { enabled: false, endpoint: null };
  }
  const rawInterval = env["OTEL_METRIC_EXPORT_INTERVAL_MS"];
  const parsedInterval = rawInterval !== undefined ? Number(rawInterval) : Number.NaN;
  const metricExportIntervalMs =
    Number.isInteger(parsedInterval) && parsedInterval >= 1000 ? parsedInterval : 60000;
  try {
    await configureOtlp(endpoint, metricExportIntervalMs);
    enabled = true;
    return { enabled: true, endpoint };
  } catch (err) {
    console.warn(
      `[observability] OTLP setup failed, continuing with noop spans: ${err instanceof Error ? err.message : String(err)}`,
    );
    enabled = false;
    return { enabled: false, endpoint: null };
  }
}

/**
 * OTLP wiring. The SDK + exporter packages are installed dependencies, but
 * providers are constructed ONLY here — behind `OTEL_EXPORTER_OTLP_ENDPOINT`
 * + `OTEL_SDK_DISABLED=false`. With no endpoint configured this function is
 * never reached and the process holds zero providers, zero readers and makes
 * zero network calls. Callers MUST NOT import SDK packages statically
 * anywhere else in the repo.
 *
 * Endpoint convention: `OTEL_EXPORTER_OTLP_ENDPOINT` is the collector BASE
 * (e.g. `http://otel-collector:4318`); `/v1/traces`, `/v1/metrics` and
 * `/v1/logs` are appended here. `OTEL_METRIC_EXPORT_INTERVAL_MS` overrides
 * the PeriodicExportingMetricReader interval (default 60000).
 */
async function configureOtlp(endpoint: string, metricExportIntervalMs: number): Promise<void> {
  const base = endpoint.replace(/\/+$/, "");
  const [{ NodeTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }] = await Promise.all([
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
  ]);
  // OTel JS 2.x: span processors are passed to the constructor (`spanProcessors`)
  // — `NodeTracerProvider.addSpanProcessor()` was removed in 2.0 (migration of
  // `@opentelemetry/sdk-trace-node` 1.30.1 → 2.12.0). Register below is unchanged.
  const traceProvider = new NodeTracerProvider({
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${base}/v1/traces` }))],
  });

  const [{ MeterProvider, PeriodicExportingMetricReader }, { OTLPMetricExporter }] = await Promise.all([
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
  ]);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
    exportIntervalMillis: metricExportIntervalMs,
  });
  const meterProvider = new MeterProvider({ readers: [metricReader] });
  const meter = meterProvider.getMeter(TRACER_NAME);
  otlpCounters.set(
    "commands_executed_total",
    meter.createCounter("commands_executed_total", { description: "Domain commands executed" }),
  );
  otlpCounters.set(
    "webhooks_received_total",
    meter.createCounter("webhooks_received_total", { description: "Provider webhooks received" }),
  );

  const [{ LoggerProvider, BatchLogRecordProcessor }, { OTLPLogExporter }] = await Promise.all([
    import("@opentelemetry/sdk-logs"),
    import("@opentelemetry/exporter-logs-otlp-http"),
  ]);
  // OTel JS 2.x generation (sdk-logs 0.57.2 → 0.223.0): log record processors
  // are passed to the constructor (`processors`) —
  // `LoggerProvider.addLogRecordProcessor()` no longer exists in 0.223.0.
  const loggerProvider = new LoggerProvider({
    processors: [
      new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${base}/v1/logs` }) }),
    ],
  });
  otlpLogger = loggerProvider.getLogger(TRACER_NAME);

  traceProvider.register();
  otlpShutdown = async () => {
    // Flush in reverse dependency order; each shutdown is best-effort so a
    // wedged collector never hangs process exit (callers bound it anyway).
    await loggerProvider.shutdown().catch(() => undefined);
    await meterProvider.shutdown().catch(() => undefined);
    await traceProvider.shutdown().catch(() => undefined);
  };
}

export function isObservabilityEnabled(): boolean {
  return enabled;
}

/** Test seam: force the noop path without env juggling. */
export function disableObservabilityForTests(): void {
  enabled = false;
}

/**
 * Flush exporters and drop providers. Best-effort: a wedged collector never
 * rejects this. After shutdown the helpers return to the noop path.
 */
export async function shutdownObservability(): Promise<void> {
  enabled = false;
  otlpCounters.clear();
  otlpLogger = null;
  const shutdown = otlpShutdown;
  otlpShutdown = null;
  if (shutdown !== null) {
    await shutdown();
  }
}

/**
 * Run `fn` inside a named span. Noop path: just runs `fn` (zero-throw —
 * a span failure never fails the wrapped work; status is recorded, never
 * rethrown as telemetry).
 */
export async function withSpan<T>(
  name: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const currentTracer = tracer();
  return currentTracer.startActiveSpan(name, async (span) => {
    try {
      if (attrs !== undefined) {
        span.setAttributes(sanitizeAttributes(attrs));
      }
      const result = await fn(span);
      span.setStatus({ code: 1 });
      return result;
    } catch (err) {
      span.setStatus({
        code: 2,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Drop attribute values that must never become telemetry (defense in depth). */
const FORBIDDEN_ATTR_RE = /secret|token|password|payload|body|text|prompt|message/i;

export function sanitizeAttributes(attrs: Attributes): Attributes {
  const clean: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (FORBIDDEN_ATTR_RE.test(key)) {
      continue;
    }
    if (typeof value === "string" && value.length > 512) {
      clean[key] = value.slice(0, 512);
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Correlation (W3C traceparent at the HTTP boundary)
// ---------------------------------------------------------------------------

const TRACEPARENT_RE = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i;

export function extractTraceId(traceparent: string | undefined): string {
  if (typeof traceparent === "string") {
    const match = TRACEPARENT_RE.exec(traceparent.trim());
    if (match?.[1] !== undefined && match[1] !== "0".repeat(32)) {
      return match[1].toLowerCase();
    }
  }
  return randomHex(16);
}

/** Format a server-side `traceparent` for a known trace id (version 00). */
export function injectTraceparent(traceId: string): string {
  return `00-${traceId}-0000000000000000-01`;
}

function randomHex(bytes: number): string {
  const chars: string[] = [];
  const hex = "0123456789abcdef";
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  for (const byte of values) {
    chars.push(hex[(byte >> 4) & 0xf] as string, hex[byte & 0xf] as string);
  }
  return chars.join("");
}

/** Current span's trace id, or null when tracing is noop/disabled. */
export function currentTraceId(): string | null {
  try {
    const spanContext = trace.getSpan(context.active())?.spanContext();
    if (spanContext !== undefined && spanContext.traceId !== "0".repeat(32)) {
      return spanContext.traceId;
    }
  } catch {
    // Noop path: no active span — correlation falls back to trace_id.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Minimal metrics (in-process counters; OTLP export only when configured)
// ---------------------------------------------------------------------------

const counters = new Map<string, number>();

function counterKey(name: string, labels: Record<string, string>): string {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`);
  return `${name}{${parts.join(",")}}`;
}

/** Mirror an in-process increment into the OTLP counter when one is live. */
function countOtlp(name: string, labels: Record<string, string>): void {
  const counter = otlpCounters.get(name);
  if (counter === undefined) return;
  try {
    counter.add(1, labels);
  } catch {
    // Telemetry never fails the wrapped work.
  }
}

/** Minimal Counter: commands executed (labels: command, code). */
export function recordCommandExecuted(command: string, code: string): void {
  const key = counterKey("commands_executed_total", { command, code });
  counters.set(key, (counters.get(key) ?? 0) + 1);
  countOtlp("commands_executed_total", { command, code });
}

/** Minimal Counter: webhooks received (labels: provider, outcome). */
export function recordWebhookReceived(provider: string, outcome: string): void {
  const key = counterKey("webhooks_received_total", { provider, outcome });
  counters.set(key, (counters.get(key) ?? 0) + 1);
  countOtlp("webhooks_received_total", { provider, outcome });
}

/** Snapshot for tests/ops (no OTLP reader is constructed unless configured). */
export function readCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}

/** Test seam: reset in-process counters. */
export function resetCountersForTests(): void {
  counters.clear();
}

// ---------------------------------------------------------------------------
// Structured logs (stdout always, OTLP only when configured)
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Minimal structured log hook. ALWAYS writes one JSON line to stdout
 * (`{level,msg,trace_id?,...attrs}` — sanitized, never payloads/secrets) and,
 * when OTLP is enabled, also emits an OTLP log record. Zero-throw: logging
 * never fails the calling work.
 */
export function emitLog(level: LogLevel, message: string, attrs: Attributes = {}): void {
  const clean = sanitizeAttributes(attrs);
  const traceId = currentTraceId();
  try {
    process.stdout.write(
      `${JSON.stringify({ level, msg: message, ...(traceId !== null ? { trace_id: traceId } : {}), ...clean })}\n`,
    );
  } catch {
    // Stdout closed/full — drop the line, never throw.
  }
  const logger = otlpLogger;
  if (logger === null) return;
  try {
    const attributes: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(clean)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        attributes[key] = value;
      }
    }
    if (traceId !== null) attributes["trace_id"] = traceId;
    logger.emit({ body: message, severityText: level.toUpperCase(), attributes });
  } catch {
    // OTLP logger failure is telemetry-internal, never caller-visible.
  }
}

// ---------------------------------------------------------------------------
// Langfuse boundary (interface only — no dependency, no network)
// ---------------------------------------------------------------------------

/**
 * Langfuse (AI observability) boundary. Interface only: implementations are
 * provided after Wave-0 certification and NEVER constructed by default.
 * Documented here so agent-run tracing has a stable seam without pulling a
 * dependency or making any network call today.
 */
export interface LangfuseTraceInput {
  traceId: string;
  name: string;
  tenantId: string;
  metadata?: Record<string, unknown>;
}

export interface LangfusePort {
  readonly name: string;
  trace(input: LangfuseTraceInput): Promise<{ id: string }>;
}

/** Default: records nothing, resolves a synthetic id (safe for dev/CI). */
export class NoopLangfuseAdapter implements LangfusePort {
  readonly name = "noop";
  async trace(input: LangfuseTraceInput): Promise<{ id: string }> {
    void input;
    return { id: `noop-${randomHex(4)}` };
  }
}
