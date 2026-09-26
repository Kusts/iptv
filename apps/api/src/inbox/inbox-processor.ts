import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "@iptv/database";
import { newId, now, safeParseEnvelope } from "@iptv/domain";
import type { EventEnvelope } from "@iptv/domain";

export interface InboxAcceptInput {
  tenantId: string;
  /** Origin namespace, e.g. `local-outbox` (dedupe dimension). */
  provider: string;
  /** Producer-side id, e.g. the envelope `event_id` (dedupe dimension). */
  externalEventId: string;
  payload: unknown;
  correlationId?: string;
}

export type InboxAcceptResult =
  | { status: "processed"; inboxId: string }
  | { status: "duplicate"; inboxId: string }
  | { status: "failed"; inboxId: string; error: string };

/** Handler invoked once per accepted (non-duplicate) message. */
export type InboxHandler = (message: { tenantId: string; envelope: EventEnvelope }) => Promise<void>;

/** Persistence port: insert-once semantics + terminal state marking. */
export interface InboxStore {
  tryInsert(input: {
    tenantId: string;
    provider: string;
    externalEventId: string;
    eventType: string | null;
    payloadHash: string;
    payload: unknown;
    correlationId: string;
  }): Promise<{ inserted: boolean; id: string }>;
  markState(input: { tenantId: string; id: string; state: "PROCESSED" | "FAILED"; errorCode?: string }): Promise<void>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Kysely `InboxStore` over `platform.inbox_messages` (insert-once dedupe). */
@Injectable()
export class KyselyInboxStore implements InboxStore {
  constructor(@Inject("DB") private readonly db: Kysely<Database> | null) {}

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new Error("database is not configured");
    }
    return this.db;
  }

  async tryInsert(input: {
    tenantId: string;
    provider: string;
    externalEventId: string;
    eventType: string | null;
    payloadHash: string;
    payload: unknown;
    correlationId: string;
  }): Promise<{ inserted: boolean; id: string }> {
    const db = this.requireDb();
    const inserted = await db
      .insertInto("platform.inbox_messages")
      .values({
        id: newId(),
        tenant_id: input.tenantId,
        provider: input.provider,
        external_event_id: input.externalEventId,
        event_type: input.eventType,
        payload_hash: input.payloadHash,
        payload_json: input.payload,
        received_at: now(),
        state: "RECEIVED",
        attempt_count: 0,
        processed_at: null,
        last_error_code: null,
        correlation_id: input.correlationId,
      })
      .onConflict((oc) => oc.constraint("inbox_external_event_unique").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted !== undefined) {
      return { inserted: true, id: inserted.id };
    }
    const existing = await db
      .selectFrom("platform.inbox_messages")
      .select("id")
      .where("tenant_id", "=", input.tenantId)
      .where("provider", "=", input.provider)
      .where("external_event_id", "=", input.externalEventId)
      .executeTakeFirstOrThrow();
    return { inserted: false, id: existing.id };
  }

  async markState(input: { tenantId: string; id: string; state: "PROCESSED" | "FAILED"; errorCode?: string }): Promise<void> {
    await this.requireDb()
      .updateTable("platform.inbox_messages")
      .set({
        state: input.state,
        processed_at: input.state === "PROCESSED" ? now() : null,
        last_error_code: input.errorCode ?? null,
      })
      .where("tenant_id", "=", input.tenantId)
      .where("id", "=", input.id)
      .execute();
  }
}

/**
 * Inbox processor (W1-07): dedupe by `(tenant, provider, external_event_id)`
 * via insert-once semantics, then dispatch to the registered handler map.
 * Duplicates are no-op successes — consumers stay idempotent by construction.
 */
@Injectable()
export class InboxProcessor {
  private readonly handlers = new Map<string, InboxHandler>();

  constructor(@Inject("INBOX_STORE") private readonly store: InboxStore) {}

  /** Register a handler for one event type (test/consumer wiring). */
  on(eventType: string, handler: InboxHandler): void {
    this.handlers.set(eventType, handler);
  }

  handlerNames(): string[] {
    return [...this.handlers.keys()];
  }

  async accept(input: InboxAcceptInput): Promise<InboxAcceptResult> {
    const parsed = safeParseEnvelope(input.payload);
    const eventType = parsed.success ? parsed.data.event_type : null;
    const payloadHash = sha256Hex(JSON.stringify(input.payload));
    const { inserted, id } = await this.store.tryInsert({
      tenantId: input.tenantId,
      provider: input.provider,
      externalEventId: input.externalEventId,
      eventType,
      payloadHash,
      payload: input.payload,
      correlationId: input.correlationId ?? newId(),
    });
    if (!inserted) {
      return { status: "duplicate", inboxId: id };
    }
    if (!parsed.success) {
      await this.store.markState({ tenantId: input.tenantId, id, state: "FAILED", errorCode: "INVALID_ENVELOPE" });
      return { status: "failed", inboxId: id, error: "invalid envelope" };
    }
    const handler = this.handlers.get(parsed.data.event_type);
    try {
      if (handler !== undefined) {
        await handler({ tenantId: input.tenantId, envelope: parsed.data });
      }
      await this.store.markState({ tenantId: input.tenantId, id, state: "PROCESSED" });
      return { status: "processed", inboxId: id };
    } catch (err) {
      const code = err instanceof Error ? err.name : "HANDLER_ERROR";
      await this.store.markState({ tenantId: input.tenantId, id, state: "FAILED", errorCode: code });
      return { status: "failed", inboxId: id, error: code };
    }
  }
}
