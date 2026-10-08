/**
 * Platform outbox worker — claim → publish → complete/fail loop.
 *
 * Crash semantics (at-least-once, explicitly NOT exactly-once — the database
 * fences the RECORDED outcome via token CAS, never the delivery):
 *
 *   A. Crash BEFORE publish (or lease lost before any outcome call): the row
 *      stays PUBLISHING with a live-then-expired lease and records nothing.
 *      On expiry another worker reclaims it (claim with from_state PUBLISHING
 *      — counted here as `reclaimed` via attempt_count > 1) and publishes.
 *      Safe: no outcome was recorded, no delivery happened.
 *   B. Crash AFTER publish but BEFORE complete: the row is PUBLISHING with a
 *      valid lease, so reclaim re-publishes an already-delivered message.
 *      The TRANSPORT must therefore be idempotent — duplicate delivery is
 *      expected, not a bug. `FakeTransport.atLeastOnceCount` documents this
 *      by counting deliveries per topic.
 *   C. complete()/fail() returns 0 (stale token): another worker reclaimed
 *      the row and owns the outcome. NEVER retry blindly — a stale complete
 *      that "succeeds" would overwrite the current owner's outcome. The item
 *      is counted as `stale`/`staleTokenOutcomes` and left for a reconcile
 *      log line; the current owner finishes it.
 *
 * Lease loss mid-item (heartbeat renew returns 0) is handled like C: no
 * complete/fail is attempted, because the recorded effect would be uncertain.
 * Shutdown (`stop()`) drains in-flight items up to `shutdownTimeoutMs`, then
 * lets live leases expire instead of forcing outcomes — reclaim (A) finishes
 * them after restart.
 */

import { safeParseEnvelope } from "@iptv/domain";
import type { OutboxWorkerConfig } from "./config.js";
import { WorkerMetrics } from "./metrics.js";
import type { ClaimRow, DbPort } from "./rpc.js";
import type { TransportPort } from "./transport.js";

export interface BatchOutcome {
  claimed: number;
  published: number;
  failed: number;
  stale: number;
  empty: boolean;
}

export type WorkerLogger = (msg: string, fields?: Record<string, unknown>) => void;

export interface OutboxWorkerDeps {
  config: OutboxWorkerConfig;
  rpc: DbPort;
  transport: TransportPort;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: WorkerLogger;
}

const FALLBACK_ERROR_CODE = "TRANSPORT_ERROR";

/**
 * Server-side retry ceiling: `outbox_fail` RAISES (not clamps) past
 * now()+7d, which would reject the whole batch. Cap below it with margin
 * for worker→DB clock skew — never send what the server must refuse.
 */
const RETRY_CEILING_MS = 7 * 24 * 60 * 60 * 1000 - 60_000;

/** Sanitize a transport error into a `[A-Z0-9_]` failure code (max 64 chars). */
export function classifyErrorCode(err: unknown): string {
  let raw = "";
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") raw = code;
  }
  if (raw.length === 0 && err instanceof Error) raw = err.message;
  const scrubbed = raw
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return scrubbed.length === 0 ? FALLBACK_ERROR_CODE : scrubbed;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // Intentionally ref'd: the poll sleep in `start()` and the drain sleep in
    // `stop()` MUST hold the event loop open, otherwise an idle long-running
    // worker would exit mid-sleep. The heartbeat race below never touches
    // this helper — it owns a dedicated wall-clock timer per wait and clears
    // it on settle (see processItem), so `run --once` exits promptly.
    setTimeout(resolve, ms);
  });
}

export class OutboxWorker {
  private readonly config: OutboxWorkerConfig;
  private readonly rpc: DbPort;
  private readonly transport: TransportPort;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: WorkerLogger;
  private readonly metrics: WorkerMetrics;
  private stopRequested = false;
  private inFlight = 0;
  /**
   * Batches currently executing `runBatch` (claim + lane fan-out). `stop()`
   * waits for this AND `inFlight`: `inFlight` alone only covers items
   * already handed to `processItem`, so a stop landing during the claim
   * (or between claim and lane start) would otherwise return while the
   * just-claimed lanes still publish after shutdown reported "stopped".
   */
  private activeBatches = 0;

  constructor(deps: OutboxWorkerDeps) {
    this.config = deps.config;
    this.rpc = deps.rpc;
    this.transport = deps.transport;
    this.clock = deps.clock ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.logger =
      deps.logger ??
      ((msg, fields) => {
        console.log(JSON.stringify({ msg, ...(fields ?? {}) }));
      });
    this.metrics = new WorkerMetrics(this.clock);
  }

