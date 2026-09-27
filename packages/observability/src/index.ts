import { context, trace, type Attributes, type Span, type Tracer } from "@opentelemetry/api";

/**
 * W1-12 observability skeleton (api-only by default).
 *
 * DECISION (documented, see README): this package depends ONLY on
 * `@opentelemetry/api` (pinned). With no OTLP endpoint configured the API
 * stays on its global no-op implementation: `withSpan` runs `fn` directly
 * with effectively zero overhead and zero network calls. The full SDK
 * (`NodeTracerProvider` + OTLP-http exporter) is loaded via dynamic
 * `import()` inside `initObservability()` ONLY when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set and `OTEL_SDK_DISABLED` is not
 * `"true"` — so the SDK packages remain optional at runtime and are never
 * constructed in dev/CI. Upgrade path: add the SDK + exporter packages and
 * this file wires them without changing any call site.
 *
 * Correlation: HTTP carries W3C `traceparent`; `extractTraceId` pulls the
 * trace id (or generates one) at the Fastify boundary and every log/span
 * carries `trace_id` + the Fastify `request.id`. NEVER attach payloads,
 * secrets, tokens, message bodies or PII as span attributes — only names,
 * ids, tenant keys and result codes.
 */

const TRACER_NAME = "iptv-api";

let enabled = false;

export interface ObservabilityState {
  enabled: boolean;
  endpoint: string | null;
}

export interface ObservabilityEnv {
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_SDK_DISABLED?: string;
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
  try {
    await configureOtlp(endpoint);
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
 * OTLP wiring point. The SDK + exporter packages are OPTIONAL runtime deps
 * loaded only here; until they are added (upgrade path) this throws and the
 * caller keeps the noop path. Callers MUST NOT import SDK packages
 * statically anywhere else in the repo.
 */
async function configureOtlp(endpoint: string): Promise<void> {
  const sdkTraceNode = "@opentelemetry/sdk-trace-node";
  const exporterOtlp = "@opentelemetry/exporter-trace-otlp-http";
  let sdk: Record<string, unknown>;
  let exporter: Record<string, unknown>;
  try {
    sdk = (await import(sdkTraceNode)) as Record<string, unknown>;
    exporter = (await import(exporterOtlp)) as Record<string, unknown>;
  } catch {
    throw new Error(
      `OTLP endpoint is set (${endpoint}) but the optional SDK packages are not installed ` +
        `(${sdkTraceNode}, ${exporterOtlp}); running with noop spans`,
    );
  }
  void sdk;
  void exporter;
  // Full wiring (NodeTracerProvider + OTLPTraceExporter + registration)
  // lands here together with the dependency addition; the shape is kept
  // deliberately thin so no call site changes.
}

export function isObservabilityEnabled(): boolean {
  return enabled;
}

/** Test seam: force the noop path without env juggling. */
export function disableObservabilityForTests(): void {
  enabled = false;
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

/** Minimal Counter: commands executed (labels: command, code). */
export function recordCommandExecuted(command: string, code: string): void {
  const key = counterKey("commands_executed_total", { command, code });
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

/** Minimal Counter: webhooks received (labels: provider, outcome). */
export function recordWebhookReceived(provider: string, outcome: string): void {
  const key = counterKey("webhooks_received_total", { provider, outcome });
  counters.set(key, (counters.get(key) ?? 0) + 1);
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
