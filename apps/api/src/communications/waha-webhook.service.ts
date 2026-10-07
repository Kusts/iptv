import { createHash, timingSafeEqual } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import type { Database } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { withSpan } from "@iptv/observability";
import { CommandBus } from "../commands/command-bus.js";
import type { InboxStore } from "../inbox/inbox-processor.js";
import { normalizeWahaPayload, normalizeWahaStatus, riskForSessionStatus } from "./waha-normalizer.js";
import { setRiskState } from "./waha-risk-state.js";
import { AgentPipeline } from "../agent/pipeline.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface WahaChannel {
  tenantId: string;
  channel: string;
  secretHash: string | null;
}

export type WebhookAuthResult =
  | { ok: true; channel: WahaChannel }
  | { ok: false; code: "unknown_tenant_key" | "unauthorized" | "not_configured" };

/**
 * WAHA webhook ingress service. Owns tenant-key mapping, secret
 * verification, durable inbox insert-once, and the async normalize stage
 * (WAHA payload → `message.ingest`).
 *
 * Tenant context ALWAYS comes from the `tenant_channels` mapping row —
 * never from payload content.
 */
@Injectable()
export class WahaWebhookService {
  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject("INBOX_STORE") private readonly inbox: InboxStore,
    @Inject(CommandBus) private readonly bus: CommandBus,
    @Optional() @Inject(AgentPipeline) private readonly agents?: AgentPipeline | null,
  ) {}

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new Error("database is not configured");
    }
    return this.db;
  }

  /**
   * Pre-context channel lookup via `communication.resolve_tenant_channel`
   * (`SECURITY DEFINER`, migration 043). A direct `SELECT` on
   * `communication.tenant_channels` runs under the caller's RLS context, so
   * under `iptv_app` with no `app.tenant_id` set yet it fail-closes to 0
   * rows and every webhook 404s. The definer function bypasses RLS for this
   * single narrow lookup (tenant_key → channel row, ACTIVE only); the
   * resolved `tenantId` then feeds `withTenantTransaction` for all
   * subsequent tenant-scoped work.
   */
  async resolveChannel(tenantKey: string): Promise<WahaChannel | null> {
    const result = await sql<{
      tenant_id: string;
      channel: string;
      webhook_secret_hash: string | null;
      status: string;
    }>`select * from communication.resolve_tenant_channel(${tenantKey})`.execute(
      this.requireDb(),
    );
    const row = result.rows[0];
    if (row === undefined || row.status !== "ACTIVE") {
      return null;
    }
    return { tenantId: row.tenant_id, channel: row.channel, secretHash: row.webhook_secret_hash };
  }

  verifySecret(channel: WahaChannel, presented: string | undefined): WebhookAuthResult {
    const expected = channel.secretHash;
    if (expected === null) {
      return { ok: false, code: "not_configured" };
    }
    if (presented === undefined || !secretsEqual(sha256Hex(presented), expected)) {
      return { ok: false, code: "unauthorized" };
    }
    return { ok: true, channel };
  }

  /**
   * Durable accept: insert-once keyed by (tenant, provider=waha, external
   * id). Returns the inbox id and whether this delivery is a duplicate.
   * Programmatic/test path (no routing lock); the HTTP ingress path uses
   * `acceptAtomic` below so resolve-then-insert cannot race a DISABLE or a
   * routing re-point. Both funnel into `platform.inbox_accept`, so dedupe
   * semantics are identical.
   */
  async acceptRaw(input: {
    tenantId: string;
    channel: string;
    externalEventId: string;
    payload: unknown;
  }): Promise<{ inserted: boolean; inboxId: string }> {
    const row = await this.inbox.tryInsert({
      tenantId: input.tenantId,
      provider: "waha",
      externalEventId: input.externalEventId,
      eventType: "waha.raw",
      payloadHash: sha256Hex(JSON.stringify(input.payload)),
      payload: { channel: input.channel, body: input.payload },
      correlationId: newId(),
    });
    return { inserted: row.inserted, inboxId: row.id };
  }

  /**
   * Atomic ingress accept through `communication.accept_waha_delivery`
   * (054, byte-mirror of `billing.accept_asaas_delivery`): the routing row
   * is locked (`FOR UPDATE`), revalidated ACTIVE, matched against the
   * EXPECTED tenant (the `resolveChannel` result, compared under the same
   * lock BEFORE any insert), and the inbox row is inserted-once in the SAME
   * transaction, closing the resolve-then-insert TOCTOU window (a channel
   * DISABLED after the app-side secret check is refused with zero inbox
   * rows). A routing key re-pointed to another tenant mid-flight (resolve
   * said A, the locked row now says B) is refused the same way -- the
   * pre-insert expected-tenant guard means no payload of A ever lands in B.
   * Returns `null` on such a mid-flight refusal -- the controller maps it to
   * 404 like an unknown endpoint -- or when the returned tenant disagrees
   * with the resolved one (defense in depth). Secret comparison stays
   * app-side and timing-safe (`verifySecret`); the function never sees
   * secrets. Hash covers the raw body and the stored payload wraps
   * `{channel, body}`, exactly like the `tryInsert` path it replaces on
   * ingress, so dedupe keys are unchanged.
   */
  async acceptAtomic(input: {
    tenantId: string;
    tenantKey: string;
    channel: string;
    externalEventId: string;
    payload: unknown;
  }): Promise<{ inserted: boolean; inboxId: string } | null> {
    const result = await sql<{
      o_accepted: boolean;
      o_tenant_id: string;
      o_inbox_id: string;
      o_inserted: boolean;
    }>`select * from communication.accept_waha_delivery(${input.tenantKey}, ${input.externalEventId}, ${"waha.raw"}, ${sha256Hex(JSON.stringify(input.payload))}, ${JSON.stringify({ channel: input.channel, body: input.payload })}::jsonb, ${input.tenantId}::uuid)`.execute(
      this.requireDb(),
    );
    const row = result.rows[0];
    if (row === undefined || !row.o_accepted || row.o_tenant_id !== input.tenantId) {
      return null;
    }
    return { inserted: row.o_inserted, inboxId: row.o_inbox_id };
  }

  /**
   * Async normalize stage: WAHA payload → canonical `message.ingest`.
   * Unknown event types are marked PROCESSED (skipped) without touching
   * domain state — fast ack is never blocked by an unknown shape.
   */
  async processRow(tenantId: string, inboxId: string, payload: unknown): Promise<void> {
    return withSpan("webhook.waha.process", { provider: "waha", tenant: tenantId }, async () => {
    const status = normalizeWahaStatus(payload);
    if (status.kind === "status") {
      const risk = riskForSessionStatus(status.status);
      if (risk !== null) {
        setRiskState(tenantId, "WHATSAPP", risk, `waha session status: ${status.status}`);
      }
      await this.inbox.markState({ tenantId, id: inboxId, state: "PROCESSED" });
      return;
    }
    const normalized = normalizeWahaPayload(payload);
    if (normalized.kind === "unknown") {
      await this.inbox.markState({ tenantId, id: inboxId, state: "PROCESSED" });
      return;
    }
    const actor: CommandActor = {
      userId: "waha-webhook",
      isPlatformAdmin: true,
      tenantId,
      roleKeys: [],
      permissions: [],
      actorType: "external",
    };
    const result = await this.bus.execute<{
      messageId: string | null;
      conversationId: string | null;
      exceptionId: string | null;
      duplicate: boolean;
    }>(actor, "message.ingest", {
      channel: "WHATSAPP",
      externalMessageId: normalized.externalId,
      from: normalized.from,
      text: normalized.text,
      occurredAt: normalized.occurredAt,
      session: normalized.session,
    });
    if (!result.ok) {
      await this.inbox.markState({ tenantId, id: inboxId, state: "FAILED", errorCode: result.code });
      return;
    }
    await this.inbox.markState({ tenantId, id: inboxId, state: "PROCESSED" });
    // Wave 3 post-ingest hook: enqueue an agent evaluation for matched OPEN
    // conversations. Best-effort — ingest must never fail because of the
    // agent path; duplicates/exceptions skip evaluation.
    if (result.data.duplicate || result.data.conversationId === null) {
      return;
    }
    try {
      await this.agents?.evaluateInbound({
        tenantId,
        conversationId: result.data.conversationId,
        inboundText: normalized.text,
      });
    } catch {
      // Agent evaluation is advisory; inbound is already persisted.
    }
    });
  }

  /**
   * Inline HTTP processing entry point: claims THIS row first through
   * `platform.inbox_claim_by_id` (054) -- the same RECEIVED -> PROCESSING
   * protocol the scheduler drain uses -- and only then runs `processRow`.
   * Zero claimed rows means the drain already owns the row (it won the
   * inline x scheduler race), so the caller MUST skip processing and ack
   * idempotently: exactly one processor ever owns a row. A tenant mismatch
   * (unreachable -- the id comes from our own accept) fails closed the same
   * way.
   */
  async processInline(tenantId: string, inboxId: string, payload: unknown, consumer: string): Promise<{ claimed: boolean }> {
    const claimed = await sql<{
      o_inbox_id: string;
      o_tenant_id: string;
      o_payload_json: unknown;
    }>`select * from platform.inbox_claim_by_id(${inboxId}::uuid, ${consumer})`.execute(this.requireDb());
    const row = claimed.rows[0];
    if (row === undefined || row.o_tenant_id !== tenantId) {
      return { claimed: false };
    }
    await this.processRow(tenantId, inboxId, payload);
    return { claimed: true };
  }

  /**
   * Poll/process entry point for deferred rows (tests + scheduler worker).
   * Claims a disjoint RECEIVED set through `platform.inbox_claim` (054:
   * RECEIVED → PROCESSING under `FOR UPDATE SKIP LOCKED`, provider-scoped so
   * the Asaas drain can never take our rows and vice versa), then processes
   * each claimed row under ITS OWN tenant (the tenant comes from the claimed
   * row, never from request input; `processRow` fans out to the tenant-scoped
   * command path and `markState` lands in the same row-tenant context).
   * Concurrent drains never process the same row: what one claim takes, the
   * other never sees again.
   */
  async drainPending(limit = 50): Promise<{ processed: number; failed: number }> {
    return withSpan("webhook.waha.drain", { provider: "waha" }, async () => {
    const claimed = await sql<{
      o_inbox_id: string;
      o_tenant_id: string;
      o_payload_json: unknown;
    }>`select * from platform.inbox_claim(${limit}, ${"waha"}, ${"drain:waha"})`.execute(this.requireDb());
    let processed = 0;
    let failed = 0;
    for (const row of claimed.rows) {
      const body = (row.o_payload_json as { body?: unknown })?.body ?? row.o_payload_json;
      try {
        await this.processRow(row.o_tenant_id, row.o_inbox_id, body);
        processed += 1;
      } catch {
        await this.inbox.markState({ tenantId: row.o_tenant_id, id: row.o_inbox_id, state: "FAILED", errorCode: "HANDLER_ERROR" });
        failed += 1;
      }
    }
    return { processed, failed };
    });
  }
}
