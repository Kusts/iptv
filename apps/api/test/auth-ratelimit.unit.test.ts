import { beforeEach, describe, expect, it } from "vitest";
import { ExecutionContext, HttpException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  deriveClientOrigin,
  identityBucketKey,
  normalizeIdentityEmail,
  RATE_LIMIT_MAX_ENTRIES,
  trustedProxyHopsFromEnv,
  RATE_LIMIT_POLICY_KEY,
  type AuthRateLimitKind,
} from "../src/auth/rate-limit.js";
import { RateLimitStore } from "../src/auth/rate-limit.store.js";
import { RateLimitGuard } from "../src/auth/rate-limit.guard.js";
import { RateLimitService } from "../src/auth/rate-limit.service.js";

/** Build a Fastify-shaped request the guard can read without a live server. */
function makeRequest(opts: {
  remoteAddress?: string;
  headers?: Record<string, string | string[]>;
  body?: unknown;
}): FastifyRequest {
  const req = {
    id: "req-test",
    method: "POST",
    url: "/v1/auth/login",
    socket: { remoteAddress: opts.remoteAddress },
    headers: opts.headers ?? {},
    body: opts.body,
  };
  return req as unknown as FastifyRequest;
}

interface FakeReply {
  headersSent: Record<string, string>;
  header(name: string, value: string): void;
}

function makeReply(): FakeReply {
  return {
    headersSent: {},
    header(name: string, value: string) {
      this.headersSent[name] = value;
    },
  };
}

/** Mini ExecutionContext carrying a rate-limit policy as handler metadata. */
function makeContext(
  kind: AuthRateLimitKind,
  req: FastifyRequest,
  reply: FakeReply,
): ExecutionContext {
  const handler: () => void = () => {};
  // Mirror what `@AuthRateLimit(kind)` stores so the real Reflector reads it.
  Reflect.defineMetadata(RATE_LIMIT_POLICY_KEY, kind, handler);
  const cls = class Dummy {};
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => reply as unknown as FastifyReply,
    }),
  } as unknown as ExecutionContext;
}

function loginBody(email: string): unknown {
  return { email, password: "irrelevant-on-guard-path" };
}

const email = "victim@example.com";

