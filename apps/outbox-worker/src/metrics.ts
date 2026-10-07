/**
 * Worker metrics — counters only. `toSafeLog()` exposes exactly the numeric
 * counters plus uptime and shutdown state: no row ids, no claim tokens, no
 * URLs, no payloads. Ever.
 */

export type ShutdownState = "running" | "draining" | "stopped";

export interface WorkerMetricsSnapshot {
  /** Rows returned by claim() across all batches. */
  claimed: number;
  /** Batches that returned zero rows. */
  emptyPolls: number;
  /** Items completed (complete() wrote 1 row). */
  published: number;
  /** Items failed (fail() wrote 1 row). */
  failed: number;
  /**
   * Items failed past their first attempt (attempt_count > 1) — i.e. genuine
   * retries rather than first-attempt failures.
   */
  retried: number;
  /**
   * Claimed rows with attempt_count > 1. Approximation: the claim RPC does
   * not return from_state, so a retry of FAILED and a lease-reclaim of
   * PUBLISHING are indistinguishable here — both are re-claims.
   */
  reclaimed: number;
  /** Successful heartbeat renews. */
  renewals: number;
  /** Heartbeat renews that wrote 0 rows (lease already lost). */
  renewFailures: number;
  /**
   * Outcomes abandoned because the lease was lost mid-item (stale complete/
   * fail would write 0 rows): complete-0, fail-0, and publish finished after
   * a failed renew. The recorded outcome is uncertain — reconcile via log.
   */
  staleTokenOutcomes: number;
  publishMsTotal: number;
  publishMsMax: number;
  batchMsTotal: number;
  uptimeMs: number;
  shutdownState: ShutdownState;
}

export class WorkerMetrics {
  claimed = 0;
  emptyPolls = 0;
  published = 0;
  failed = 0;
  retried = 0;
  reclaimed = 0;
  renewals = 0;
  renewFailures = 0;
  staleTokenOutcomes = 0;
  publishMsTotal = 0;
  publishMsMax = 0;
  batchMsTotal = 0;
  shutdownState: ShutdownState = "running";
  private readonly startedAt: number;

  constructor(clock: () => number = Date.now) {
    this.startedAt = clock();
    this.clock = clock;
  }

  private readonly clock: () => number;

  snapshot(): WorkerMetricsSnapshot {
    return {
      claimed: this.claimed,
      emptyPolls: this.emptyPolls,
      published: this.published,
      failed: this.failed,
      retried: this.retried,
      reclaimed: this.reclaimed,
      renewals: this.renewals,
      renewFailures: this.renewFailures,
      staleTokenOutcomes: this.staleTokenOutcomes,
      publishMsTotal: this.publishMsTotal,
      publishMsMax: this.publishMsMax,
      batchMsTotal: this.batchMsTotal,
      uptimeMs: Math.max(0, this.clock() - this.startedAt),
      shutdownState: this.shutdownState,
    };
  }

  /** Safe for logs: counters + uptime + state only. */
  toSafeLog(): Record<string, number | string> {
    const s = this.snapshot();
    return {
      claimed: s.claimed,
      emptyPolls: s.emptyPolls,
      published: s.published,
      failed: s.failed,
      retried: s.retried,
      reclaimed: s.reclaimed,
      renewals: s.renewals,
      renewFailures: s.renewFailures,
      staleTokenOutcomes: s.staleTokenOutcomes,
      publishMsTotal: s.publishMsTotal,
      publishMsMax: s.publishMsMax,
      batchMsTotal: s.batchMsTotal,
      uptimeMs: s.uptimeMs,
      shutdownState: s.shutdownState,
    };
  }
}
