import { newId, now } from "@iptv/domain";
import type { Transaction } from "kysely";
import type { Database } from "@iptv/database";
import type { CommandHandlerContext } from "../commands/command-bus.js";
import { kyselyTrxOf } from "../crm/wave2-store.js";
import { UniqueViolationError } from "../trial/trial-store.js";

/**
 * Wave 6 Subscription/Entitlement store accessors (Kysely only).
 *
 * Like the Commerce slice, these commands require a database transaction —
 * there is no in-memory path. Units run against the pure
 * `subscription-policy.ts` helpers; the full flow is covered by the
 * `TEST_DATABASE_URL` integration suite.
 */

export interface SubscriptionRow {
  id: string;
  tenantId: string;
  customerId: string;
  planId: string;
  originatingOrderId: string | null;
  status: string;
  startedAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  cancelledAt: Date | null;
}

export interface CycleRow {
  id: string;
  tenantId: string;
  subscriptionId: string;
  cycleNo: number;
  startsAt: Date;
  endsAt: Date;
  renewalOrderId: string | null;
  status: string;
  baseRevenueMinor: string;
  currency: string;
}

export interface EntitlementRow {
  id: string;
  tenantId: string;
  customerId: string;
  featureKey: string;
  status: string;
  startsAt: Date;
  endsAt: Date | null;
  sourceType: string;
  sourceId: string;
}

function requireTrx(ctx: CommandHandlerContext): Transaction<Database> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("subscription commands require a database transaction");
  }
  return trx;
}

const SUBSCRIPTION_COLUMNS = [
  "id",
  "customer_id",
  "plan_id",
  "originating_order_id",
  "status",
  "started_at",
  "current_period_start",
  "current_period_end",
  "cancel_at_period_end",
  "cancelled_at",
] as const;

type SubscriptionSelect = (typeof SUBSCRIPTION_COLUMNS)[number];

function toSubscriptionRow(
  tenantId: string,
  row: Record<SubscriptionSelect, unknown> & { customer_id: string },
): SubscriptionRow {
  return {
    id: row["id"] as string,
    tenantId,
    customerId: row["customer_id"] as string,
    planId: row["plan_id"] as string,
    originatingOrderId: (row["originating_order_id"] as string | null) ?? null,
    status: row["status"] as string,
    startedAt: (row["started_at"] as Date | null) ?? null,
    currentPeriodStart: (row["current_period_start"] as Date | null) ?? null,
    currentPeriodEnd: (row["current_period_end"] as Date | null) ?? null,
    cancelAtPeriodEnd: (row["cancel_at_period_end"] as boolean) ?? false,
    cancelledAt: (row["cancelled_at"] as Date | null) ?? null,
  };
}

const CYCLE_COLUMNS = [
  "id",
  "subscription_id",
  "cycle_no",
  "starts_at",
  "ends_at",
  "renewal_order_id",
  "status",
  "base_revenue_minor",
  "currency",
] as const;

function toCycleRow(tenantId: string, row: Record<(typeof CYCLE_COLUMNS)[number], unknown>): CycleRow {
  return {
    id: row["id"] as string,
    tenantId,
    subscriptionId: row["subscription_id"] as string,
    cycleNo: Number(row["cycle_no"]),
    startsAt: row["starts_at"] as Date,
    endsAt: row["ends_at"] as Date,
    renewalOrderId: (row["renewal_order_id"] as string | null) ?? null,
    status: row["status"] as string,
    baseRevenueMinor: String(row["base_revenue_minor"]),
    currency: row["currency"] as string,
  };
}

export async function getSubscription(
  ctx: CommandHandlerContext,
  subscriptionId: string,
): Promise<SubscriptionRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("subscription.subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", subscriptionId)
    .executeTakeFirst();
  return row === undefined ? null : toSubscriptionRow(ctx.tenantId, row);
}

export async function getSubscriptionByOrder(
  ctx: CommandHandlerContext,
  orderId: string,
): Promise<SubscriptionRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("subscription.subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("originating_order_id", "=", orderId)
    .executeTakeFirst();
  return row === undefined ? null : toSubscriptionRow(ctx.tenantId, row);
}

