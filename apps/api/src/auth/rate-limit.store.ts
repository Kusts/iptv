/**
 * Bounded, TTL-bounded in-memory counter store for the public-auth rate
 * limiter. It is the only mutable state the limiter keeps and it is strictly
 * bounded (see `maxEntries`); expired buckets are pruned lazily on access and
 * evicted deterministically when the cap is reached, so memory cannot grow
 * without limit under an attack that keeps producing new keys.
 *
 * Concurrency: every public method is fully synchronous — there is no `await`
 * or I/O between reading a bucket and updating it. On the single-threaded Node
 * event loop a synchronous region cannot be preempted, so a
 * peek-then-consume sequence in the caller is atomic and no race can let two
 * concurrent requests exceed a limit. This is the reason the check-and-consume
 * path is intentionally free of asynchronous work (see RateLimitService.acquire).
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

const SECONDS_CEILING_MS = 1000;

export class RateLimitStore {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: RateLimitStoreOptions) {
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? (() => Date.now());
  }

  /** Number of keys currently retained (diagnostics/tests). */
  get size(): number {
    return this.buckets.size;
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
   * expiry (fixed window anchored at the first attempt). Bounds memory before
   * inserting a new key.
   */
  consume(key: string, windowMs: number): void {
    const nowMs = this.now();
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.expiresAt <= nowMs) {
      this.ensureCapacity(nowMs);
      this.buckets.set(key, { count: 1, expiresAt: nowMs + windowMs });
      return;
    }
    bucket.count += 1;
  }

  /** Clear a single key (used to reset an identity's failure budget on success). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Clear every key. Test isolation only. */
  resetAll(): void {
    this.buckets.clear();
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

  /**
   * Make room for one new key when the store is at capacity: first prune every
   * expired bucket, then — if still full — deterministically evict the single
   * entry whose window expires soonest (keeps the freshest activity). The store
   * size never exceeds `maxEntries`.
   */
  private ensureCapacity(nowMs: number): void {
    if (this.buckets.size < this.maxEntries) {
      return;
    }
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= nowMs) {
        this.buckets.delete(key);
      }
    }
    if (this.buckets.size < this.maxEntries) {
      return;
    }
    let evictKey: string | null = null;
    let evictExpiry = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt < evictExpiry) {
        evictExpiry = bucket.expiresAt;
        evictKey = key;
      }
    }
    if (evictKey !== null) {
      this.buckets.delete(evictKey);
    }
  }
}
