import { createHash, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import { withTenantTransaction, type Database } from "@iptv/database";
import type { CommandActor } from "@iptv/domain";
import { withSpan } from "@iptv/observability";
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

  /**
   * Pre-context channel lookup via `billing.resolve_tenant_channel`
   * (`SECURITY DEFINER`, migration 052). A direct `SELECT` on
   * `billing.tenant_channels` runs under the caller's RLS context, so
   * under `iptv_app` with no `app.tenant_id` set yet it fail-closes to 0
   * rows and every webhook 404s. The definer function bypasses RLS for this
   * single narrow lookup (tenant_key → channel row, ACTIVE only); the
   * resolved `tenantId` then feeds the tenant context for all subsequent
   * tenant-scoped work.
   */
  async resolveChannel(tenantKey: string): Promise<AsaasChannel | null> {
    const result = await sql<{
      tenant_id: string;
      channel: string;
      webhook_secret_hash: string | null;
      status: string;
    }>`select * from billing.resolve_tenant_channel(${tenantKey})`.execute(
      this.requireDb(),
    );
    const row = result.rows[0];
    if (row === undefined || row.status !== "ACTIVE") {
      return null;
    }
    return { tenantId: row.tenant_id, secretHash: row.webhook_secret_hash };
  }

  verifySecret(channel: AsaasChannel, presented: string | undefined): AsaasWebhookAuthResult {
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
   * Atomic accept through `billing.accept_asaas_delivery` (053): the routing
   * row is locked (`FOR UPDATE`), revalidated ACTIVE, matched against the
   * EXPECTED tenant (the `resolveChannel` result, compared under the same
   * lock BEFORE any insert), and the inbox row is inserted-once in the SAME
   * transaction, closing the resolve-then-insert TOCTOU window (a channel
   * DISABLED after the app-side secret check is refused with zero inbox
   * rows). A routing key re-pointed to another tenant mid-flight (resolve
   * said A, the locked row now says B) is refused the same way -- the
   * pre-insert expected-tenant guard means no payload of A ever lands in B.
   * Returns `null` on such a mid-flight refusal -- the controller maps it to
   * 404 like an unknown endpoint -- or when the returned tenant disagrees
   * with the resolved one (defense in depth: unreachable when the pre-insert
   * guard fires, kept so a future function change can never deliver into
   * another tenant silently). Secret comparison stays app-side and
   * timing-safe (`verifySecret`); the function never sees secrets.
   */
  async acceptRaw(input: {
    tenantId: string;
    tenantKey: string;
    externalEventId: string;
    payload: unknown;
  }): Promise<{ inserted: boolean; inboxId: string } | null> {
    const result = await sql<{
      o_accepted: boolean;
      o_tenant_id: string;
      o_inbox_id: string;
      o_inserted: boolean;
    }>`select * from billing.accept_asaas_delivery(${input.tenantKey}, ${input.externalEventId}, ${"asaas.raw"}, ${sha256Hex(JSON.stringify(input.payload))}, ${JSON.stringify({ body: input.payload })}::jsonb, ${input.tenantId}::uuid)`.execute(
      this.requireDb(),
    );
    const row = result.rows[0];
    if (row === undefined || !row.o_accepted || row.o_tenant_id !== input.tenantId) {
      return null;
    }
    return { inserted: row.o_inserted, inboxId: row.o_inbox_id };
  }

  async processRow(tenantId: string, inboxId: string, payload: unknown): Promise<void> {
    return withSpan("webhook.asaas.process", { provider: "asaas", tenant: tenantId }, async () => {
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
    });
  }

  /**
   * Tenant-scoped payment lookup for the chargeback path. MUST run inside
   * `withTenantTransaction`: both tables are RLS-enrolled (migration 052,
   * fail-closed when `app.tenant_id` is unset), so a pool-level SELECT under
   * `iptv_app` with no tenant context returns 0 rows and the chargeback
   * silently degrades to the unknown-charge fallback (PROCESSED, no
   * CHARGEBACK status, no loss posting). The command path itself
   * (`bus.execute` → `withTransaction`) is already tenant-scoped; only this
   * pre-command lookup needed the wrap.
   */
  private async findPaymentForExternalCharge(tenantId: string, externalChargeId: string): Promise<string | null> {
    const db = this.requireDb();
    return withTenantTransaction(db, tenantId, async (trx) => {
      const binding = await trx
        .selectFrom("billing.charge_provider_bindings")
        .select(["charge_id"])
        .where("tenant_id", "=", tenantId)
        .where("provider", "=", "ASAAS")
        .where("external_charge_id", "=", externalChargeId)
        .executeTakeFirst();
      if (binding === undefined) {
        return null;
      }
      const payment = await trx
        .selectFrom("billing.payments")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("charge_id", "=", binding.charge_id)
        .executeTakeFirst();
      return payment?.id ?? null;
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
   * the WAHA drain can never take our rows and vice versa), then processes
   * each claimed row under ITS OWN tenant (the tenant comes from the claimed
   * row, never from request input; `processRow` fans out to the tenant-scoped
   * command path and `markState` lands in the same row-tenant context).
   * Concurrent drains never process the same row: what one claim takes, the
   * other never sees again.
   */
  async drainPending(limit = 50): Promise<{ processed: number; failed: number }> {
    return withSpan("webhook.asaas.drain", { provider: "asaas" }, async () => {
    const claimed = await sql<{
      o_inbox_id: string;
      o_tenant_id: string;
      o_payload_json: unknown;
    }>`select * from platform.inbox_claim(${limit}, ${"asaas"}, ${"drain:asaas"})`.execute(this.requireDb());
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