  snapshot(): ReturnType<WorkerMetrics["snapshot"]> {
    return this.metrics.snapshot();
  }

  safeLog(): Record<string, number | string> {
    return this.metrics.toSafeLog();
  }

  private backoffMs(attemptCount: number): number {
    const { minBackoffMs, maxBackoffMs } = this.config;
    const attempt = Math.max(1, attemptCount);
    const exp = minBackoffMs * 2 ** (attempt - 1);
    if (!Number.isFinite(exp)) return Math.min(maxBackoffMs, RETRY_CEILING_MS);
    return Math.min(Math.max(Math.floor(exp), minBackoffMs), maxBackoffMs, RETRY_CEILING_MS);
  }

  /**
   * Record an outcome through a CAS RPC whose server may RAISE (e.g. fail()
   * past the retry ceiling after clock skew) or fail on a broken connection
   * after the publish already happened. Either way the recorded effect is
   * uncertain: count stale for reconcile and NEVER crash the batch loop or
   * retry blindly over the current owner's outcome.
   */
  private async recordOutcome(
    kind: string,
    call: () => Promise<number>,
  ): Promise<number | null> {
    try {
      return await call();
    } catch {
      this.metrics.staleTokenOutcomes += 1;
      this.logger("outbox.item.stale", { outcome: `${kind}_error` });
      return null;
    }
  }

