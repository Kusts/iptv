import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { withTenantTransaction, type Database } from "@iptv/database";
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
    // Pre-context insert-once through the `platform.inbox_accept` producer
    // (053): a direct INSERT under `iptv_app` with no `app.tenant_id` set
    // fails the RLS WITH CHECK, and the producer returns the EXISTING id on
    // conflict, so no compensating SELECT is needed. Shared by the WAHA
    // ingress and any future provider path (Asaas collapses further into
    // `billing.accept_asaas_delivery`, which calls the same producer).
    const result = await sql<{
      o_inbox_id: string;
      o_inserted: boolean;
    }>`select * from platform.inbox_accept(${input.tenantId}::uuid, ${input.provider}, ${input.externalEventId}, ${input.eventType}, ${input.payloadHash}, ${JSON.stringify(input.payload)}::jsonb)`.execute(
      this.requireDb(),
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("inbox accept returned no row");
    }
    return { inserted: row.o_inserted, id: row.o_inbox_id };
  }

  async markState(input: { tenantId: string; id: string; state: "PROCESSED" | "FAILED"; errorCode?: string }): Promise<void> {
    // Lifecycle transition under explicit tenant context (053): the inbox
    // table is RLS-enrolled, so the pool-level UPDATE must carry the
    // caller's tenant (present in every markState input). The RECEIVED ->
    // PROCESSING claim itself is producer-ized (`platform.inbox_claim`,
    // 054); this terminal transition stays an explicit tenant-scoped UPDATE.
    //
    // 054: worker drains claim RECEIVED -> PROCESSING through
    // `platform.inbox_claim` (narrow definer, SKIP LOCKED disjointness) and
    // land here with the CLAIMED ROW's tenant -- the same row-tenant context
    // for `processRow` and `markState`, never request input. Terminal states
    // stay terminal: no lease, no reclaim, so a re-drain can never
    // double-apply a claimed row. A PROCESSING row stranded by a crash
    // between claim and this transition is recovered ONLY via the
    // operator-owned `platform.inbox_requeue` (054) -- see the inbox section
    // of `docs/10-operations/runbooks/rls-role-split-cutover.md`.
    await withTenantTransaction(this.requireDb(), input.tenantId, async (trx) => {
      await trx
        .updateTable("platform.inbox_messages")
        .set({
          state: input.state,
          processed_at: input.state === "PROCESSED" ? now() : null,
          last_error_code: input.errorCode ?? null,
        })
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.id)
        .execute();
    });
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
