import type { FastifyInstance, FastifyRequest } from "fastify";
import { extractSessionToken } from "../auth/auth-context.js";
import { getUploadPreadmitDeps, resolveUploadPreadmitOrigin } from "./upload-preadmit.js";

/**
 * Upload content-type for `POST /v1/communications/attachments`.
 *
 * Fastify's default JSON `bodyLimit` (1 MiB) cannot carry the documented
 * media caps (VIDEO up to 32 MiB, base64-inflated on the wire). Raising the
 * GLOBAL limit would widen the DoS surface of every JSON route, so the
 * upload uses a dedicated vendor media type whose parser carries the higher
 * bound instead — the standard `application/json` limit stays untouched.
 * Plain `application/json` POSTs to the upload route are rejected with 415.
 */
export const ATTACHMENT_UPLOAD_CONTENT_TYPE = "application/vnd.iptv.attachment+json";

/** Wire ceiling for the upload JSON envelope (32 MiB bytes -> ~43 MiB base64 + headroom). */
export const ATTACHMENT_UPLOAD_BODY_LIMIT_BYTES = 48 * 1024 * 1024;

/**
 * Exact route path the vendor upload media type is accepted on (query
 * strings are stripped before comparing).
 */
export const ATTACHMENT_UPLOAD_ROUTE_PATH = "/v1/communications/attachments";

/** True only for `POST /v1/communications/attachments` (query strings ignored). */
export function isAttachmentUploadRequest(req: Pick<FastifyRequest, "method" | "url">): boolean {
  if ((req.method ?? "").toUpperCase() !== "POST") {
    return false;
  }
  const path = (req.url ?? "").split("?", 1)[0] ?? "";
  return path === ATTACHMENT_UPLOAD_ROUTE_PATH;
}

/**
 * True when the request declares the vendor upload media type (media-type
 * parameters such as `; charset=utf-8` are ignored, case-insensitively).
 */
export function isAttachmentUploadContentType(req: Pick<FastifyRequest, "headers">): boolean {
  const raw = req.headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") {
    return false;
  }
  return value.split(";", 1)[0]?.trim().toLowerCase() === ATTACHMENT_UPLOAD_CONTENT_TYPE;
}

export function registerAttachmentUploadParser(instance: FastifyInstance): void {
  // FIX-WAHA-PARSER-20261020 + FIX-WAHA-PREADMIT-20261020: the 48 MiB
  // ceiling must never engage off-route or for inadmissible callers.
  // Fastify parses the body BEFORE Nest guards (auth/rate-limit) run, so a
  // root-scoped 48 MiB parser buffers up to 48 MiB on EVERY route — including
  // unauthenticated and rate-blocked requests — before any rejection. Gate in
  // `onRequest` (runs before parsing, hence before ANY buffering):
  // - vendor media type anywhere but POST /v1/communications/attachments
  //   → 415 (the 48 MiB ceiling never applies off-route; the standard 1 MiB
  //   JSON limit stays untouched everywhere else);
  // - vendor media type on the upload route with no session token at all
  //   → 401, mirroring AuthGuard's missing-token rejection, before buffering;
  // - vendor media type on-route with a PRESENT-but-invalid token → 401,
  //   via the SAME `auth.resolveSession` AuthGuard uses, before buffering;
  // - vendor media type on-route with a valid token but an exhausted origin
  //   budget → 429 + Retry-After, via the SAME policy/origin derivation
  //   (incl. trusted-proxy) RateLimitGuard charges — read-only `peek`, so
  //   the single budget charge still happens exactly once post-parse and
  //   invalid tokens never consume budget (session is checked first,
  //   mirroring the `AuthGuard → RateLimitGuard` guard order).
  // Fail-open parity: a throwing session lookup or limiter admits the
  // request and lets the post-parse guards decide (same 5xx/429 semantics
  // as without the gate); `auth === null` (DB unconfigured) likewise admits
  // and AuthGuard 503s post-parse. Tenant-context revision and permissions
  // stay post-parse by design (they need the resolved tenant).
  instance.addHook("onRequest", async (req, reply) => {
    if (!isAttachmentUploadContentType(req)) {
      return;
    }
    if (!isAttachmentUploadRequest(req)) {
      await reply.code(415).send({
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "attachment upload media type is only accepted on POST /v1/communications/attachments",
      });
      return;
    }
    const token = extractSessionToken(req);
    if (token === null) {
      await reply.code(401).send({ code: "UNAUTHENTICATED", message: "missing session token" });
      return;
    }
    const deps = getUploadPreadmitDeps();
    if (deps?.auth !== null && deps?.auth !== undefined) {
      let session: unknown = null;
      try {
        session = await deps.auth.resolveSession({ token });
      } catch {
        // Fail-open: transient lookup failure admits; AuthGuard decides post-parse.
        return;
      }
      if (session === null) {
        await reply.code(401).send({ code: "UNAUTHENTICATED", message: "session is invalid or expired" });
        return;
      }
    }
    if (deps?.rateLimit !== null && deps?.rateLimit !== undefined) {
      let decision: { allowed: boolean; retryAfterSeconds: number };
      try {
        decision = resolveUploadPreadmitOrigin(deps.rateLimit, req);
      } catch {
        // Fail-open, mirroring RateLimitGuard: a limiter bug must not become a denial.
        return;
      }
      if (!decision.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterSeconds));
        await reply.header("Retry-After", String(retryAfterSeconds)).code(429).send({
          code: "RATE_LIMITED",
          message: "too many attempts; please retry later",
        });
        return;
      }
    }
  });

  instance.addContentTypeParser(
    ATTACHMENT_UPLOAD_CONTENT_TYPE,
    { parseAs: "string", bodyLimit: ATTACHMENT_UPLOAD_BODY_LIMIT_BYTES },
    (req, body, done) => {
      // Defense in depth: unreachable while the onRequest gate above stands
      // (it rejects off-route vendor requests before parsing), but keeps
      // the 48 MiB ceiling route-scoped even if hook ordering ever changes.
      if (!isAttachmentUploadRequest(req)) {
        const err = new Error(
          "attachment upload media type is only accepted on POST /v1/communications/attachments",
        ) as Error & { statusCode?: number };
        err.statusCode = 415;
        done(err);
        return;
      }
      try {
        done(null, JSON.parse(body as string) as unknown);
      } catch {
        const err = new Error("invalid attachment upload JSON") as Error & { statusCode?: number };
        err.statusCode = 400;
        done(err);
      }
    },
  );
}
