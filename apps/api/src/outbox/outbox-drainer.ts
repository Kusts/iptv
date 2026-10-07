import { Inject, Injectable } from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import type { Database } from "@iptv/database";
import { now, safeParseEnvelope } from "@iptv/domain";
import type { EventEnvelope } from "@iptv/domain";
import type { LocalTransport, TransportPort } from "./transport.js";

export interface DrainResult {
  claimed: number;
  published: number;
  failed: number;
  /** Event ids published by this drain call (for tests/ops). */
  eventIds: string[];
}

export interface LegacyDrainState {
  enabled: boolean;
  inFlight: number;
  totalDrains: number;
  lastFinishedAt: string | null;
}

const LEGACY_DRAIN_DISABLED_MESSAGE = "legacy outbox drain is disabled (LEGACY_OUTBOX_DRAIN_ENABLED=0)";
const LEGACY_DRAIN_ENV_ERROR = 'invalid environment configuration: LEGACY_OUTBOX_DRAIN_ENABLED must be "0" or "1"';
const QUIESCENCE_TIMEOUT_MESSAGE = "legacy outbox drain quiescence timeout (drain still in flight)";

/** Thrown when the legacy drain path is invoked while disabled via env gate. */
export class LegacyOutboxDrainDisabledError extends Error {
  constructor() {
    super(LEGACY_DRAIN_DISABLED_MESSAGE);
    this.name = "LegacyOutboxDrainDisabledError";
  }
}

/**
 * Activation gate for the legacy drain path. Absent or `"1"` → enabled
 * (default preserves current behavior); `"0"` → disabled. Any other value
 * fails closed with a fixed message (never echoes the offending value).
 */
export function isLegacyOutboxDrainEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["LEGACY_OUTBOX_DRAIN_ENABLED"];
  if (raw === undefined || raw === "1") {
    return true;
  }
  if (raw === "0") {
    return false;
  }
  throw new Error(LEGACY_DRAIN_ENV_ERROR);
}

const CLAIMABLE = ["PENDING", "FAILED"] as const;

/**
 * LEGACY outbox drainer (W1-07): claims due rows with
 * `FOR UPDATE SKIP LOCKED` (parallel drains process disjoint rows),
 * publishes each claimed envelope through the `TransportPort`, then marks
 * `PUBLISHED` (or `FAILED` with a backoff and error code). Claim and state
 * flip are atomic; delivery happens outside the claim transaction.
 *
 * LEGACY protocol notes (issue #10): this drainer claims with a bare
 * `PUBLISHING` flip — no lease token, no compare-and-swap. Coexistence with
 * the new leased outbox worker is PROHIBITED: both would claim the same
 * rows. See the cutover runbook `rls-role-split-cutover.md`
 * ("Activation gate") for the disable/enable procedure.
 *
 * Quiescence support: `drain()` is tracked by an in-flight gauge
 * (`getDrainState()`); operators drain in-flight work via
 * `waitForQuiescence()` before switching the gate off. Rollback (re-enable
 * with `LEGACY_OUTBOX_DRAIN_ENABLED=1`) only reclaims rows the legacy
 * protocol can see — rows left `PUBLISHING`-with-lease by the new worker
 * are NOT reclaimable by this drainer, so rollback requires zero
 * `PUBLISHING` rows or a forward-fix.
 */
@Injectable()
export class OutboxDrainer {
  private activeDrains = 0;
  private totalDrains = 0;
  private lastDrainFinishedAt: string | null = null;

  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject("TRANSPORT") private readonly transport: TransportPort | LocalTransport,
  ) {}

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new Error("database is not configured");
    }
    return this.db;
  }

  /** Current in-flight count (seam for `waitForQuiescence`; override in tests). */
  protected currentInFlight(): number {
    return this.activeDrains;
  }

  /** Quiescence gauge snapshot for ops (enabled + in-flight + totals). */
  getDrainState(): LegacyDrainState {
    return {
      enabled: isLegacyOutboxDrainEnabled(),
      inFlight: this.activeDrains,
      totalDrains: this.totalDrains,
      lastFinishedAt: this.lastDrainFinishedAt,
    };
  }

  /**
   * Wait until no `drain()` call is in flight. Polls every 50ms; throws
   * after `timeoutMs` (100..300000, else throws immediately).
   */
  async waitForQuiescence(timeoutMs = 30000): Promise<void> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) {
      throw new Error("invalid quiescence timeout: must be an integer between 100 and 300000 ms");
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.currentInFlight() === 0) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(QUIESCENCE_TIMEOUT_MESSAGE);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  }

  async drain(limit = 50): Promise<DrainResult> {
    if (!isLegacyOutboxDrainEnabled()) {
      throw new LegacyOutboxDrainDisabledError();
    }
    this.activeDrains += 1;
    this.totalDrains += 1;
    try {
      return await this.drainInner(limit);
    } finally {
      this.activeDrains -= 1;
      this.lastDrainFinishedAt = new Date().toISOString();
    }
  }

  private async drainInner(limit: number): Promise<DrainResult> {
    const db = this.requireDb();
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 500);
    const claimed = await db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom("platform.outbox_messages")
        .select(["id", "payload_json"])
        .where("state", "in", [...CLAIMABLE])
        .where("next_attempt_at", "<=", now())
        .orderBy("created_at", "asc")
        .limit(safeLimit)
        .forUpdate()
        .skipLocked()
        .execute();
      if (rows.length === 0) {
        return [];
      }
      const ids = rows.map((r) => r.id);
      await trx
        .updateTable("platform.outbox_messages")
        .set({ state: "PUBLISHING", attempt_count: sql`attempt_count + 1`, last_error_code: null })
        .where("id", "in", ids)
        .execute();
      return rows;
    });

    const result: DrainResult = { claimed: claimed.length, published: 0, failed: 0, eventIds: [] };
    for (const row of claimed) {
      const parsed = safeParseEnvelope(row.payload_json);
      if (!parsed.success) {
        await db
          .updateTable("platform.outbox_messages")
          .set({ state: "FAILED", last_error_code: "INVALID_ENVELOPE", next_attempt_at: new Date(Date.now() + 60_000) })
          .where("id", "=", row.id)
          .execute();
        result.failed += 1;
        continue;
      }
      const envelope: EventEnvelope = parsed.data;
      try {
        await this.transport.publish(envelope);
        await db
          .updateTable("platform.outbox_messages")
          .set({ state: "PUBLISHED", published_at: now(), last_error_code: null })
          .where("id", "=", row.id)
          .execute();
        result.published += 1;
        result.eventIds.push(envelope.event_id);
      } catch (err) {
        const code = err instanceof Error ? err.name : "TRANSPORT_ERROR";
        await db
          .updateTable("platform.outbox_messages")
          .set({ state: "FAILED", last_error_code: code, next_attempt_at: new Date(Date.now() + 60_000) })
          .where("id", "=", row.id)
          .execute();
        result.failed += 1;
      }
    }
    return result;
  }
}
