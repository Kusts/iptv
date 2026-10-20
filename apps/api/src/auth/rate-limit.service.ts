import { Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import {
  AUTH_RATE_LIMIT_POLICIES,
  deriveClientOrigin,
  identityBucketKey,
  isOriginOnlyKind,
  normalizeIdentityEmail,
  originBucketKey,
  RATE_LIMIT_MAX_ENTRIES,
  type AuthRateLimitKind,
} from "./rate-limit.js";
import { RateLimitStore, type RateLimitAcquireEntry } from "./rate-limit.store.js";

export interface RateLimitServiceOptions {
  /** Trusted proxy hop count for `X-Forwarded-For` reading (default 0 = ignore header). */
  trustedProxyHops?: number;
  /** Injectable store (tests); defaults to a fresh bounded in-memory store. */
  store?: RateLimitStore;
}

export interface RateLimitAcquireResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

const ALLOWED: RateLimitAcquireResult = { allowed: true, retryAfterSeconds: 0 };

/**
 * Bounded, single-process rate limiter for the public auth routes.
 *
 * Two independent budgets gate every attempt and BOTH must pass for the
 * request to reach the (expensive) auth handler:
 *  - a per-identity (hashed email) budget, which for `login` counts failures
 *    and is reset on success ({@link resetIdentity}); and
 *  - a per-origin (fail-safe IP) source-side backstop budget.
 *
 * LOCKOUT-vs-CHALLENGE trade-off (deliberate, numbers kept): the login
 * identity budget is GLOBAL per email — it is intentionally NOT scoped by IP,
 * so rotating source addresses cannot escape an exhausted identity (see the
 * unit test). The cost is that 5 failed logins lock the legitimate owner out
 * for the remainder of the 15-minute window. Scoping the identity budget per
 * IP would remove that lock-out but would open distributed password guessing
 * (one guess per bot across a botnet never trips any single bucket), which is
 * the worse failure for a credential-guessing control. The principled fix for
 * the lock-out side is a challenge step (e.g. CAPTCHA) after N failures rather
 * than weaker counting — future work; the shipped numbers are unchanged.
 *
 * SATURATION (issue #44 P1 fix): both budgets are admitted JOINTLY via a
 * single `store.tryAcquire` call — both charged or neither, never a partial
 * state where one budget was consumed without the other. At the store cap an
 * active counter is never evicted to admit a new key; new-key traffic is
 * denied with a bounded `Retry-After` while existing counters are preserved
 * (fail-closed for new keys, fail-safe for existing ones). See
 * RateLimitStore for the exact policy.
 *
 * Availability decision — FAIL-OPEN, made consciously: the limiter is a
 * synchronous in-memory control with no external dependency, so the only
 * realistic failure mode is an internal bug/exception, not an outage. Failing
 * CLOSED on such an error would turn a non-security bug into a full auth outage
 * and hand an attacker a trivial global-auth DoS primitive (any input that trips
 * the bug locks everyone out). Failing OPEN preserves availability; the layered
 * controls beneath (password-hash cost, eventual account-level controls, and any
 * upstream WAF/CDN limiter) still apply. The exception is logged loudly by the
 * guard and never swallowed.
 *
 * The check-and-consume below is a single synchronous region with no `await`:
 * on the single-threaded event loop it cannot interleave with another request,
 * so the two-bucket "peek both, then consume both or neither" is atomic and a
 * rejected request is never charged.
 */
@Injectable()
export class RateLimitService {
  private readonly store: RateLimitStore;
  private readonly trustedProxyHops: number;

  constructor(options: RateLimitServiceOptions = {}) {
    this.store = options.store ?? new RateLimitStore({ maxEntries: RATE_LIMIT_MAX_ENTRIES });
    this.trustedProxyHops = options.trustedProxyHops ?? 0;
  }

  /**
   * Decide whether an auth attempt may proceed and, when it may, charge one
   * unit to each applicable budget. Returns `allowed: false` with a
   * `retryAfterSeconds` hint when any budget is exhausted. Synchronous/atomic:
   * the peek-both-then-consume-both sequence runs inside a single
   * `store.tryAcquire`, so under saturation pressure admitting the identity
   * budget can never evict the origin budget's active counter (or vice versa).
   */
  acquire(kind: AuthRateLimitKind, req: FastifyRequest, rawEmail: unknown): RateLimitAcquireResult {
    const policy = AUTH_RATE_LIMIT_POLICIES[kind];
    const origin = deriveClientOrigin(req, this.trustedProxyHops);
    // Admin drain kinds are origin-only: any submitted email is ignored so no
    // per-identity bucket is ever created or charged for these kinds.
    const normalizedEmail = isOriginOnlyKind(kind) ? null : normalizeIdentityEmail(rawEmail);

    const entries: RateLimitAcquireEntry[] = [];
    if (normalizedEmail !== null) {
      entries.push({
        key: identityBucketKey(kind, normalizedEmail),
        limit: policy.identityLimit,
        windowMs: policy.identityWindowMs,
      });
    }
    entries.push({
      key: originBucketKey(kind, origin.keySegment),
      limit: policy.originLimit,
      windowMs: policy.originWindowMs,
    });
    const decision = this.store.tryAcquire(entries);
    if (!decision.allowed) {
      return {
        allowed: false,
        retryAfterSeconds: decision.retryAfterSeconds,
      };
    }
    return ALLOWED;
  }

  /**
   * Read-only twin of {@link acquire}: same policy, same client-origin
   * derivation (incl. trusted-proxy hops), same origin-only rule — but it
   * only PEEKS at the buckets via `store.peek` and never charges. Used by
   * the pre-parse upload gate (`upload-preadmit.ts`) so a rate-blocked
   * origin is rejected BEFORE Fastify buffers/parses the body, while the
   * single budget charge still happens exactly once, post-parse, in
   * `RateLimitGuard.acquire`. Throw-transparent like `acquire`: the caller
   * owns the fail-open decision.
   */
  peek(kind: AuthRateLimitKind, req: FastifyRequest, rawEmail: unknown): RateLimitAcquireResult {
    const policy = AUTH_RATE_LIMIT_POLICIES[kind];
    const origin = deriveClientOrigin(req, this.trustedProxyHops);
    const normalizedEmail = isOriginOnlyKind(kind) ? null : normalizeIdentityEmail(rawEmail);

    let retryAfterSeconds = 0;
    if (normalizedEmail !== null) {
      const identity = this.store.peek(identityBucketKey(kind, normalizedEmail), policy.identityLimit);
      if (!identity.allowed) {
        retryAfterSeconds = Math.max(retryAfterSeconds, identity.retryAfterSeconds);
      }
    }
    const originDecision = this.store.peek(originBucketKey(kind, origin.keySegment), policy.originLimit);
    if (!originDecision.allowed) {
      retryAfterSeconds = Math.max(retryAfterSeconds, originDecision.retryAfterSeconds);
    }
    if (retryAfterSeconds > 0) {
      return { allowed: false, retryAfterSeconds };
    }
    return ALLOWED;
  }

  /**
   * Reset an identity's failure budget — called after a SUCCESSFUL login so a
   * legitimate user who mistyped a few times is not carried toward a lock-out,
   * and so different keys are used for success vs failure. No-op without a
   * usable email. The per-origin backstop is intentionally NOT reset.
   */
  resetIdentity(kind: AuthRateLimitKind, rawEmail: unknown): void {
    const normalizedEmail = normalizeIdentityEmail(rawEmail);
    if (normalizedEmail === null) {
      return;
    }
    this.store.reset(identityBucketKey(kind, normalizedEmail));
  }

  /** Test isolation: clear every bucket. */
  resetAll(): void {
    this.store.resetAll();
  }

  /** New-key admissions refused at store capacity (saturation fail-closed path). */
  get saturationDenials(): number {
    return this.store.saturationDenials;
  }
}