describe("RateLimitStore (unit)", () => {
  it("allows exactly `limit` counts in a window, then blocks (fixed window)", () => {
    const now = 1_000_000;
    const store = new RateLimitStore({ maxEntries: 100, now: () => now });
    const window = 60_000;
    // limit 3: three consumes stay under, the fourth is blocked.
    for (let i = 0; i < 3; i += 1) {
      expect(store.peek("k", 3).allowed).toBe(true);
      store.consume("k", window);
    }
    const blocked = store.peek("k", 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("frees a bucket after its TTL elapses (recoverable window)", () => {
    let now = 0;
    const store = new RateLimitStore({ maxEntries: 100, now: () => now });
    const window = 1_000;
    store.consume("k", window);
    store.consume("k", window);
    expect(store.peek("k", 2).allowed).toBe(false);
    now = 1_001; // window expired
    expect(store.peek("k", 2).allowed).toBe(true);
  });

  it("bounds memory to maxEntries and NEVER evicts an active bucket to admit a new key (fail-closed, P1)", () => {
    let now = 0;
    const store = new RateLimitStore({ maxEntries: 3, now: () => now });
    store.consume("a", 5000);
    store.consume("b", 9000);
    store.consume("c", 9000);
    expect(store.size).toBe(3);
    // A brand-new key when full of ACTIVE buckets is REFUSED, not admitted by
    // evicting someone's live counter. The old code evicted the
    // soonest-expiring entry here, which deleted the budget currently blocking
    // an attacker (saturation evasion).
    now = 100;
    expect(store.consume("d", 9000)).toBe(false);
    expect(store.size).toBe(3);
    expect(store.peek("a", 1).allowed).toBe(false); // "a" still counted, not evicted
    expect(store.peek("d", 1).allowed).toBe(true); // "d" was never admitted
    expect(store.saturationDenials).toBe(1);
  });

  it("still admits new keys at cap once expired buckets are pruned (recoverable, no false fail-closed)", () => {
    let now = 0;
    const store = new RateLimitStore({ maxEntries: 2, now: () => now });
    store.consume("a", 500);
    store.consume("b", 9000);
    now = 600; // "a" expired
    expect(store.consume("c", 9000)).toBe(true);
    expect(store.size).toBe(2);
    expect(store.peek("a", 1).allowed).toBe(true); // gone via expiry prune, not eviction
    expect(store.peek("b", 1).allowed).toBe(false); // active counter preserved
    expect(store.saturationDenials).toBe(0);
  });

  it("tryAcquire admits identity+origin jointly: under saturation NEITHER is admitted without the other (P1)", () => {
    const store = new RateLimitStore({ maxEntries: 3, now: () => 0 });
    store.consume("a", 9000);
    store.consume("b", 9000);
    store.consume("c", 9000);
    const denied = store.tryAcquire([
      { key: "id-x", limit: 5, windowMs: 9000 },
      { key: "ip-x", limit: 30, windowMs: 9000 },
    ]);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    // No partial state: neither new key exists and no active counter was touched.
    expect(store.size).toBe(3);
    expect(store.peek("id-x", 5).allowed).toBe(true); // absent, never created
    expect(store.peek("ip-x", 30).allowed).toBe(true); // absent, never created
    expect(store.peek("a", 1).allowed).toBe(false); // pre-existing counter intact
    expect(store.saturationDenials).toBe(1);
  });

  it("tryAcquire with room for exactly the new keys admits both jointly", () => {
    const store = new RateLimitStore({ maxEntries: 3, now: () => 0 });
    store.consume("a", 9000);
    const admitted = store.tryAcquire([
      { key: "id-x", limit: 5, windowMs: 9000 },
      { key: "ip-x", limit: 30, windowMs: 9000 },
    ]);
    expect(admitted.allowed).toBe(true);
    expect(store.size).toBe(3);
    expect(store.peek("id-x", 1).allowed).toBe(false);
    expect(store.peek("ip-x", 1).allowed).toBe(false);
    expect(store.saturationDenials).toBe(0);
  });

  it("tryAcquire denies without charging when ANY budget is exhausted (both-or-neither preserved)", () => {
    const store = new RateLimitStore({ maxEntries: 10, now: () => 0 });
    store.consume("id-x", 9000);
    const denied = store.tryAcquire([
      { key: "id-x", limit: 1, windowMs: 9000 },
      { key: "ip-fresh", limit: 30, windowMs: 9000 },
    ]);
    expect(denied.allowed).toBe(false);
    // The fresh origin was NOT created as a side effect of the denied attempt.
    expect(store.size).toBe(1);
    expect(store.peek("ip-fresh", 30).allowed).toBe(true);
  });

  it("does not count a peek (peek then consume is not double-charged)", () => {
    const store = new RateLimitStore({ maxEntries: 10 });
    expect(store.peek("k", 1).allowed).toBe(true);
    expect(store.size).toBe(0); // peek never creates a bucket
    store.consume("k", 1000);
    expect(store.size).toBe(1);
    expect(store.peek("k", 1).allowed).toBe(false); // one consume already hits limit 1
  });
});

describe("identity + origin derivation (unit)", () => {
  it("normalizes email to trimmed lowercase; rejects non-strings/empties", () => {
    expect(normalizeIdentityEmail("  User@Example.COM ")).toBe("user@example.com");
    expect(normalizeIdentityEmail("")).toBeNull();
    expect(normalizeIdentityEmail("   ")).toBeNull();
    expect(normalizeIdentityEmail(42)).toBeNull();
    expect(normalizeIdentityEmail(undefined)).toBeNull();
  });

  it("hashes identity keys and scopes them per kind", () => {
    const login = identityBucketKey("login", "a@b.com");
    const register = identityBucketKey("register", "a@b.com");
    expect(login.startsWith("auth:login:id:")).toBe(true);
    expect(register.startsWith("auth:register:id:")).toBe(true);
    expect(login).not.toBe(register); // different policy buckets
    expect(login).not.toContain("a@b.com"); // raw email is never retained
  });

  it("uses the socket address and IGNORES X-Forwarded-For when no trusted proxy is configured (default)", () => {
    const req = makeRequest({
      remoteAddress: "203.0.113.9",
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    const origin = deriveClientOrigin(req, 0);
    expect(origin.source).toBe("socket");
    // Same key as the plain socket origin: the forged header is completely ignored.
    const plain = deriveClientOrigin(makeRequest({ remoteAddress: "203.0.113.9" }), 0);
    expect(origin.keySegment).toBe(plain.keySegment);
  });

  // --- P1 regression suite: `parts.length - hops` selects the trusted tail's
  // first entry (the real client), never the attacker-controlled prefix. ---

  it("proxy that APPENDS: real client is the last entry, not the forged prefix (regression)", () => {
    // Attacker sends `198.51.100.7`; the 1 trusted proxy (the API's socket)
    // appends the real client -> header `198.51.100.7, 203.0.113.9`, hops = 1.
    const req = makeRequest({
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.9" },
    });
    const origin = deriveClientOrigin(req, 1);
    expect(origin.source).toBe("trusted-proxy");
    // Old buggy `length - 1 - hops` picked index 0 = 198.51.100.7 (attacker).
    const realClient = deriveClientOrigin(makeRequest({ remoteAddress: "203.0.113.9" }), 0);
    expect(origin.keySegment).toBe(realClient.keySegment);
    expect(origin.keySegment).not.toBe(
      deriveClientOrigin(makeRequest({ remoteAddress: "198.51.100.7" }), 0).keySegment,
    );
  });

  it("proxy that OVERWRITES: single-entry header with hops=1 uses that client (no proxy collapse)", () => {
    const req = makeRequest({
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    const origin = deriveClientOrigin(req, 1);
    expect(origin.source).toBe("trusted-proxy");
    const realClient = deriveClientOrigin(makeRequest({ remoteAddress: "203.0.113.9" }), 0);
    expect(origin.keySegment).toBe(realClient.keySegment);
  });

  it("hops > parts.length fails safe to the socket (no out-of-range / NaN key)", () => {
    const req = makeRequest({
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    const origin = deriveClientOrigin(req, 3);
    expect(origin.source).toBe("socket");
    const socket = deriveClientOrigin(makeRequest({ remoteAddress: "10.0.0.1" }), 0);
    expect(origin.keySegment).toBe(socket.keySegment);
    expect(origin.keySegment).not.toContain("undefined");
    expect(origin.keySegment).not.toContain("NaN");
  });

  it("discards malformed header entries and keeps the trusted tail (valid IPv4 + IPv6)", () => {
    // `not-an-ip` is filtered; a valid IPv6 stays but sits LEFT of the tail;
    // the trusted index still resolves to the real client 203.0.113.9.
    const req = makeRequest({
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "not-an-ip, 2001:db8::1, 203.0.113.9" },
    });
    const origin = deriveClientOrigin(req, 1);
    expect(origin.source).toBe("trusted-proxy");
    const realClient = deriveClientOrigin(makeRequest({ remoteAddress: "203.0.113.9" }), 0);
    expect(origin.keySegment).toBe(realClient.keySegment);
  });

  it("an all-malformed header falls safe to the socket", () => {
    const req = makeRequest({
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "not-an-ip, <script>, ,," },
    });
    const origin = deriveClientOrigin(req, 1);
    expect(origin.source).toBe("socket");
    const socket = deriveClientOrigin(makeRequest({ remoteAddress: "10.0.0.1" }), 0);
    expect(origin.keySegment).toBe(socket.keySegment);
  });

  it("the forged prefix does NOT move the origin: different prefixes, same trusted tail → same bucket (P1)", () => {
    const tail = "203.0.113.9"; // real client appended by the trusted proxy
    const withPrefix1 = deriveClientOrigin(
      makeRequest({ remoteAddress: "10.0.0.1", headers: { "x-forwarded-for": `198.51.100.7, ${tail}` } }),
      1,
    );
    const withPrefix2 = deriveClientOrigin(
      makeRequest({ remoteAddress: "10.0.0.1", headers: { "x-forwarded-for": `1.1.1.1, 2.2.2.2, ${tail}` } }),
      1,
    );
    const tailDirect = deriveClientOrigin(makeRequest({ remoteAddress: tail }), 0);
    // Both forged prefixes collapse onto the same trusted-tail origin.
    expect(withPrefix1.keySegment).toBe(tailDirect.keySegment);
    expect(withPrefix2.keySegment).toBe(tailDirect.keySegment);
  });

  it("falls back to a single shared 'unknown' bucket when no address is attributable", () => {
    const a = deriveClientOrigin(makeRequest({}), 0);
    const b = deriveClientOrigin(makeRequest({}), 0);
    expect(a.source).toBe("unknown");
    expect(a.keySegment).toBe(b.keySegment); // still throttled, not exempt
  });

  it("collapses IPv4-mapped IPv6 to bare IPv4 so both encodings share a bucket", () => {
    const mapped = deriveClientOrigin(makeRequest({ remoteAddress: "::ffff:127.0.0.1" }), 0);
    const v4 = deriveClientOrigin(makeRequest({ remoteAddress: "127.0.0.1" }), 0);
    expect(mapped.keySegment).toBe(v4.keySegment);
  });

  it("trustedProxyHopsFromEnv fails safe to 0 for missing/garbage input", () => {
    expect(trustedProxyHopsFromEnv({})).toBe(0);
    expect(trustedProxyHopsFromEnv({ AUTH_RATE_LIMIT_TRUSTED_PROXY_HOPS: "" })).toBe(0);
    expect(trustedProxyHopsFromEnv({ AUTH_RATE_LIMIT_TRUSTED_PROXY_HOPS: "abc" })).toBe(0);
    expect(trustedProxyHopsFromEnv({ AUTH_RATE_LIMIT_TRUSTED_PROXY_HOPS: "-2" })).toBe(0);
    expect(trustedProxyHopsFromEnv({ AUTH_RATE_LIMIT_TRUSTED_PROXY_HOPS: "1.5" })).toBe(0);
    expect(trustedProxyHopsFromEnv({ AUTH_RATE_LIMIT_TRUSTED_PROXY_HOPS: "2" })).toBe(2);
  });
});

describe("RateLimitService.acquire (unit)", () => {
  let service: RateLimitService;
  beforeEach(() => {
    service = new RateLimitService();
  });

  const req = (ip = "203.0.113.1", xff?: string) =>
    makeRequest({
      remoteAddress: ip,
      headers: xff === undefined ? {} : { "x-forwarded-for": xff },
    });

  it("login: allows 5 failed attempts, blocks the 6th per identity (Retry-After hint present)", () => {
    for (let i = 0; i < 5; i += 1) {
      expect(service.acquire("login", req(), email).allowed).toBe(true);
    }
    const blocked = service.acquire("login", req(), email);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("login: success resets the identity budget but NOT the origin backstop", () => {
    for (let i = 0; i < 4; i += 1) {
      service.acquire("login", req(), email);
    }
    service.resetIdentity("login", email); // simulate a successful login
    // Identity budget freed: five more attempts allowed again.
    for (let i = 0; i < 5; i += 1) {
      expect(service.acquire("login", req(), email).allowed).toBe(true);
    }
    // Origin backstop kept counting across the reset (4 + 5 = 9 consumed).
    // It is only a backstop (limit 30), so not yet the binding constraint here.
    expect(service.acquire("login", req(), email).allowed).toBe(false);
  });

  it("rejected attempts are never charged against the other dimension (both-or-neither)", () => {
    // Fill the ORIGIN backstop with 30 distinct identities from one source.
    for (let i = 0; i < 30; i += 1) {
      expect(service.acquire("login", req(), `u${i}@example.com`).allowed).toBe(true);
    }
    // The 31st (new email, same source) is blocked by ORIGIN.
    const freshEmail = "never-charged@example.com";
    expect(service.acquire("login", req(), freshEmail).allowed).toBe(false);
    // Because it was rejected, `freshEmail`'s IDENTITY budget was NOT consumed:
    // from a different origin it still gets its full 5-attempt budget.
    for (let i = 0; i < 5; i += 1) {
      expect(service.acquire("login", req("198.51.100.9"), freshEmail).allowed).toBe(true);
    }
    expect(service.acquire("login", req("198.51.100.9"), freshEmail).allowed).toBe(false);
  });

  it("login: per-origin backstop trips independent of identity", () => {
    // 30 distinct identities from the SAME source, one attempt each.
    for (let i = 0; i < 30; i += 1) {
      expect(service.acquire("login", req(), `user${i}@example.com`).allowed).toBe(true);
    }
    // The 31st, from the same origin, is blocked even though its identity is unused.
    expect(service.acquire("login", req(), "fresh@example.com").allowed).toBe(false);
  });

  it("forged X-Forwarded-For cannot open a fresh bucket (hops=0 → socket key)", () => {
    for (let i = 0; i < 5; i += 1) {
      service.acquire("login", req("203.0.113.1"), email);
    }
    // Attacker rotates a forged header trying to evade; still blocked.
    const blocked = service.acquire("login", req("203.0.113.1", "9.9.9.9"), email);
    expect(blocked.allowed).toBe(false);
  });

  it("an exhausted identity stays blocked from a fresh origin (identity is not origin-scoped)", () => {
    for (let i = 0; i < 5; i += 1) {
      service.acquire("login", req("203.0.113.1"), email);
    }
    // Same identity from a DIFFERENT source IP is still blocked: rotating origin
    // does not reuse/escape an already-exhausted identity (7b — the per-identity
    // failure budget is global, which is what makes the origin backstop the
    // orthogonal DoS guard).
    expect(service.acquire("login", req("198.51.100.9"), email).allowed).toBe(false);
  });

  it("reset-on-success preserves the ORIGIN backstop (still exhausts)", () => {
    // Every attempt is treated as a success (identity reset each time), yet the
    // origin keeps counting and eventually blocks despite no identity buildup.
    for (let i = 0; i < 30; i += 1) {
      expect(service.acquire("login", req(), email).allowed).toBe(true);
      service.resetIdentity("login", email);
    }
    expect(service.acquire("login", req(), email).allowed).toBe(false);
  });

  it("under a trusted proxy, rotating the forged XFF prefix does NOT open new origin buckets (P1)", () => {
    const proxied = new RateLimitService({ trustedProxyHops: 1 });
    // Socket is the trusted proxy; it appends the real client 203.0.113.9. The
    // attacker only controls the LEFT prefix, which the limiter never reads.
    const fromClient = (forged: string) =>
      makeRequest({ remoteAddress: "10.0.0.1", headers: { "x-forwarded-for": `${forged}, 203.0.113.9` } });
    for (let i = 0; i < 30; i += 1) {
      expect(proxied.acquire("login", fromClient(`9.9.9.${i}`), `user${i}@example.com`).allowed).toBe(true);
    }
    // 31st: fresh forged prefix AND fresh identity, but the shared real-client
    // origin is exhausted -> blocked. The prefix could not mint a new bucket.
    expect(proxied.acquire("login", fromClient("9.9.9.99"), "fresh@example.com").allowed).toBe(false);
  });

  it("two identities under the SAME forged XFF prefix share one real-origin bucket (P1)", () => {
    const proxied = new RateLimitService({ trustedProxyHops: 1 });
    const req = makeRequest({
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.9" },
    });
    // a@ and b@ share the SAME real client (203.0.113.9) and identical forged
    // prefix, hence ONE origin bucket. Reset identity each hit (as a success
    // would) so identity never binds and the ORIGIN backstop is the only valve:
    // it still trips at 30 accumulating across BOTH identities + forged prefix.
    for (let i = 0; i < 30; i += 1) {
      const who = i % 2 === 0 ? "a@example.com" : "b@example.com";
      expect(proxied.acquire("login", req, who).allowed).toBe(true);
      proxied.resetIdentity("login", who);
    }
    expect(proxied.acquire("login", req, "c@example.com").allowed).toBe(false);
  });

  it("register: per-origin is the binding mass-signup backstop", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(service.acquire("register", req(), `signup${i}@example.com`).allowed).toBe(true);
    }
    expect(service.acquire("register", req(), "another@example.com").allowed).toBe(false);
  });

  it("register: per-identity attempts are bounded per email", () => {
    for (let i = 0; i < 10; i += 1) {
      expect(service.acquire("register", req(), email).allowed).toBe(true);
    }
    // 11th on the same identity blocked even from a fresh origin account limit.
    expect(service.acquire("register", req("198.51.100.2"), email).allowed).toBe(false);
  });

  it("origin still applies when email is missing/malformed", () => {
    for (let i = 0; i < 10; i += 1) {
      expect(service.acquire("login", req(), undefined).allowed).toBe(true);
    }
    // Over the login origin backstop (30) even with no identity key at all.
    for (let i = 10; i < 30; i += 1) {
      expect(service.acquire("login", req(), undefined).allowed).toBe(true);
    }
    expect(service.acquire("login", req(), undefined).allowed).toBe(false);
  });

  it("saturation (P1 regression): an exhausted identity+origin stays DENIED past 30 attempts at a full 20000-key store", () => {
    expect(RATE_LIMIT_MAX_ENTRIES).toBe(20_000); // regression is faithful only at the shipped cap
    const store = new RateLimitStore({ maxEntries: RATE_LIMIT_MAX_ENTRIES });
    const saturated = new RateLimitService({ store });
    const victimIp = "203.0.113.7";
    const victim = "saturation-victim@example.com";
    // Exhaust the victim's identity budget FIRST (5 attempts from its origin).
    for (let i = 0; i < 5; i += 1) {
      expect(saturated.acquire("login", req(victimIp), victim).allowed).toBe(true);
    }
    expect(saturated.acquire("login", req(victimIp), victim).allowed).toBe(false);
    // Fill the store to its real cap with disjoint identity+origin pairs.
    // Denials are tolerated once full — the fill itself must not evict.
    for (let i = 0; i < 10_000; i += 1) {
      const ip = `10.${(i >>> 16) & 255}.${(i >>> 8) & 255}.${i & 255}`;
      saturated.acquire("login", req(ip), `fill${i}@example.com`);
    }
    expect(store.size).toBe(RATE_LIMIT_MAX_ENTRIES);
    expect(saturated.saturationDenials).toBeGreaterThan(0);
    // The victim's ACTIVE blocked counters survived admission pressure: >30
    // further attempts against the same email+IP stay denied. The old code
    // evicted the sibling budget on every insert, so these stayed admitted.
    for (let i = 0; i < 35; i += 1) {
      const decision = saturated.acquire("login", req(victimIp), victim);
      expect(decision.allowed).toBe(false);
      expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    }
    // Direct store evidence: both victim buckets are still present and over limit.
    expect(store.peek(identityBucketKey("login", victim), 5).allowed).toBe(false);
  });

  it("saturation: registration identity+origin budgets hold at cap and new identities are fail-closed (bounded)", () => {
    const store = new RateLimitStore({ maxEntries: RATE_LIMIT_MAX_ENTRIES });
    const saturated = new RateLimitService({ store });
    const victim = "sat-reg-victim@example.com";
    const ip = "203.0.113.8";
    // Exhaust the register identity budget FIRST (10 attempts).
    for (let i = 0; i < 10; i += 1) {
      expect(saturated.acquire("register", req(ip), victim).allowed).toBe(true);
    }
    for (let i = 0; i < 10_000; i += 1) {
      const fillIp = `10.${(i >>> 16) & 255}.${(i >>> 8) & 255}.${i & 255}`;
      saturated.acquire("register", req(fillIp), `regfill${i}@example.com`);
    }
    expect(store.size).toBe(RATE_LIMIT_MAX_ENTRIES);
    // Identity budget holds (also from a fresh origin: identity is global).
    for (let i = 0; i < 5; i += 1) {
      expect(saturated.acquire("register", req(ip), victim).allowed).toBe(false);
    }
    expect(saturated.acquire("register", req("198.51.100.77"), victim).allowed).toBe(false);
    // Overflow is bounded, not unlimited: a brand-new identity+origin at cap is
    // DENIED (fail-closed) rather than admitted without counting.
    const fresh = saturated.acquire("register", req("198.51.100.78"), "brand-new@example.com");
    expect(fresh.allowed).toBe(false);
    expect(fresh.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("RateLimitGuard (unit)", () => {
  it("returns 429 in the shared error schema with Retry-After once the identity budget is exhausted", async () => {
    const guard = new RateLimitGuard(new RateLimitService(), new Reflector());
    for (let i = 0; i < 5; i += 1) {
      await expect(
        guard.canActivate(makeContext("login", makeRequest({ remoteAddress: "203.0.113.5", body: loginBody(email) }), makeReply())),
      ).resolves.toBe(true);
    }
    const reply = makeReply();
    await expect(
      guard.canActivate(makeContext("login", makeRequest({ remoteAddress: "203.0.113.5", body: loginBody(email) }), reply)),
    ).rejects.toMatchObject({ status: 429, response: { code: "RATE_LIMITED" } });
    expect(reply.headersSent["Retry-After"]).toMatch(/^\d+$/);
    expect(Number(reply.headersSent["Retry-After"])).toBeGreaterThan(0);
  });

  it("is a pass-through for routes without a policy (returns true, never blocks)", async () => {
    const guard = new RateLimitGuard(new RateLimitService(), new Reflector());
    const handler: () => void = () => {};
    const cls = class X {};
    const ctx = {
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => makeRequest({}), getResponse: () => makeReply() }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it("admits requests (fail-open) and does not let a limiter exception become a block", async () => {
    const throwing = {
      acquire(): never {
        throw new Error("limiter blew up");
      },
      resetIdentity(): void {},
      resetAll(): void {},
    } as unknown as RateLimitService;
    const guard = new RateLimitGuard(throwing, new Reflector());
    const logger = (guard as unknown as { logger: { error: (...a: unknown[]) => void } }).logger;
    const errors: unknown[] = [];
    // Silence the loud logger and assert it fired (never swallowed).
    logger.error = (...args: unknown[]) => errors.push(args);
    await expect(
      guard.canActivate(makeContext("login", makeRequest({ remoteAddress: "203.0.113.6", body: loginBody(email) }), makeReply())),
    ).resolves.toBe(true);
    expect(errors.length).toBe(1);
  });
});

describe("RateLimitGuard concurrency (unit)", () => {
  it("N simultaneous attempts at the identity threshold yield exactly `limit` admits and no over-limit", async () => {
    const service = new RateLimitService();
    const guard = new RateLimitGuard(service, new Reflector());
    const total = 20; // threshold is 5 for login identity
    const attempts = Array.from({ length: total }, () =>
      guard.canActivate(
        makeContext("login", makeRequest({ remoteAddress: "203.0.113.10", body: loginBody("race@example.com") }), makeReply()),
      ),
    );
    const outcomes = await Promise.allSettled(attempts);
    const admitted = outcomes.filter((o) => o.status === "fulfilled");
    const blocked = outcomes.filter((o) => o.status === "rejected");
    expect(admitted).toHaveLength(5);
    expect(blocked).toHaveLength(total - 5);
    for (const rejection of blocked) {
      const reason = (rejection as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(HttpException);
      expect((reason as HttpException).getStatus()).toBe(429);
    }
  });
});
