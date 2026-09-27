import { createHash, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import type { Database } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../commands/command-bus.js";
import type { InboxStore } from "../inbox/inbox-processor.js";
import { normalizeAsaasPayload } from "./asaas-normalizer.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface AsaasChannel {
  tenantId: string;
  secretHash: string | null;
}

export type AsaasWebhookAuthResult =
  | { ok: true; channel: AsaasChannel }
  | { ok: false; code: "unknown_tenant_key" | "unauthorized" | "not_configured" };

/**
 * Asaas webhook ingress service. Mirrors the WAHA ingress discipline:
 * tenant-key mapping (`billing.tenant_channels`, never payload content),
 * timing-safe secret check, durable inbox insert-once keyed by
 * (tenant, `asaas`, provider event id), 202 fast ack, then async normalize:
 * PAID → `charge.webhook_confirm` (validated against the internal charge
 * row), chargeback → `payment.record_chargeback` via the matched payment,
 * unknown → recorded without domain mutation.
 */
@Injectable()
export class AsaasWebhookService {
  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject("INBOX_STORE") private readonly inbox: InboxStore,
    @Inject(CommandBus) private readonly bus: CommandBus,
  ) {}

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new Error("database is not configured");
    }
    return this.db;
  }

  async resolveChannel(tenantKey: string): Promise<AsaasChannel | null> {
    const row = await this.requireDb()
      .selectFrom("billing.tenant_channels")
      .select(["tenant_id", "webhook_secret_hash", "status"])
      .where("tenant_key", "=", tenantKey)
      .executeTakeFirst();
    if (row === undefined || row.status !== "ACTIVE") {
      return null;
    }
    return { tenantId: row.tenant_id, secretHash: row.webhook_secret_hash };
  }

  verifySecret(channel: AsaasChannel, presented: string | undefined): AsaasWebhookAuthResult {
    const expected = channel.secretHash ?? globalAsaasWebhookSecretHash();
    if (expected === null) {
      return { ok: false, code: "not_configured" };
    }
    if (presented === undefined || !secretsEqual(sha256Hex(presented), expected)) {
      return { ok: false, code: "unauthorized" };
    }
    return { ok: true, channel };
  }

  async acceptRaw(input: {
    tenantId: string;
    externalEventId: string;
    payload: unknown;
  }): Promise<{ inserted: boolean; inboxId: string }> {
    const row = await this.inbox.tryInsert({
      tenantId: input.tenantId,
      provider: "asaas",
      externalEventId: input.externalEventId,
      eventType: "asaas.raw",
      payloadHash: sha256Hex(JSON.stringify(input.payload)),
      payload: { body: input.payload },
      correlationId: newId(),
    });
    return { inserted: row.inserted, inboxId: row.id };
  }

  async processRow(tenantId: string, inboxId: string, payload: unknown): Promise<void> {
    const normalized = normalizeAsaasPayload(payload, payload);
    const actor: CommandActor = {
      userId: "asaas-webhook",
      isPlatformAdmin: true,
      tenantId,
      roleKeys: [],
      permissions: [],
      actorType: "external",
    };
    if (normalized.kind === "unknown") {
      await this.inbox.markState({ tenantId, id: inboxId, state: "PROCESSED" });
      return;
    }
    if (normalized.kind === "paid") {
      const result = await this.bus.execute<{
        outcome: "confirmed" | "duplicate" | "exception";
        paymentId: string | null;
        exceptionId: string | null;
      }>(actor, "charge.webhook_confirm", {
        externalChargeId: normalized.externalChargeId,
        externalEventId: normalized.externalEventId,
        reportedAmountMinor: normalized.reportedAmountMinor,
        reportedCurrency: normalized.reportedCurrency,
      });
      await this.inbox.markState({
        tenantId,
        id: inboxId,
        state: result.ok ? "PROCESSED" : "FAILED",
        errorCode: result.ok ? undefined : result.code,
      });
      return;
    }
    // Chargeback: match the internal payment through the provider binding,
    // then record through the distinct chargeback path (never a refund).
    const paymentId = await this.findPaymentForExternalCharge(tenantId, normalized.externalChargeId);
    if (paymentId === null) {
      const openResult = await this.bus.execute(actor, "charge.webhook_confirm", {
        externalChargeId: normalized.externalChargeId,
        externalEventId: normalized.externalEventId,
        reportedAmountMinor: null,
        reportedCurrency: null,
      });
      void openResult;
      await this.inbox.markState({ tenantId, id: inboxId, state: "PROCESSED" });
      return;
    }
    const result = await this.bus.execute(actor, "payment.record_chargeback", {
      paymentId,
      providerEventId: normalized.externalEventId,
      ...(normalized.reportedAmountMinor !== null ? { amountMinor: normalized.reportedAmountMinor } : {}),
    });
    await this.inbox.markState({
      tenantId,
      id: inboxId,
      state: result.ok ? "PROCESSED" : "FAILED",
      errorCode: result.ok ? undefined : result.code,
    });
  }

  private async findPaymentForExternalCharge(tenantId: string, externalChargeId: string): Promise<string | null> {
    const db = this.requireDb();
    const binding = await db
      .selectFrom("billing.charge_provider_bindings")
      .select(["charge_id"])
      .where("tenant_id", "=", tenantId)
      .where("provider", "=", "ASAAS")
      .where("external_charge_id", "=", externalChargeId)
      .executeTakeFirst();
    if (binding === undefined) {
      return null;
    }
    const payment = await db
      .selectFrom("billing.payments")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("charge_id", "=", binding.charge_id)
      .executeTakeFirst();
    return payment?.id ?? null;
  }

  /** Poll/process entry point for deferred rows (tests + future worker). */
  async drainPending(limit = 50): Promise<{ processed: number; failed: number }> {
    const db = this.requireDb();
    const rows = await db
      .selectFrom("platform.inbox_messages")
      .select(["id", "tenant_id", "payload_json"])
      .where("provider", "=", "asaas")
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
  }
}

function globalAsaasWebhookSecretHash(): string | null {
  const secret = process.env["ASAAS_WEBHOOK_SECRET"];
  if (typeof secret !== "string" || secret.length === 0) {
    return null;
  }
  return sha256Hex(secret);
}
