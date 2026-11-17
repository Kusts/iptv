import { withTenantTransaction, type Database } from "@iptv/database";
import type { Kysely } from "kysely";
import type { BotDeliveryState, BotOrderState, BotRenewalInfo } from "./streammax-bot-contract.js";
import { shouldEvaluateConversation } from "../agent/pipeline.js";

export type BotReplyEligibility = "takeover" | "paused" | "not_eligible" | "eligible";

export async function getBotReplyEligibility(db: Kysely<Database>, tenantId: string, conversationId: string): Promise<BotReplyEligibility> {
  return withTenantTransaction(db, tenantId, async (trx) => {
    const conversation = await trx.selectFrom("communication.conversations")
      .select(["status", "control_mode"])
      .where("tenant_id", "=", tenantId).where("id", "=", conversationId)
      .executeTakeFirst();
    if (!conversation) return "not_eligible";
    const decision = shouldEvaluateConversation({ status: conversation.status, controlMode: conversation.control_mode });
    if (decision.evaluate) return "eligible";
    return decision.reason === "takeover" ? "takeover" : decision.reason === "paused" ? "paused" : "not_eligible";
  });
}

export async function isDuplicateInbound(db: Kysely<Database>, tenantId: string, externalMessageId: string): Promise<boolean> {
  return withTenantTransaction(db, tenantId, async (trx) => Boolean(await trx.selectFrom("communication.messages")
    .select(["id"]).where("tenant_id", "=", tenantId).where("external_message_id", "=", externalMessageId)
    .executeTakeFirst()));
}

export async function getOrderState(db: Kysely<Database>, tenantId: string, personId: string, orderId: string): Promise<BotOrderState> {
  return withTenantTransaction(db, tenantId, async (trx) => {
    const order = await trx.selectFrom("commerce.orders as o")
      .select(["o.id as orderId", "o.status", "o.net_amount_minor as netAmountMinor", "o.currency"])
      .where("o.tenant_id", "=", tenantId).where("o.person_id", "=", personId).where("o.id", "=", orderId)
      .executeTakeFirst();
    if (!order) throw new Error("order not found");
    const charge = await trx.selectFrom("billing.charges as c")
      .leftJoin("billing.charge_provider_bindings as b", (join) => join.onRef("b.tenant_id", "=", "c.tenant_id").onRef("b.charge_id", "=", "c.id"))
      .select(["c.id as chargeId", "c.status"])
      .where("c.tenant_id", "=", tenantId).where("c.order_id", "=", orderId)
      .orderBy("c.created_at", "desc").limit(1).executeTakeFirst();
    return {
      order: { orderId: order.orderId, status: order.status, netAmountMinor: BigInt(order.netAmountMinor), currency: order.currency },
      charge: charge ? { chargeId: charge.chargeId, status: charge.status, qrCode: null, effectUncertain: false } : null,
      settled: order.status === "SETTLED",
    };
  });
}

export async function getDeliveryState(db: Kysely<Database>, tenantId: string, personId: string, ref: { orderId?: string; subscriptionId?: string }): Promise<BotDeliveryState> {
  return withTenantTransaction(db, tenantId, async (trx) => {
    if (ref.orderId) {
      const order = await trx.selectFrom("commerce.orders").select(["status"]).where("tenant_id", "=", tenantId).where("person_id", "=", personId).where("id", "=", ref.orderId).executeTakeFirst();
      if (!order) return { status: "ACTION_NEEDED" };
      if (order.status !== "SETTLED") return { status: "AWAITING_PAYMENT" };
      const operation = await trx.selectFrom("provider.provider_operations").select(["status"]).where("tenant_id", "=", tenantId).where("entity_type", "=", "ORDER").where("entity_id", "=", ref.orderId).orderBy("requested_at", "desc").executeTakeFirst();
      if (operation && ["HUMAN_REQUIRED", "VERIFYING"].includes(operation.status)) return { status: "ACTION_NEEDED" };
    }
    if (ref.subscriptionId) {
      const subscription = await trx.selectFrom("subscription.subscriptions as s").innerJoin("crm.customers as c", (join) => join.onRef("c.tenant_id", "=", "s.tenant_id").onRef("c.id", "=", "s.customer_id")).select(["s.status"]).where("s.tenant_id", "=", tenantId).where("c.person_id", "=", personId).where("s.id", "=", ref.subscriptionId).executeTakeFirst();
      if (!subscription) return { status: "ACTION_NEEDED" };
      // Ownership path: subscriptions.customer_id -> customers.id, scoped by tenant_id,
      // then customers.person_id. Provider operations have no person/customer FK,
      // so correlate explicitly by tenant + SUBSCRIPTION entity type + subscription id.
      const operation = await trx.selectFrom("provider.provider_operations").select(["status"]).where("tenant_id", "=", tenantId).where("entity_type", "=", "SUBSCRIPTION").where("entity_id", "=", ref.subscriptionId).orderBy("requested_at", "desc").executeTakeFirst();
      if (subscription.status === "ACTIVE" && operation?.status === "SUCCEEDED") return { status: "ACTIVE" };
      if (operation && ["HUMAN_REQUIRED", "VERIFYING"].includes(operation.status)) return { status: "PAID_AWAITING_OPERATOR" };
    }
    return { status: "ACTION_NEEDED" };
  });
}

export async function getRenewalInfo(db: Kysely<Database>, tenantId: string, personId: string): Promise<BotRenewalInfo> {
  return withTenantTransaction(db, tenantId, async (trx) => {
    const row = await trx.selectFrom("subscription.subscriptions as s").innerJoin("crm.customers as c", (join) => join.onRef("c.tenant_id", "=", "s.tenant_id").onRef("c.id", "=", "s.customer_id")).select(["s.status", "s.current_period_end as currentPeriodEnd"]).where("s.tenant_id", "=", tenantId).where("c.person_id", "=", personId).orderBy("s.created_at", "desc").executeTakeFirst();
    return row ? { status: row.status, currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null } : null;
  });
}
