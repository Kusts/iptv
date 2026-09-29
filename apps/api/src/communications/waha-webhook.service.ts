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

  /** Poll/process entry point for deferred rows (tests + future worker). */
  async drainPending(limit = 50): Promise<{ processed: number; failed: number }> {
    return withSpan("webhook.waha.drain", { provider: "waha" }, async () => {
    const db = this.requireDb();
    const rows = await db
      .selectFrom("platform.inbox_messages")
      .select(["id", "tenant_id", "payload_json"])
      .where("provider", "=", "waha")
      .where("state", "=", "RECEIVED")
      .orderBy("received_at", "asc")
      .limit(limit)
      .execute();
    let processed = 0;
    let failed = 0;
    for (const row of rows) {
      const body = (row.payload_json as { body?: unknown })?.body ?? row.payload_json;
      try {
        await this.processRow(row.tenant_id, row.id, body);
        processed += 1;
      } catch {
        await this.inbox.markState({ tenantId: row.tenant_id, id: row.id, state: "FAILED", errorCode: "HANDLER_ERROR" });
        failed += 1;
      }
    }
    return { processed, failed };
    });
  }
}
