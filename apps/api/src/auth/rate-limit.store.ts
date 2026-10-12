/**
 * Bounded, TTL-bounded in-memory counter store for the public-auth rate
 * limiter. It is the only mutable state the limiter keeps and it is strictly
 * bounded (see `maxEntries`); expired buckets are pruned lazily on access and
 * deterministically when the cap is reached, so memory cannot grow
 * without limit under an attack that keeps producing new keys.
 *
 * SATURATION POLICY (fail-closed for NEW keys, fail-safe for EXISTING ones —
 * issue #44, P1 saturation-evasion fix): when the store is at capacity, an
 * ACTIVE (unexpired) bucket is NEVER evicted to admit a new key. Evicting an
 * active counter to make room would delete the very budget that is currently
 * blocking an attacker, so repeated attempts against the same identity+origin
 * would stay admitted past their limits. Instead, after pruning every expired
 * bucket, admission of a new key is REFUSED (the caller returns a bounded
 * denial with a `Retry-After` hint) while all existing counters are preserved
 * untouched. The overflow path is therefore bounded: at cap the limiter denies
 * new-key traffic rather than admitting it without counting. Refusals are
 * observable via {@link saturationDenials}; they surface to clients as normal
 * `429 RATE_LIMITED` responses, never as exceptions (so the guard's
 * fail-open-on-exception path is NOT triggered by saturation).
 *
 * Concurrency: every public method is fully synchronous — there is no `await`
 * or I/O between reading a bucket and updating it. On the single-threaded Node
 * event loop a synchronous region cannot be preempted, so a
 * peek-then-consume sequence in the caller is atomic and no race can let two
 * concurrent requests exceed a limit. This is the reason the check-and-consume
 * path is intentionally free of asynchronous work (see RateLimitService.acquire,
 * which delegates to {@link tryAcquire} so multi-key admission is atomic too).
 *
 * Horizontal scaling: the store lives in ONE process. If the API is scaled to N
 * processes/instances, each has its own store, so the effective limit
 * multiplies by N. A shared store (e.g. Redis) would be required to enforce a
 * single global limit across instances — out of scope for this change and
 * documented in the PR note.
 */
export interface RateLimitBucket {
  /** Attempts counted in the current window. */
  count: number;
  /** Epoch ms at which the current window expires (bucket is pruned at/after). */
  expiresAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the limiting window frees up (0 when allowed). */
  retryAfterSeconds: number;
}

export interface RateLimitStoreOptions {
  /** Hard upper bound on the number of retained keys. */
  maxEntries: number;
  /** Injectable clock (defaults to `Date.now`); used only by tests. */
  now?: () => number;
}

/** One budget charged by a joint check-and-consume (see {@link RateLimitStore.tryAcquire}). */
export interface RateLimitAcquireEntry {
  key: string;
  limit: number;
  windowMs: number;
}

const SECONDS_CEILING_MS = 1000;

export class RateLimitStore {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private saturationRefusals = 0;

  constructor(options: RateLimitStoreOptions) {
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? (() => Date.now());
  }

  /** Number of keys currently retained (diagnostics/tests). */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * New-key admissions refused because the store was at capacity with only
   * active buckets (saturation fail-closed path). Monotonic within process
   * lifetime (resets with {@link resetAll}); operators can export it to
   * distinguish saturation pressure from ordinary limit denials.
   */
  get saturationDenials(): number {
    return this.saturationRefusals;
  }