export async function insertSubscription(
  ctx: CommandHandlerContext,
  input: {
    customerId: string;
    planId: string;
    originatingOrderId: string;
    periodStart: Date;
    periodEnd: Date;
  },
): Promise<SubscriptionRow> {
  const trx = requireTrx(ctx);
  const id = newId();
  const row = await trx
    .insertInto("subscription.subscriptions")
    .values({
      id,
      tenant_id: ctx.tenantId,
      customer_id: input.customerId,
      plan_id: input.planId,
      originating_order_id: input.originatingOrderId,
      status: "PENDING_ACTIVATION",
      started_at: null,
      current_period_start: input.periodStart,
      current_period_end: input.periodEnd,
      cancel_at_period_end: false,
      cancelled_at: null,
      created_at: now(),
      updated_at: now(),
    })
    .returning(SUBSCRIPTION_COLUMNS)
    .executeTakeFirstOrThrow();
  return toSubscriptionRow(ctx.tenantId, row);
}

export async function updateSubscription(
  ctx: CommandHandlerContext,
  subscriptionId: string,
  patch: Partial<{
    status: string;
    startedAt: Date | null;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    cancelledAt: Date | null;
  }>,
  expectedStatus?: string,
): Promise<SubscriptionRow | null> {
  const trx = requireTrx(ctx);
  let query = trx
    .updateTable("subscription.subscriptions")
    .set({
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.startedAt !== undefined ? { started_at: patch.startedAt } : {}),
      ...(patch.currentPeriodStart !== undefined ? { current_period_start: patch.currentPeriodStart } : {}),
      ...(patch.currentPeriodEnd !== undefined ? { current_period_end: patch.currentPeriodEnd } : {}),
      ...(patch.cancelAtPeriodEnd !== undefined ? { cancel_at_period_end: patch.cancelAtPeriodEnd } : {}),
      ...(patch.cancelledAt !== undefined ? { cancelled_at: patch.cancelledAt } : {}),
      updated_at: now(),
    })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", subscriptionId);
  if (expectedStatus !== undefined) {
    query = query.where("status", "=", expectedStatus);
  }
  const row = await query.returning(SUBSCRIPTION_COLUMNS).executeTakeFirst();
  return row === undefined ? null : toSubscriptionRow(ctx.tenantId, row);
}

export async function getOpenCycle(
  ctx: CommandHandlerContext,
  subscriptionId: string,
): Promise<CycleRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("subscription.subscription_cycles")
    .select(CYCLE_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("subscription_id", "=", subscriptionId)
    .where("status", "in", ["PENDING", "ACTIVE"])
    .orderBy("cycle_no", "desc")
    .executeTakeFirst();
  return row === undefined ? null : toCycleRow(ctx.tenantId, row);
}

export async function insertCycle(
  ctx: CommandHandlerContext,
  input: {
    subscriptionId: string;
    cycleNo: number;
    startsAt: Date;
    endsAt: Date;
    status?: string;
    baseRevenueMinor: string;
    currency: string;
  },
): Promise<CycleRow> {
  const trx = requireTrx(ctx);
  try {
    const row = await trx
      .insertInto("subscription.subscription_cycles")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        subscription_id: input.subscriptionId,
        cycle_no: input.cycleNo,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        renewal_order_id: null,
        status: input.status ?? "PENDING",
        base_revenue_minor: input.baseRevenueMinor,
        base_provider_cost_minor: null,
        currency: input.currency,
        created_at: now(),
      })
      .returning(CYCLE_COLUMNS)
      .executeTakeFirstOrThrow();
    return toCycleRow(ctx.tenantId, row);
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      throw new UniqueViolationError("an open cycle already exists for this subscription");
    }
    throw err;
  }
}

export async function updateCycle(
  ctx: CommandHandlerContext,
  cycleId: string,
  patch: { status: string },
  expectedStatus?: string,
): Promise<CycleRow | null> {
  const trx = requireTrx(ctx);
  let query = trx
    .updateTable("subscription.subscription_cycles")
    .set({ status: patch.status })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", cycleId);
  if (expectedStatus !== undefined) {
    query = query.where("status", "=", expectedStatus);
  }
  const row = await query.returning(CYCLE_COLUMNS).executeTakeFirst();
  return row === undefined ? null : toCycleRow(ctx.tenantId, row);
}

export async function listDueCycles(
  ctx: CommandHandlerContext,
  at: Date,
  limit: number,
): Promise<CycleRow[]> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("subscription.subscription_cycles")
    .select(CYCLE_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("status", "in", ["PENDING", "ACTIVE"])
    .where("ends_at", "<=", at)
    .orderBy("ends_at", "asc")
    .limit(limit)
    .execute();
  return rows.map((row) => toCycleRow(ctx.tenantId, row));
}