  private async processItem(row: ClaimRow): Promise<"published" | "failed" | "stale"> {
    this.inFlight += 1;
    try {
      const now = this.clock();
      const parsed = safeParseEnvelope(row.payload_json);
      if (!parsed.success) {
        // Poison envelope: record FAILED at the retry floor (server clamps to
        // >= now()+60s anyway) so a human/dlq pass can inspect it later.
        const retryAt = new Date(now + this.config.minBackoffMs).toISOString();
        const n = await this.recordOutcome("fail_invalid_envelope", () =>
          this.rpc.fail(row.id, row.claim_token, "INVALID_ENVELOPE", retryAt),
        );
        if (n === null || n === 0) {
          if (n === 0) {
            this.metrics.staleTokenOutcomes += 1;
            this.logger("outbox.item.stale", { outcome: "fail_invalid_envelope" });
          }
          return "stale";
        }
        this.metrics.failed += 1;
        if (row.attempt_count > 1) this.metrics.retried += 1;
        return "failed";
      }
      const envelope = parsed.data;

      // Publish with heartbeat: while publish is pending, renew the lease
      // every renewAfterMs (bounded by maxRenews). Renewal continues during
      // a graceful drain: `stop()` waits for the batch to settle, and the
      // lease must stay alive until it does — stopping renewals early
      // would let a slow final publish lose its lease mid-drain.
      let settled = false;
      let resolveSettled: () => void = () => undefined;
      const settledPromise = new Promise<void>((resolve) => {
        resolveSettled = resolve;
      });
      let lostLease = false;
      let renewals = 0;
      const heartbeat = (async (): Promise<void> => {
        while (!settled) {
          // Lease is wall-clock: wait on a dedicated timer (NOT the
          // injectable poll `sleep`), cleared as soon as the item settles.
          // The losing `setTimeout` of a naive `Promise.race` would otherwise
          // stay referenced up to renewAfterMs (default 150s) after a fast
          // publish, holding the loop open so `run --once` prints its result
          // but exits ~2.5min late (and SIGTERM grace stalls the same way).
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, this.config.renewAfterMs);
              }),
              settledPromise,
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
          if (settled) break;
          if (renewals >= this.config.maxRenews) break;
          let n = 0;
          try {
            n = await this.rpc.renew(row.id, row.claim_token, this.config.leaseSeconds);
          } catch {
            n = 0;
          }
          if (n === 0) {
            lostLease = true;
            this.metrics.renewFailures += 1;
            break;
          }
          renewals += 1;
          this.metrics.renewals += 1;
        }
      })();

      const publishStart = this.clock();
      let publishError: unknown = null;
      try {
        await this.transport.publish(envelope);
      } catch (err) {
        publishError = err;
      } finally {
        settled = true;
        resolveSettled();
        await heartbeat;
      }
      const publishMs = Math.max(0, this.clock() - publishStart);
      this.metrics.publishMsTotal += publishMs;
      if (publishMs > this.metrics.publishMsMax) this.metrics.publishMsMax = publishMs;

      if (lostLease) {
        // Semantics C: the lease moved on — complete/fail would write 0 rows
        // at best and mask the current owner's outcome at worst. Abandon.
        this.metrics.staleTokenOutcomes += 1;
        this.logger("outbox.item.stale", { outcome: "lease_lost_mid_publish" });
        return "stale";
      }

      if (publishError === null) {
        const n = await this.recordOutcome("complete", () =>
          this.rpc.complete(row.id, row.claim_token),
        );
        if (n === null || n === 0) {
          if (n === 0) {
            this.metrics.staleTokenOutcomes += 1;
            this.logger("outbox.item.stale", { outcome: "complete_stale" });
          }
          return "stale";
        }
        this.metrics.published += 1;
        return "published";
      }

      const code = classifyErrorCode(publishError);
      const retryAt = new Date(now + this.backoffMs(row.attempt_count)).toISOString();
      const n = await this.recordOutcome("fail", () =>
        this.rpc.fail(row.id, row.claim_token, code, retryAt),
      );
      if (n === null || n === 0) {
        if (n === 0) {
          this.metrics.staleTokenOutcomes += 1;
          this.logger("outbox.item.stale", { outcome: "fail_stale" });
        }
        return "stale";
      }
      this.metrics.failed += 1;
      if (row.attempt_count > 1) this.metrics.retried += 1;
      return "failed";
    } finally {
      this.inFlight -= 1;
    }
  }

  /**
   * One bounded claim → publish → complete/fail batch. Tracked by
   * `activeBatches` so `stop()` can wait for the whole batch (lanes of
   * already-claimed rows are finished, never abandoned to clear state).
   */
  async runOnce(): Promise<BatchOutcome> {
    this.activeBatches += 1;
    try {
      return await this.runBatch();
    } finally {
      this.activeBatches -= 1;
    }
  }

  private async runBatch(): Promise<BatchOutcome> {
    const batchStart = this.clock();
    const rows = await this.rpc.claim(
      this.config.batchSize,
      this.config.workerId,
      this.config.leaseSeconds,
    );
    this.metrics.claimed += rows.length;
    let published = 0;
    let failed = 0;
    let stale = 0;
    if (rows.length === 0) {
      this.metrics.emptyPolls += 1;
    } else {
      for (const row of rows) {
        if (row.attempt_count > 1) this.metrics.reclaimed += 1;
      }
      let next = 0;
      const lanes = Math.min(this.config.maxConcurrency, rows.length);
      const lane = async (): Promise<void> => {
        for (;;) {
          const index = next;
          next += 1;
          const row = rows[index];
          if (row === undefined) return;
          const outcome = await this.processItem(row);
          if (outcome === "published") published += 1;
          else if (outcome === "failed") failed += 1;
          else stale += 1;
        }
      };
      const workers: Array<Promise<void>> = [];
      for (let i = 0; i < lanes; i += 1) workers.push(lane());
      await Promise.all(workers);
    }
    this.metrics.batchMsTotal += Math.max(0, this.clock() - batchStart);
    const outcome: BatchOutcome = {
      claimed: rows.length,
      published,
      failed,
      stale,
      empty: rows.length === 0,
    };
    this.logger("outbox.batch", { ...outcome });
    return outcome;
  }

  /** Run batches until `stop()`; owns SIGTERM/SIGINT → graceful `stop()`. */
  async start(): Promise<void> {
    this.metrics.shutdownState = "running";
    const onSignal = (): void => {
      void this.stop();
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    try {
      while (!this.stopRequested) {
        await this.runOnce();
        if (!this.stopRequested) await this.sleep(this.config.pollMs);
      }
    } finally {
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
      this.metrics.shutdownState = "stopped";
    }
  }

  /**
   * Graceful stop: no new claims, await the current batch (claimed lanes
   * finish publishing) and in-flight items up to shutdownTimeoutMs, then
   * return and let live leases expire (reclaim finishes them later).
   * NEVER forces outcomes to clear state.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.metrics.shutdownState = "draining";
    const deadline = Date.now() + this.config.shutdownTimeoutMs;
    while ((this.inFlight > 0 || this.activeBatches > 0) && Date.now() < deadline) {
      await this.sleep(50);
    }
    this.metrics.shutdownState = "stopped";
  }
}
