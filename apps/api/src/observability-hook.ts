import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { extractTraceId } from "@iptv/observability";
import "./auth/auth-context.js";

/** Structural view: the hook instance may resolve a different `fastify`
 * copy than the augmented top-level `FastifyRequest` (see auth-context). */
interface CorrelatedRequest {
  traceId?: string;
}

/**
 * W1-12 HTTP correlation boundary. Extracts (or generates) the W3C
 * `traceparent` trace id on every request, stores it as `request.traceId`
 * so logs include `trace_id` alongside Fastify `request.id`, and mirrors it
 * on the response as `x-trace-id`. Never throws — correlation must not
 * break the request path.
 */
export function registerObservabilityHook(app: NestFastifyApplication): void {
  const instance = app.getHttpAdapter().getInstance();
  instance.addHook("onRequest", (req, reply, done) => {
    try {
      const header = req.headers["traceparent"];
      const traceId = extractTraceId(Array.isArray(header) ? header[0] : header);
      ((req as unknown) as CorrelatedRequest).traceId = traceId;
      reply.header("x-trace-id", traceId);
    } catch {
      // Correlation is advisory; the request always proceeds.
    }
    done();
  });
}