export async function listSubscriptions(
  ctx: CommandHandlerContext,
  input: { status?: string; limit: number },
): Promise<SubscriptionRow[]> {
  const trx = requireTrx(ctx);
  let query = trx
    .selectFrom("subscription.subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .orderBy("created_at", "desc")
    .limit(input.limit);
  if (input.status !== undefined) {
    query = query.where("status", "=", input.status);
  }
  const rows = await query.execute();
  return rows.map((row) => toSubscriptionRow(ctx.tenantId, row));
}

export interface SettledOrderPlan {
  orderId: string;
  personId: string;
  customerId: string | null;
  status: string;
  currency: string;
  netMinor: string;
  planId: string;
  planQuantity: string;
}

export async function loadSettledOrderPlan(
  ctx: CommandHandlerContext,
  orderId: string,
): Promise<SettledOrderPlan | null> {
  const trx = requireTrx(ctx);
  const order = await trx
    .selectFrom("commerce.orders")
    .select(["id", "person_id", "customer_id", "status", "currency", "net_amount_minor"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", orderId)
    .executeTakeFirst();
  if (order === undefined) {
    return null;
  }
  const item = await trx
    .selectFrom("commerce.order_items")
    .select(["sellable_id", "quantity"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("order_id", "=", orderId)
    .where("sellable_type", "=", "PLAN")
    .orderBy("created_at", "asc")
    .executeTakeFirst();
  if (item === undefined) {
    return null;
  }
  return {
    orderId: order.id,
    personId: order.person_id,
    customerId: order.customer_id,
    status: order.status,
    currency: order.currency,
    netMinor: String(order.net_amount_minor),
    planId: item.sellable_id,
    planQuantity: String(item.quantity),
  };
}

export interface CatalogPlan {
  id: string;
  planKey: string;
  intervalUnit: string;
  intervalCount: number;
  metadata: Record<string, unknown>;
}

export async function getCatalogPlan(
  ctx: CommandHandlerContext,
  planId: string,
): Promise<CatalogPlan | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("catalog.plans")
    .select(["id", "plan_key", "billing_interval_unit", "billing_interval_count", "status", "metadata_json"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", planId)
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  const metadata =
    row.metadata_json !== null && typeof row.metadata_json === "object" && !Array.isArray(row.metadata_json)
      ? (row.metadata_json as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    planKey: row.plan_key,
    intervalUnit: row.billing_interval_unit,
    intervalCount: Number(row.billing_interval_count),
    metadata,
  };
}

export async function getCustomerForPerson(  ctx: CommandHandlerContext,
  personId: string,
): Promise<{ id: string } | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("crm.customers")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("person_id", "=", personId)
    .executeTakeFirst();
  return row === undefined ? null : { id: row.id };
}

export async function insertEntitlement(
  ctx: CommandHandlerContext,
  input: {
    customerId: string;
    featureKey: string;
    quantity?: string | null;
    startsAt: Date;
    endsAt: Date | null;
    status?: string;
    sourceType: string;
    sourceId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<EntitlementRow> {
  const trx = requireTrx(ctx);
  const entitlementId = newId();
  const row = await trx
    .insertInto("entitlement.entitlements")
    .values({
      id: entitlementId,
      tenant_id: ctx.tenantId,
      customer_id: input.customerId,
      feature_key: input.featureKey,
      status: input.status ?? "PENDING",
      quantity: input.quantity ?? null,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      source_type: input.sourceType,
      source_id: input.sourceId,
      metadata_json: input.metadata ?? {},
      created_at: now(),
      updated_at: now(),
    })
    .returning(["id", "customer_id", "feature_key", "status", "starts_at", "ends_at", "source_type", "source_id"])
    .executeTakeFirstOrThrow();
  return {
    id: row.id,
    tenantId: ctx.tenantId,
    customerId: row.customer_id,
    featureKey: row.feature_key,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    sourceType: row.source_type,
    sourceId: row.source_id,
  };
}

export async function insertGrant(
  ctx: CommandHandlerContext,
  input: {
    entitlementId: string;
    grantType: string;
    startsAt: Date;
    endsAt: Date | null;
    sourceType: string;
    sourceId: string;
  },
): Promise<void> {
  const trx = requireTrx(ctx);
  await trx
    .insertInto("entitlement.entitlement_grants")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      entitlement_id: input.entitlementId,
      grant_type: input.grantType,
      delta_quantity: null,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      source_type: input.sourceType,
      source_id: input.sourceId,
      created_at: now(),
    })
    .execute();
}

export async function listEntitlementsBySource(
  ctx: CommandHandlerContext,
  sourceType: string,
  sourceId: string,
): Promise<EntitlementRow[]> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("entitlement.entitlements")
    .select(["id", "customer_id", "feature_key", "status", "starts_at", "ends_at", "source_type", "source_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("source_type", "=", sourceType)
    .where("source_id", "=", sourceId)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    tenantId: ctx.tenantId,
    customerId: row.customer_id,
    featureKey: row.feature_key,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    sourceType: row.source_type,
    sourceId: row.source_id,
  }));
}

export async function updateEntitlementsStatusBySource(
  ctx: CommandHandlerContext,
  sourceType: string,
  sourceId: string,
  status: string,
): Promise<void> {
  const trx = requireTrx(ctx);
  await trx
    .updateTable("entitlement.entitlements")
    .set({ status, updated_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("source_type", "=", sourceType)
    .where("source_id", "=", sourceId)
    .execute();
}

export async function insertProviderEvidence(
  ctx: CommandHandlerContext,
  input: { operationId: string; evidenceType: string; objectRef?: string | null; structured: Record<string, unknown> },
): Promise<void> {
  const trx = requireTrx(ctx);
  await trx
    .insertInto("provider.provider_evidence")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      provider_operation_id: input.operationId,
      evidence_type: input.evidenceType,
      object_ref: input.objectRef ?? null,
      structured_json: input.structured,
      captured_at: now(),
      classification: "C2",
    })
    .execute();
}

/**
 * Fulfillment provider account (find-or-create placeholder). Mirrors the
 * Wave 4 trial helper: a `secret_ref` placeholder only — real CINEVISION
 * credentials stay Wave-0-gated and never enter this codebase.
 */
export async function ensureFulfillmentProviderAccount(ctx: CommandHandlerContext): Promise<{ id: string }> {
  const trx = requireTrx(ctx);
  let provider = await trx
    .selectFrom("provider.providers")
    .select(["id"])
    .where("provider_key", "=", "cinevision")
    .executeTakeFirst();
  if (provider === undefined) {
    provider = await trx
      .insertInto("provider.providers")
      .values({
        id: newId(),
        provider_key: "cinevision",
        name: "CINEVISION",
        provider_type: "FULFILLMENT",
        status: "ACTIVE",
        created_at: now(),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
  }
  const existing = await trx
    .selectFrom("provider.provider_accounts")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("provider_id", "=", provider.id)
    .where("status", "=", "ACTIVE")
    .orderBy("created_at", "asc")
    .executeTakeFirst();
  if (existing !== undefined) {
    return { id: existing.id };
  }
  const created = await trx
    .insertInto("provider.provider_accounts")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      provider_id: provider.id,
      name: "CINEVISION Fulfillment Placeholder",
      status: "ACTIVE",
      secret_ref: "wave4://no-real-credential",
      settings_json: { synthetic: true },
      last_recharge_at: null,
      created_at: now(),
      updated_at: now(),
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return { id: created.id };
}

/**
 * System-originated customer notification (Wave 6).
 *
 * The notification is a human-visible INTERNAL/SYSTEM record, NOT an
 * automated outbound send: the message row is appended directly and its
 * delivery parks QUEUED behind the manual gateway (a human operator carries
 * it out, exactly like Wave 4 MANUAL provider operations). No real
 * credential ever lands in the body — only a fulfillment reference id.
 */
export async function appendCredentialNotification(
  ctx: CommandHandlerContext,
  input: { personId: string; subscriptionId: string; fulfillmentRef: string },
): Promise<{ messageId: string; conversationId: string }> {
  const trx = requireTrx(ctx);
  const open = await trx
    .selectFrom("communication.conversations")
    .select(["id", "channel"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("person_id", "=", input.personId)
    .where("status", "in", ["OPEN", "AWAITING_CUSTOMER", "AWAITING_INTERNAL"])
    .orderBy("last_message_at", "desc")
    .executeTakeFirst();
  let conversationId: string;
  let channel: string;
  if (open === undefined) {
    conversationId = newId();
    channel = "SYSTEM";
    await trx
      .insertInto("communication.conversations")
      .values({
        id: conversationId,
        tenant_id: ctx.tenantId,
        person_id: input.personId,
        channel,
        external_thread_id: null,
        status: "OPEN",
        control_mode: "HUMAN_CONTROL",
        last_message_at: null,
        created_at: now(),
        updated_at: now(),
        resolved_at: null,
        archived_at: null,
      })
      .execute();
  } else {
    conversationId = open.id;
    channel = open.channel;
  }
  const messageId = newId();
  const occurred = now();
  const body =
    `Sua assinatura está ativa (ref ${input.fulfillmentRef}). ` +
    `Suas credenciais de acesso estão disponíveis com o operador — ` +
    `nenhuma senha é enviada por este canal. Assinatura ${input.subscriptionId}.`;
  await trx
    .insertInto("communication.messages")
    .values({
      id: messageId,
      tenant_id: ctx.tenantId,
      conversation_id: conversationId,
      person_id: input.personId,
      direction: "INTERNAL",
      channel,
      sender_type: "SYSTEM",
      external_message_id: null,
      idempotency_key: `subscription-credentials:${input.subscriptionId}`,
      content_type: "TEXT",
      body_text: body,
      attachment_ref: null,
      metadata_json: { subscription_id: input.subscriptionId, fulfillment_ref: input.fulfillmentRef },
      occurred_at: occurred,
      received_at: null,
      created_at: now(),
    })
    .execute();
  await trx
    .insertInto("communication.message_deliveries")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      message_id: messageId,
      provider: "manual",
      status: "QUEUED",
      attempt_no: 1,
      external_delivery_id: null,
      error_code: null,
      error_detail_json: {},
      occurred_at: now(),
    })
    .execute();
  await trx
    .updateTable("communication.conversations")
    .set({ last_message_at: occurred, updated_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", conversationId)
    .execute();
  return { messageId, conversationId };
}

export async function getPersonIdForCustomer(
  ctx: CommandHandlerContext,
  customerId: string,
): Promise<string | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("crm.customers")
    .select(["person_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", customerId)
    .executeTakeFirst();
  return row === undefined ? null : row.person_id;
}

export interface ActiveSubscriptionAddon {
  addonId: string;
  featureKey: string | null;
  quantity: string;
}
export async function listActiveSubscriptionAddons(
  ctx: CommandHandlerContext,
  subscriptionId: string,
): Promise<ActiveSubscriptionAddon[]> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("subscription.subscription_addons")
    .innerJoin("catalog.addons", (join) =>
      join
        .onRef("catalog.addons.tenant_id", "=", "subscription.subscription_addons.tenant_id")
        .onRef("catalog.addons.id", "=", "subscription.subscription_addons.addon_id"),
    )
    .select([
      "subscription.subscription_addons.addon_id as addon_id",
      "subscription.subscription_addons.quantity as quantity",
      "catalog.addons.entitlement_feature_key as feature_key",
    ])
    .where("subscription.subscription_addons.tenant_id", "=", ctx.tenantId)
    .where("subscription.subscription_addons.subscription_id", "=", subscriptionId)
    .where("subscription.subscription_addons.status", "=", "ACTIVE")
    .execute();
  return rows.map((row) => ({
    addonId: row["addon_id"] as string,
    featureKey: (row["feature_key"] as string | null) ?? null,
    quantity: String(row["quantity"]),
  }));
}

/**
 * Catalog→provider binding record: the existing
 * `provider.provider_bindings` row (`entity_type=subscription`), written
 * once the effect is KNOWN_APPLIED. Insert-on-conflict-do-nothing keeps
 * replays and double resolutions idempotent.
 */
export async function upsertSubscriptionBinding(
  ctx: CommandHandlerContext,
  input: { providerAccountId: string; subscriptionId: string; externalId: string },
): Promise<void> {
  const trx = requireTrx(ctx);
  await trx
    .insertInto("provider.provider_bindings")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      provider_account_id: input.providerAccountId,
      entity_type: "subscription",
      entity_id: input.subscriptionId,
      external_id: input.externalId,
      external_secondary_id: null,
      status: "ACTIVE",
      metadata_json: { via: "fulfillment.request_for_subscription" },
      last_verified_at: now(),
      created_at: now(),
      updated_at: now(),
    })
    .onConflict((oc) =>
      oc.columns(["tenant_id", "provider_account_id", "entity_type", "entity_id"]).doNothing(),
    )
    .execute();
}
