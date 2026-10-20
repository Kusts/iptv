import { SetMetadata } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";

/** Public auth routes that carry an independent, explicit rate-limit budget. */
export type AuthRateLimitKind = "login" | "register" | "admin-outbox-drain" | "admin-provider-dispatch";

export const RATE_LIMIT_POLICY_KEY = "authRateLimitPolicy";

/**
 * Admin drain kinds are origin-only: any submitted `email` is ignored and
 * only the per-origin budget is charged, so there is deliberately NO global
 * per-identity lock-out on these routes (one origin exhausting its budget
 * never blocks another origin, and no identity bucket is ever created).
 */
export function isOriginOnlyKind(kind: AuthRateLimitKind): boolean {
  return kind === "admin-outbox-drain" || kind === "admin-provider-dispatch";
}

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
 *
 * admin-outbox-drain / admin-provider-dispatch gate authenticated platform-admin
 * POST drains (expensive claim-and-execute work: outbox delivery, provider
 * dispatch drain/recover/reconcile). These routes carry NO email identity —
 * the guard charges ONLY the per-origin bucket — so there is deliberately NO
 * global per-identity lock-out: one origin exhausting its budget never blocks
 * another origin. The per-origin budget (30 attempts / 5 min per source) is a
 * generous operator backstop — a human clicking "drain" never reaches it —
 * while a flooding source is denied with 429 + Retry-After. Both budgets share
 * the same bounded store/saturation semantics as login/register (fail-closed
 * for new keys at cap; see RateLimitStore).
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
  // Authenticated platform-admin drains: origin-only in practice (no email in
  // body), generous operator backstop, no global identity lock-out by design.
  "admin-outbox-drain": {
    identityLimit: 30,
    identityWindowMs: 5 * 60_000,
    originLimit: 30,
    originWindowMs: 5 * 60_000,
  },
  "admin-provider-dispatch": {
    identityLimit: 30,
    identityWindowMs: 5 * 60_000,
    originLimit: 30,
    originWindowMs: 5 * 60_000,
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

/** Strict-ish IPv4 check: four dotted decimal octets, each 0-255. */
function isIpv4(value: string): boolean {
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (octets === null) {
    return false;
  }
  for (let i = 1; i <= 4; i += 1) {
    const octet = octets[i];
    if (octet === undefined || Number(octet) > 255) {
      return false;
    }
  }
  return true;
}

/** Lenient IPv6 check: contains `:` and only hex/`:`/`.` characters (incl. `::` and a v4 tail). */
function isIpv6(value: string): boolean {
  return value.includes(":") && /^[0-9a-fA-F:.]+$/.test(value);
}

/** True when `value` is a syntactically plausible IPv4 or IPv6 literal (no zone/port). */
function isValidIp(value: string): boolean {
  return isIpv4(value) || isIpv6(value);
}

/**
 * Split a raw `X-Forwarded-For` value into trusted candidate addresses: trims,
 * drops empty/extra-comma entries, and DISCARDS anything that is not a valid
 * IPv4/IPv6 literal, so a malformed entry is never propagated into a limit key.
 */
function parseForwardedFor(raw: string | null): string[] {
  if (raw === null) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => isValidIp(part));
}

/**
 * Resolve the client origin for rate limiting. Header-skeptical and fail-safe.
 *
 * DEFAULT (`trustedProxyHops = 0`): the value is taken ONLY from the TCP peer
 * (`req.socket.remoteAddress`), which a client cannot forge with a header, and
 * `X-Forwarded-For` is ignored entirely. A request that reaches the API
 * directly is therefore keyed on its real socket; a spoofed header cannot move
 * a caller into a different bucket or evade the limit.
 *
 * OPT-IN (`trustedProxyHops > 0`) — SEMANTIC CONTRACT: the argument is the
 * number of trusted proxies in front of the API that APPEND their observed
 * peer address to `X-Forwarded-For`. Each appending proxy writes exactly one
 * entry at the RIGHT end; a client/attacker can only PREPEND entries to the
 * left of the whole chain. The API's own socket is the LAST (closest) trusted
 * hop and does NOT appear in the header. Consequently the trusted-appended
 * entries are the RIGHTMOST `hops` of the (validated) list and the real client
 * address is the FIRST of those — index `parts.length - hops`. Everything to
 * the LEFT of that index is attacker-controlled and is never read, so rotating
 * a forged prefix cannot open new origin buckets, and there is no way to pin a
 * victim's address at the trusted index (the last trusted proxy always appends
 * the true peer at the tail). If the list carries FEWER entries than `hops`
 * (`parts.length - hops < 0`), the configured chain and the observed header
 * disagree and NO entry is trustworthy, so the origin fails safe to the socket.
 *
 * This NEVER enables Fastify's global `trustProxy`; it reads the header only
 * for the limiter's own bucketing. The real security guarantee additionally
 * depends on the API being reachable ONLY through the configured trusted chain
 * — a client that can hit the API directly bypasses the proxies (there `hops`
 * should be 0 so the header is ignored).
 *
 * When no address is attributable (no hops, no socket), a single shared
 * `unknown` bucket is used so unattributable traffic is still throttled rather
 * than exempted.
 */
export function deriveClientOrigin(req: FastifyRequest, trustedProxyHops: number): ClientOrigin {
  const socketAddress = req.socket?.remoteAddress;
  const hops = Number.isInteger(trustedProxyHops) && trustedProxyHops > 0 ? trustedProxyHops : 0;

  if (hops > 0) {
    const parts = parseForwardedFor(readForwardedFor(req.headers[FORWARDED_FOR_HEADER]));
    // Real client = first trusted-proxy-appended entry = `parts.length - hops`.
    const index = parts.length - hops;
    const candidate = index >= 0 ? parts[index] : undefined;
    if (candidate !== undefined) {
      return { keySegment: hashSegment(normalizeClientAddress(candidate)), source: "trusted-proxy" };
    }
    // index < 0 (hops > parts.length): no trustworthy entry → fall through to socket.
  }

  if (typeof socketAddress === "string" && socketAddress.length > 0) {
    return { keySegment: hashSegment(normalizeClientAddress(socketAddress)), source: "socket" };
  }

  return { keySegment: hashSegment(UNKNOWN_ORIGIN), source: "unknown" };
}

/**
 * Number of trusted proxies declared IN FRONT OF the API that APPEND to
 * `X-Forwarded-For`, read from `AUTH_RATE_LIMIT_TRUSTED_PROXY_HOPS`. The API's
 * own socket is the last trusted hop and is not counted (it is not in the
 * header). Anything that is not a non-negative integer fails safe to 0
 * (header ignored). This controls ONLY the limiter's own `X-Forwarded-For`
 * reading (see {@link deriveClientOrigin}); it never toggles Fastify's global
 * `trustProxy`.
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
