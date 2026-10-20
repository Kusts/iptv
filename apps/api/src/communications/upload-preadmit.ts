import { Inject, Injectable } from "@nestjs/common";
import type { AuthInstance } from "@iptv/auth";
import type { FastifyRequest } from "fastify";
import { RateLimitService } from "../auth/rate-limit.service.js";

/**
 * Pre-parse admission deps for the upload gate
 * (FIX-WAHA-PREADMIT-20261020).
 *
 * The gate reuses the SAME session resolution `AuthGuard` uses
 * (`auth.resolveSession`) and the SAME origin check `RateLimitGuard` charges
 * (`RateLimitService`, same policy/origin-derivation/trusted-proxy), but
 * read-only: session validity is a lookup and the origin check is a `peek`
 * that never charges. Charging still happens exactly once, post-parse, in
 * `RateLimitGuard.acquire` — so invalid tokens never consume budget (the
 * guard order `AuthGuard → RateLimitGuard` is mirrored pre-parse: session
 * first, origin second) and valid requests are never double-charged.
 *
 * Fail-open parity with `RateLimitGuard`: a THROWING limiter (internal bug)
 * admits the request (logged, never swallowed by the service — the gate
 * returns without replying and the post-parse guard decides). A THROWING
 * session lookup also admits: the post-parse `AuthGuard` still fails closed
 * (5xx), so a transient DB blip pre-parse never becomes a novel denial
 * surface. `auth === null` (DB not configured) likewise admits and lets
 * `AuthGuard` 503 post-parse. Only a definitive negative — unknown/expired
 * token, exhausted origin budget — is rejected before buffering.
 */
export interface UploadPreadmitDeps {
  auth: AuthInstance | null;
  rateLimit: RateLimitService | null;
}

let boundDeps: UploadPreadmitDeps | null = null;

/** Late binding for the pre-parse gate (the Fastify adapter is created before Nest DI exists). */
export function bindUploadPreadmitDeps(deps: UploadPreadmitDeps | null): void {
  boundDeps = deps;
}

/** Deps the `onRequest` upload gate observes at request time (tests reset via `bindUploadPreadmitDeps(null)`). */
export function getUploadPreadmitDeps(): UploadPreadmitDeps | null {
  return boundDeps;
}

/**
 * Binds the live `AUTH` + `RateLimitService` singletons into the pre-parse
 * upload gate. Instantiated during `NestFactory.create` (before the Fastify
 * instance is ready), so the already-registered `onRequest` hook observes
 * real deps from the first request — no bootstrap-site changes needed.
 */
@Injectable()
export class UploadPreadmitBinder {
  constructor(
    @Inject("AUTH") auth: AuthInstance | null,
    @Inject(RateLimitService) rateLimit: RateLimitService,
  ) {
    bindUploadPreadmitDeps({ auth, rateLimit });
  }
}

/** Minimal request surface the gate needs (kept structural so unit tests stay DB-free). */
export function resolveUploadPreadmitOrigin(
  rateLimit: RateLimitService,
  req: FastifyRequest,
): { allowed: boolean; retryAfterSeconds: number } {
  // Origin-only kind: the body carries binary metadata, never an email
  // identity — `peek` enforces the same rule as `acquire` (see
  // `isOriginOnlyKind`), so no identity bucket is ever derived here either.
  return rateLimit.peek("communications-attachments-upload", req, undefined);
}
