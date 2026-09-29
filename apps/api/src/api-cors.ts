import type { NestFastifyApplication } from "@nestjs/platform-fastify";

/**
 * Shared CORS configurator for the API (used by both `main.ts` and tests).
 *
 * Explicit allowlist only: no `origin: true`, no `*`, no reflected arbitrary
 * origins, no credentials. CORS governs browser response visibility only —
 * AuthGuard revision/membership checks are unchanged.
 */

/** HTTP methods served by the current API surface. */
export const CORS_ALLOWED_METHODS = ["GET", "HEAD", "POST", "OPTIONS"] as const;

/**
 * Request headers the browser pilot sends: auth bearer, JSON bodies,
 * request-id correlation, W3C trace context, the tenant-context revision
 * precondition, idempotency keys on retryable writes, and the canonical
 * Asaas webhook auth header for browser-based provider tooling.
 */
export const CORS_ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "x-request-id",
  "traceparent",
  "x-tenant-context-revision",
  "idempotency-key",
  "asaas-access-token",
] as const;

export interface ApiCorsOptions {
  origin: string[];
  credentials: boolean;
  methods: string[];
  allowedHeaders: string[];
}

/** Pure builder so tests can assert the exact options `main.ts` passes. */
export function buildCorsOptions(allowedOrigins: readonly string[]): ApiCorsOptions {
  return {
    // An empty allowlist denies every cross-origin request (production with
    // no configured web origin); never fall back to localhost here.
    origin: [...allowedOrigins],
    credentials: false,
    methods: [...CORS_ALLOWED_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
  };
}

/** Register the explicit-origin CORS policy on the Nest application. */
export function registerApiCors(
  app: NestFastifyApplication,
  allowedOrigins: readonly string[],
): void {
  app.enableCors(buildCorsOptions(allowedOrigins));
}
