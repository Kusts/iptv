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

const CLAIMABLE = ["PENDING", "FAILED"] as const;

/**
 * Outbox drainer (W1-07): claims due rows with `FOR UPDATE SKIP LOCKED`
 * (parallel drains process disjoint rows), publishes each claimed envelope
 * through the `TransportPort`, then marks `PUBLISHED` (or `FAILED` with a
 * backoff and error code). Claim and state flip are atomic; delivery
 * happens outside the claim transaction.
 */
@Injectable()
export class OutboxDrainer {
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

  async drain(limit = 50): Promise<DrainResult> {
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
