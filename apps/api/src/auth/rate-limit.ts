import { SetMetadata } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";

/** Public auth routes that carry an independent, explicit rate-limit budget. */
export type AuthRateLimitKind = "login" | "register";

export const RATE_LIMIT_POLICY_KEY = "authRateLimitPolicy";

/** Declare the rate-limit policy for a public auth route (method-level). */
export const AuthRateLimit =
  (kind: AuthRateLimitKind): MethodDecorator & ClassDecorator =>
    SetMetadata(RATE_LIMIT_POLICY_KEY, kind);

export interface AuthRateLimitPolicy {
  /**
   * Budget per normalized identity (email). For `login` this budgets FAILURES
   * only and is reset on a successful login; for `register` it budgets attempts
   * per submitted address.
   */
  readonly identityLimit: number;
  readonly identityWindowMs: number;
  /** Budget per client origin (fail-safe IP) — the source-side DoS backstop. */
  readonly originLimit: number;
  readonly originWindowMs: number;
}

/**
 * Shipped defaults. Every value is a deliberate trade-off and the unit tests
 * assert behaviour at these exact numbers so the documented contract cannot
 * drift from the enforced one.
 *
 * login.identityLimit = 5 failed logins / 15 min per email: blocks credential
 * guessing against one account for the window, then recovers via TTL (never a
 * permanent lock-out). login.originLimit = 30 attempts / 15 min per source: a
 * generous backstop that a single human rarely reaches, so shared NAT/office
 * IPs are not falsely blocked while a flooding source still is.
 *
 * register limits new-account creation / signup spam.
 */
export const AUTH_RATE_LIMIT_POLICIES: Readonly<Record<AuthRateLimitKind, AuthRateLimitPolicy>> = {
  login: {
    identityLimit: 5,
    identityWindowMs: 15 * 60_000,
    originLimit: 30,
    originWindowMs: 15 * 60_000,
  },
  register: {
    identityLimit: 10,
    identityWindowMs: 60 * 60_000,
    originLimit: 20,
    originWindowMs: 60 * 60_000,
  },
};

/** Hard upper bound on distinct keys retained in memory (bounded state). */
export const RATE_LIMIT_MAX_ENTRIES = 20_000;

/** Normalize an email for identity keying: trim + lowercase (logins are case-insensitive). */
export function normalizeIdentityEmail(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/** sha256 hex of a key segment so raw emails/IPs are never retained in memory. */
function hashSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Bucket key for a per-identity (email) limit. */
export function identityBucketKey(kind: AuthRateLimitKind, normalizedEmail: string): string {
  return `auth:${kind}:id:${hashSegment(normalizedEmail)}`;
}

/** Bucket key for a per-origin limit. */
export function originBucketKey(kind: AuthRateLimitKind, originKeySegment: string): string {
  return `auth:${kind}:ip:${originKeySegment}`;
}

/** A resolved, fail-safe client origin (never taken from a client header by default). */
export interface ClientOrigin {
  /** Stable, already-hashed key segment for the origin bucket. */
  readonly keySegment: string;
  /** How the origin was resolved (diagnostics only; never a secret). */
  readonly source: "socket" | "trusted-proxy" | "unknown";
}

const FORWARDED_FOR_HEADER = "x-forwarded-for";
const UNKNOWN_ORIGIN = "unknown";

function readForwardedFor(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw) && typeof raw[0] === "string") {
    return raw[0];
  }
  return null;
}

/** Collapse an IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) to its bare IPv4 form. */
function normalizeClientAddress(raw: string): string {
  const addr = raw.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped !== null && mapped[1] !== undefined) {
    return mapped[1];
  }
  return addr;
}

function isIpLike(token: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(token) || token.includes(":");
}

/**
 * Resolve the client origin for rate limiting. Header-skeptical and fail-safe:
 *
 * - With the DEFAULT `trustedProxyHops = 0`, the value is taken ONLY from the
 *   TCP peer (`req.socket.remoteAddress`), which a client cannot forge with a
 *   header. `X-Forwarded-For` is ignored, so a spoofed header cannot move a
 *   caller into a different bucket or evade the limit.
 * - When the operator explicitly configures `trustedProxyHops > 0` (env opt-in),
 *   ONLY that many trusted proxies are stripped from the RIGHT of a single-hop
 *   `X-Forwarded-For` value and the next entry to the left is used as the
 *   client address. This NEVER enables Fastify's global `trustProxy`; it mirrors
 *   the numeric-hop semantics locally for the limiter only.
 * - When no address is attributable, a single shared `unknown` bucket is used so
 *   unattributable traffic is still throttled rather than exempted.
 */
export function deriveClientOrigin(req: FastifyRequest, trustedProxyHops: number): ClientOrigin {
  const socketAddress = req.socket?.remoteAddress;
  const hops = Number.isInteger(trustedProxyHops) && trustedProxyHops > 0 ? trustedProxyHops : 0;

  if (hops > 0) {
    const forwarded = readForwardedFor(req.headers[FORWARDED_FOR_HEADER]);
    if (forwarded !== null) {
      const parts = forwarded
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      const index = parts.length - 1 - hops;
      const candidate = index >= 0 ? parts[index] : undefined;
      if (candidate !== undefined && isIpLike(candidate)) {
        const addr = normalizeClientAddress(candidate);
        return { keySegment: hashSegment(addr), source: "trusted-proxy" };
      }
    }
  }

  if (typeof socketAddress === "string" && socketAddress.length > 0) {
    return { keySegment: hashSegment(normalizeClientAddress(socketAddress)), source: "socket" };
  }

  return { keySegment: hashSegment(UNKNOWN_ORIGIN), source: "unknown" };
}

/**
 * Number of trusted proxies declared in front of the API, read from
 * `AUTH_RATE_LIMIT_TRUSTED_PROXY_HOPS`. Anything that is not a non-negative
 * integer fails safe to 0 (header ignored). This controls ONLY the limiter's
 * own X-Forwarded-For reading; it never toggles Fastify's global `trustProxy`.
 */
export function trustedProxyHopsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["AUTH_RATE_LIMIT_TRUSTED_PROXY_HOPS"];
  if (raw === undefined || raw.trim() === "") {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}