  /**
   * Read-only capacity check for `key`. Prunes the touched key when its window
   * has expired but never changes the count of a still-valid bucket. Pair with
   * {@link consume} to build an atomic check-and-consume (see class doc).
   */
  peek(key: string, limit: number): RateLimitDecision {
    const nowMs = this.now();
    this.pruneKey(key, nowMs);
    const bucket = this.buckets.get(key);
    if (bucket === undefined) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (bucket.count >= limit) {
      return { allowed: false, retryAfterSeconds: this.retryAfter(bucket.expiresAt, nowMs) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /**
   * Count one attempt. Creates a fresh window (count 1) for an absent/expired
   * bucket, otherwise increments the existing bucket without extending its
   * expiry (fixed window anchored at the first attempt).
   *
   * Fail-closed at capacity: when the store is full of ACTIVE buckets the new
   * key is NOT created (no active counter is evicted to make room) and `false`
   * is returned; the caller must treat the attempt as denied. Returns `true`
   * when the attempt was counted.
   */
  consume(key: string, windowMs: number): boolean {
    const nowMs = this.now();
    const bucket = this.buckets.get(key);
    if (bucket !== undefined && bucket.expiresAt > nowMs) {
      bucket.count += 1;
      return true;
    }
    if (bucket === undefined && this.buckets.size + 1 > this.maxEntries) {
      this.pruneExpired(nowMs);
      if (this.buckets.size + 1 > this.maxEntries) {
        this.saturationRefusals += 1;
        return false;
      }
    }
    this.buckets.set(key, { count: 1, expiresAt: nowMs + windowMs });
    return true;
  }

  /**
   * Joint atomic check-and-consume for the budgets that gate ONE attempt
   * (identity + origin). Either every entry is charged or none is — there is
   * no interleaving state where one budget was consumed without the other,
   * and (unlike two sequential `consume` calls) admitting the first entry can
   * never evict the second entry's active counter under saturation pressure.
   *
   * Denial (no mutation at all) happens when any budget is exhausted — a
   * rejected attempt is never charged — or when the store is saturated: after
   * pruning expired buckets there is no room for every NEW key, so the attempt
   * is refused with a bounded `retryAfterSeconds` pointing at the soonest
   * bucket expiry instead of being admitted uncounted.
   */
  tryAcquire(entries: readonly RateLimitAcquireEntry[]): RateLimitDecision {
    const nowMs = this.now();
    const unique = new Map<string, RateLimitAcquireEntry>();
    for (const entry of entries) {
      if (!unique.has(entry.key)) {
        unique.set(entry.key, entry);
      }
    }
    for (const key of unique.keys()) {
      this.pruneKey(key, nowMs);
    }
    let retryAfterSeconds = 0;
    for (const entry of unique.values()) {
      const bucket = this.buckets.get(entry.key);
      if (bucket !== undefined && bucket.count >= entry.limit) {
        retryAfterSeconds = Math.max(retryAfterSeconds, this.retryAfter(bucket.expiresAt, nowMs));
      }
    }
    if (retryAfterSeconds > 0) {
      return { allowed: false, retryAfterSeconds };
    }
    let newKeys = 0;
    for (const key of unique.keys()) {
      if (!this.buckets.has(key)) {
        newKeys += 1;
      }
    }
    if (newKeys > 0 && this.buckets.size + newKeys > this.maxEntries) {
      this.pruneExpired(nowMs);
      if (this.buckets.size + newKeys > this.maxEntries) {
        this.saturationRefusals += 1;
        return { allowed: false, retryAfterSeconds: this.saturationRetryAfter(nowMs) };
      }
    }
    for (const entry of unique.values()) {
      const bucket = this.buckets.get(entry.key);
      if (bucket === undefined) {
        this.buckets.set(entry.key, { count: 1, expiresAt: nowMs + entry.windowMs });
      } else {
        bucket.count += 1;
      }
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Clear a single key (used to reset an identity's failure budget on success). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Clear every key. Test isolation only. Also zeroes the saturation counter. */
  resetAll(): void {
    this.buckets.clear();
    this.saturationRefusals = 0;
  }

  private retryAfter(expiresAt: number, nowMs: number): number {
    return Math.max(1, Math.ceil((expiresAt - nowMs) / SECONDS_CEILING_MS));
  }

  private pruneKey(key: string, nowMs: number): void {
    const bucket = this.buckets.get(key);
    if (bucket !== undefined && bucket.expiresAt <= nowMs) {
      this.buckets.delete(key);
    }
  }

  /** Delete every expired bucket. Only called when admitting new keys at capacity. */
  private pruneExpired(nowMs: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= nowMs) {
        this.buckets.delete(key);
      }
    }
  }

  /**
   * Bounded backoff hint for a saturation refusal: seconds until the
   * soonest-retained bucket expires (at least 1). The store is full here, so
   * at least one bucket exists; the empty-store fallback is defensive only.
   */
  private saturationRetryAfter(nowMs: number): number {
    let soonest = Number.POSITIVE_INFINITY;
    for (const bucket of this.buckets.values()) {
      if (bucket.expiresAt < soonest) {
        soonest = bucket.expiresAt;
      }
    }
    if (soonest === Number.POSITIVE_INFINITY) {
      return 1;
    }
    return this.retryAfter(soonest, nowMs);
  }
}
