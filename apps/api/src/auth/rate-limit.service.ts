import { Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import {
  AUTH_RATE_LIMIT_POLICIES,
  deriveClientOrigin,
  identityBucketKey,
  normalizeIdentityEmail,
  originBucketKey,
  RATE_LIMIT_MAX_ENTRIES,
  type AuthRateLimitKind,
} from "./rate-limit.js";
import { RateLimitStore } from "./rate-limit.store.js";

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
   * `retryAfterSeconds` hint when any budget is exhausted. Synchronous/atomic.
   */
  acquire(kind: AuthRateLimitKind, req: FastifyRequest, rawEmail: unknown): RateLimitAcquireResult {
    const policy = AUTH_RATE_LIMIT_POLICIES[kind];
    const origin = deriveClientOrigin(req, this.trustedProxyHops);
    const originKey = originBucketKey(kind, origin.keySegment);
    const normalizedEmail = normalizeIdentityEmail(rawEmail);
    const identityKey = normalizedEmail === null ? null : identityBucketKey(kind, normalizedEmail);

    const identityDecision = identityKey === null ? ALLOWED : this.store.peek(identityKey, policy.identityLimit);
    const originDecision = this.store.peek(originKey, policy.originLimit);

    if (!identityDecision.allowed || !originDecision.allowed) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(identityDecision.retryAfterSeconds, originDecision.retryAfterSeconds),
      };
    }

    if (identityKey !== null) {
      this.store.consume(identityKey, policy.identityWindowMs);
    }
    this.store.consume(originKey, policy.originWindowMs);
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
}
