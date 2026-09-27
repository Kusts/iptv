import { sql, type Transaction } from "kysely";
import { newId, now } from "@iptv/domain";
import type { Database } from "@iptv/database";
import type { CommandHandlerContext } from "../commands/command-bus.js";
import { emitAndEnqueue, kyselyTrxOf } from "../crm/wave2-store.js";
import { UniqueViolationError } from "../trial/trial-store.js";
import {
  getOpenCycle,
  getSubscription,
  insertCycle,
  updateEntitlementsStatusBySource,
  updateSubscription,
  type CycleRow,
} from "../subscription/subscription-store.js";
import { renewalReminderKey } from "./renewal-policy.js";

/**
 * Wave 9 Renewal + Retention store accessors (Kysely only).
 *
 * Like the Subscription slice, these commands require a database
 * transaction — there is no in-memory path. Units run against the pure
 * `renewal-policy.ts` helpers; the full flow is covered by the
 * `TEST_DATABASE_URL` integration suite.
 *
 * Storage reuse (no new columns for the renewal link itself):
 * - The renewal order ↔ subscription link rides on the existing
 *   `subscription_cycles.renewal_order_id` of the CURRENT (prior) cycle.
 * - Renewal reminders ride on `communication.messages.idempotency_key`
 *   (`renewal-reminder:{subscription}:{cycle}`, existing partial unique
 *   index) as system-originated INTERNAL records — never automated outbound.
 * - New in migration 020: `renewal.recovery_tasks` (human-worked winback
 *   queue) and `subscription.trust_renewal_grants` (once-per-cycle ledger).
 */

function requireTrx(ctx: CommandHandlerContext): Transaction<Database> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("renewal commands require a database transaction");
  }
  return trx;
}

export async function advisoryLockSubscription(
  trx: Transaction<Database>,
  subscriptionId: string,
): Promise<void> {
  // Per-subscription serialization: concurrent quote/renew/trust/expiry for
  // the SAME subscription queue here; different subscriptions never block.
  await sql`SELECT pg_advisory_xact_lock(hashtext(${"renewal:" + subscriptionId}))`.execute(trx);
}

export async function getCycle(
  ctx: CommandHandlerContext,
  cycleId: string,
): Promise<CycleRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("subscription.subscription_cycles")
    .select([
      "id",
      "subscription_id",
      "cycle_no",
      "starts_at",
      "ends_at",
      "renewal_order_id",
      "status",
      "base_revenue_minor",
      "currency",
    ])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", cycleId)
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    tenantId: ctx.tenantId,
    subscriptionId: row.subscription_id,
    cycleNo: Number(row.cycle_no),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    renewalOrderId: row.renewal_order_id,
    status: row.status,
    baseRevenueMinor: String(row.base_revenue_minor),
    currency: row.currency,
  };
}

export async function listCycles(
  ctx: CommandHandlerContext,
  subscriptionId: string,
): Promise<CycleRow[]> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("subscription.subscription_cycles")
    .select([
      "id",
      "subscription_id",
      "cycle_no",
      "starts_at",
      "ends_at",
      "renewal_order_id",
      "status",
      "base_revenue_minor",
      "currency",
    ])
    .where("tenant_id", "=", ctx.tenantId)
    .where("subscription_id", "=", subscriptionId)
    .orderBy("cycle_no", "asc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    tenantId: ctx.tenantId,
    subscriptionId: row.subscription_id,
    cycleNo: Number(row.cycle_no),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    renewalOrderId: row.renewal_order_id,
    status: row.status,
    baseRevenueMinor: String(row.base_revenue_minor),
    currency: row.currency,
  }));
}

/** Prior cycle carrying a renewal-order link (the `subscription.renew` entry point). */
export async function getCycleByRenewalOrder(
  ctx: CommandHandlerContext,
  orderId: string,
): Promise<CycleRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("subscription.subscription_cycles")
    .select([
      "id",
      "subscription_id",
      "cycle_no",
      "starts_at",
      "ends_at",
      "renewal_order_id",
      "status",
      "base_revenue_minor",
      "currency",
    ])
    .where("tenant_id", "=", ctx.tenantId)
    .where("renewal_order_id", "=", orderId)
    .orderBy("cycle_no", "asc")
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    tenantId: ctx.tenantId,
    subscriptionId: row.subscription_id,
    cycleNo: Number(row.cycle_no),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    renewalOrderId: row.renewal_order_id,
    status: row.status,
    baseRevenueMinor: String(row.base_revenue_minor),
    currency: row.currency,
  };
}

export async function setCycleRenewalOrder(
  ctx: CommandHandlerContext,
  cycleId: string,
  orderId: string | null,
): Promise<void> {
  const trx = requireTrx(ctx);
  await trx
    .updateTable("subscription.subscription_cycles")
    .set({ renewal_order_id: orderId })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", cycleId)
    .execute();
}

/** Extend an OPEN cycle's end (trust renewal only — closed cycles are never mutated). */
export async function extendOpenCycle(
  ctx: CommandHandlerContext,
  cycleId: string,
  newEndsAt: Date,
): Promise<CycleRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .updateTable("subscription.subscription_cycles")
    .set({ ends_at: newEndsAt })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", cycleId)
    .where("status", "in", ["PENDING", "ACTIVE"])
    .returning([
      "id",
      "subscription_id",
      "cycle_no",
      "starts_at",
      "ends_at",
      "renewal_order_id",
      "status",
      "base_revenue_minor",
      "currency",
    ])
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    tenantId: ctx.tenantId,
    subscriptionId: row.subscription_id,
    cycleNo: Number(row.cycle_no),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    renewalOrderId: row.renewal_order_id,
    status: row.status,
    baseRevenueMinor: String(row.base_revenue_minor),
    currency: row.currency,
  };
}

export interface RenewalOrderRow {
  id: string;
  personId: string;
  customerId: string | null;
  orderType: string;
  status: string;
  netMinor: string;
  currency: string;
}

export async function getOrder(
  ctx: CommandHandlerContext,
  orderId: string,
): Promise<RenewalOrderRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("commerce.orders")
    .select(["id", "person_id", "customer_id", "order_type", "status", "net_amount_minor", "currency"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", orderId)
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    personId: row.person_id,
    customerId: row.customer_id,
    orderType: row.order_type,
    status: row.status,
    netMinor: String(row.net_amount_minor),
    currency: row.currency,
  };
}

export interface ActivePlanPrice {
  priceId: string;
  amountMinor: string;
  currency: string;
}

/** CURRENT catalog price snapshot source for the subscription's plan (Wave 5 discipline). */
export async function getActivePlanPrice(
  ctx: CommandHandlerContext,
  planId: string,
  at: Date,
): Promise<ActivePlanPrice | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("catalog.prices")
    .select(["id", "amount_minor", "currency"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("sellable_type", "=", "PLAN")
    .where("sellable_id", "=", planId)
    .where("status", "=", "ACTIVE")
    .where("starts_at", "<=", at)
    .where((eb) => eb.or([eb("ends_at", "is", null), eb("ends_at", ">", at)]))
    .orderBy("starts_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  return { priceId: row.id, amountMinor: String(row.amount_minor), currency: row.currency };
}

/**
 * Create the renewal order (subscription-shaped RENEWAL order → submitted to
 * AWAITING_PAYMENT) priced from the CURRENT catalog price with an immutable
 * price snapshot per line. Emits the registry-listed `order.created.v1`
 * (submit itself stays audit-only: `commerce.order.awaiting_payment` has no
 * public v1 — known registry gap).
 */
export async function createRenewalOrder(
  ctx: CommandHandlerContext,
  input: {
    personId: string;
    customerId: string;
    planId: string;
    unitMinor: string;
    currency: string;
    priceId: string;
  },
): Promise<RenewalOrderRow> {
  const trx = requireTrx(ctx);
  const at = now();
  const orderId = newId();
  await trx
    .insertInto("commerce.orders")
    .values({
      id: orderId,
      tenant_id: ctx.tenantId,
      person_id: input.personId,
      customer_id: input.customerId,
      source_offer_id: null,
      order_type: "RENEWAL",
      status: "DRAFT",
      currency: input.currency,
      gross_amount_minor: input.unitMinor,
      discount_amount_minor: "0",
      reward_amount_minor: "0",
      net_amount_minor: input.unitMinor,
      settled_amount_minor: "0",
      created_at: at,
      awaiting_payment_at: null,
      settled_at: null,
      cancelled_at: null,
      expires_at: null,
    })
    .execute();
  const itemId = newId();
  await trx
    .insertInto("commerce.order_items")
    .values({
      id: itemId,
      tenant_id: ctx.tenantId,
      order_id: orderId,
      item_type: "BASE_PLAN",
      sellable_type: "PLAN",
      sellable_id: input.planId,
      quantity: "1",
      unit_price_minor: input.unitMinor,
      gross_minor: input.unitMinor,
      discount_minor: "0",
      reward_minor: "0",
      net_minor: input.unitMinor,
      metadata_json: { renewal: true },
      created_at: at,
    })
    .execute();
  await trx
    .insertInto("commerce.price_snapshots")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      order_item_id: itemId,
      sale_price_minor: input.unitMinor,
      supplier_cost_minor: null,
      currency: input.currency,
      price_source_ref: `catalog.prices:${input.priceId}`,
      captured_at: at,
      context_json: { quantity: 1, renewal: true },
    })
    .execute();
  await trx
    .updateTable("commerce.orders")
    .set({ status: "AWAITING_PAYMENT", awaiting_payment_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", orderId)
    .where("status", "=", "DRAFT")
    .execute();
  await emitAndEnqueue(ctx, {
    eventType: "order.created.v1",
    aggregateType: "order",
    aggregateId: orderId,
    data: {
      order_id: orderId,
      person_id: input.personId,
      order_type: "RENEWAL",
      net_amount_minor: input.unitMinor,
      currency: input.currency,
    },
  });
  const created = await getOrder(ctx, orderId);
  if (created === null) {
    throw new Error("renewal order vanished after insert");
  }
  return created;
}

/** Worker-seam candidates: ACTIVE subscriptions whose open cycle ends inside a window. */
export interface RenewalCandidate {
  subscriptionId: string;
  customerId: string;
  planId: string;
  cycleId: string;
  cycleNo: number;
  cycleEnd: Date;
}

export async function listRenewalWindowCandidates(
  ctx: CommandHandlerContext,
  input: { from: Date; to: Date; limit: number },
): Promise<RenewalCandidate[]> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("subscription.subscriptions")
    .innerJoin("subscription.subscription_cycles", (join) =>
      join
        .onRef("subscription.subscription_cycles.tenant_id", "=", "subscription.subscriptions.tenant_id")
        .onRef(
          "subscription.subscription_cycles.subscription_id",
          "=",
          "subscription.subscriptions.id",
        ),
    )
    .select([
      "subscription.subscriptions.id as subscription_id",
      "subscription.subscriptions.customer_id as customer_id",
      "subscription.subscriptions.plan_id as plan_id",
      "subscription.subscription_cycles.id as cycle_id",
      "subscription.subscription_cycles.cycle_no as cycle_no",
      "subscription.subscription_cycles.ends_at as cycle_end",
    ])
    .where("subscription.subscriptions.tenant_id", "=", ctx.tenantId)
    .where("subscription.subscriptions.status", "=", "ACTIVE")
    .where("subscription.subscription_cycles.status", "in", ["PENDING", "ACTIVE"])
    .where("subscription.subscription_cycles.ends_at", ">=", input.from)
    .where("subscription.subscription_cycles.ends_at", "<=", input.to)
    .orderBy("subscription.subscription_cycles.ends_at", "asc")
    .limit(input.limit)
    .execute();
  return rows.map((row) => ({
    subscriptionId: row["subscription_id"] as string,
    customerId: row["customer_id"] as string,
    planId: row["plan_id"] as string,
    cycleId: row["cycle_id"] as string,
    cycleNo: Number(row["cycle_no"]),
    cycleEnd: row["cycle_end"] as Date,
  }));
}

/** Overdue candidates: ACTIVE subscriptions whose open cycle ended before `before`. */
export async function listOverdueCandidates(
  ctx: CommandHandlerContext,
  input: { before: Date; limit: number },
): Promise<RenewalCandidate[]> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("subscription.subscriptions")
    .innerJoin("subscription.subscription_cycles", (join) =>
      join
        .onRef("subscription.subscription_cycles.tenant_id", "=", "subscription.subscriptions.tenant_id")
        .onRef(
          "subscription.subscription_cycles.subscription_id",
          "=",
          "subscription.subscriptions.id",
        ),
    )
    .select([
      "subscription.subscriptions.id as subscription_id",
      "subscription.subscriptions.customer_id as customer_id",
      "subscription.subscriptions.plan_id as plan_id",
      "subscription.subscription_cycles.id as cycle_id",
      "subscription.subscription_cycles.cycle_no as cycle_no",
      "subscription.subscription_cycles.ends_at as cycle_end",
    ])
    .where("subscription.subscriptions.tenant_id", "=", ctx.tenantId)
    .where("subscription.subscriptions.status", "=", "ACTIVE")
    .where("subscription.subscription_cycles.status", "in", ["PENDING", "ACTIVE"])
    .where("subscription.subscription_cycles.ends_at", "<=", input.before)
    .orderBy("subscription.subscription_cycles.ends_at", "asc")
    .limit(input.limit)
    .execute();
  return rows.map((row) => ({
    subscriptionId: row["subscription_id"] as string,
    customerId: row["customer_id"] as string,
    planId: row["plan_id"] as string,
    cycleId: row["cycle_id"] as string,
    cycleNo: Number(row["cycle_no"]),
    cycleEnd: row["cycle_end"] as Date,
  }));
}

/**
 * System-originated renewal reminder: an INTERNAL/SYSTEM message record with
 * a QUEUED manual delivery — the same shape as the Wave 6 credential
 * notification. NOT automated outbound: a human operator carries it out.
 * Idempotent per cycle via `renewal-reminder:{subscription}:{cycle}`.
 */
export async function appendRenewalReminder(
  ctx: CommandHandlerContext,
  input: { personId: string; subscriptionId: string; cycleId: string; cycleEnd: Date },
): Promise<{ messageId: string; conversationId: string; duplicate: boolean }> {
  const trx = requireTrx(ctx);
  const key = renewalReminderKey(input.subscriptionId, input.cycleId);
  const existing = await trx
    .selectFrom("communication.messages")
    .select(["id", "conversation_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("idempotency_key", "=", key)
    .executeTakeFirst();
  if (existing !== undefined) {
    return { messageId: existing.id, conversationId: existing.conversation_id, duplicate: true };
  }
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
  try {
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
        idempotency_key: key,
        content_type: "TEXT",
        body_text:
          `Sua assinatura vence em ${input.cycleEnd.toISOString()}. ` +
          `Renove para manter o acesso sem interrupção. Assinatura ${input.subscriptionId}.`,
        attachment_ref: null,
        metadata_json: {
          subscription_id: input.subscriptionId,
          cycle_id: input.cycleId,
          kind: "renewal_reminder",
        },
        occurred_at: occurred,
        received_at: null,
        created_at: now(),
      })
      .execute();
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      const raced = await trx
        .selectFrom("communication.messages")
        .select(["id", "conversation_id"])
        .where("tenant_id", "=", ctx.tenantId)
        .where("idempotency_key", "=", key)
        .executeTakeFirstOrThrow();
      return { messageId: raced.id, conversationId: raced.conversation_id, duplicate: true };
    }
    throw err;
  }
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
  return { messageId, conversationId, duplicate: false };
}

export interface TrustGrantRow {
  id: string;
  subscriptionId: string;
  cycleId: string;
  extensionDays: number;
  previousEndsAt: Date;
  newEndsAt: Date;
  reviewRequestId: string | null;
}

export async function getTrustGrantForCycle(
  ctx: CommandHandlerContext,
  cycleId: string,
): Promise<TrustGrantRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("subscription.trust_renewal_grants")
    .select([
      "id",
      "subscription_id",
      "cycle_id",
      "extension_days",
      "previous_ends_at",
      "new_ends_at",
      "review_request_id",
    ])
    .where("tenant_id", "=", ctx.tenantId)
    .where("cycle_id", "=", cycleId)
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    cycleId: row.cycle_id,
    extensionDays: Number(row.extension_days),
    previousEndsAt: row.previous_ends_at,
    newEndsAt: row.new_ends_at,
    reviewRequestId: row.review_request_id,
  };
}

export async function insertTrustGrant(
  ctx: CommandHandlerContext,
  input: {
    subscriptionId: string;
    cycleId: string;
    extensionDays: number;
    previousEndsAt: Date;
    newEndsAt: Date;
    reviewRequestId: string | null;
    grantedBy: string | null;
  },
): Promise<TrustGrantRow> {
  const trx = requireTrx(ctx);
  try {
    const row = await trx
      .insertInto("subscription.trust_renewal_grants")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        subscription_id: input.subscriptionId,
        cycle_id: input.cycleId,
        extension_days: input.extensionDays,
        previous_ends_at: input.previousEndsAt,
        new_ends_at: input.newEndsAt,
        review_request_id: input.reviewRequestId,
        granted_by: input.grantedBy,
        created_at: now(),
      })
      .returning([
        "id",
        "subscription_id",
        "cycle_id",
        "extension_days",
        "previous_ends_at",
        "new_ends_at",
        "review_request_id",
      ])
      .executeTakeFirstOrThrow();
    return {
      id: row.id,
      subscriptionId: row.subscription_id,
      cycleId: row.cycle_id,
      extensionDays: Number(row.extension_days),
      previousEndsAt: row.previous_ends_at,
      newEndsAt: row.new_ends_at,
      reviewRequestId: row.review_request_id,
    };
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      throw new UniqueViolationError("a trust renewal grant already exists for this cycle");
    }
    throw err;
  }
}

export interface RecoveryTaskRow {
  id: string;
  subscriptionId: string;
  cycleId: string | null;
  renewalOrderId: string | null;
  reason: string;
  status: string;
  outcome: string | null;
}

function toRecoveryRow(
  row: {
    id: string;
    subscription_id: string;
    cycle_id: string | null;
    renewal_order_id: string | null;
    reason: string;
    status: string;
    outcome: string | null;
  },
): RecoveryTaskRow {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    cycleId: row.cycle_id,
    renewalOrderId: row.renewal_order_id,
    reason: row.reason,
    status: row.status,
    outcome: row.outcome,
  };
}

export async function insertRecoveryTask(
  ctx: CommandHandlerContext,
  input: { subscriptionId: string; cycleId: string | null; renewalOrderId: string | null; reason: string },
): Promise<RecoveryTaskRow> {
  const trx = requireTrx(ctx);
  const at = now();
  const row = await trx
    .insertInto("renewal.recovery_tasks")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      subscription_id: input.subscriptionId,
      cycle_id: input.cycleId,
      renewal_order_id: input.renewalOrderId,
      reason: input.reason,
      status: "OPEN",
      outcome: null,
      resolved_by: null,
      created_at: at,
      updated_at: at,
      resolved_at: null,
    })
    .returning(["id", "subscription_id", "cycle_id", "renewal_order_id", "reason", "status", "outcome"])
    .executeTakeFirstOrThrow();
  return toRecoveryRow(row);
}

export async function getRecoveryTask(
  ctx: CommandHandlerContext,
  taskId: string,
): Promise<RecoveryTaskRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("renewal.recovery_tasks")
    .select(["id", "subscription_id", "cycle_id", "renewal_order_id", "reason", "status", "outcome"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", taskId)
    .executeTakeFirst();
  return row === undefined ? null : toRecoveryRow(row);
}

export async function resolveRecoveryTask(
  ctx: CommandHandlerContext,
  input: { taskId: string; outcome: string; resolvedBy: string | null },
): Promise<RecoveryTaskRow | null> {
  const trx = requireTrx(ctx);
  const at = now();
  const row = await trx
    .updateTable("renewal.recovery_tasks")
    .set({
      status: "RESOLVED",
      outcome: input.outcome,
      resolved_by: input.resolvedBy,
      resolved_at: at,
      updated_at: at,
    })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.taskId)
    .where("status", "=", "OPEN")
    .returning(["id", "subscription_id", "cycle_id", "renewal_order_id", "reason", "status", "outcome"])
    .executeTakeFirst();
  return row === undefined ? null : toRecoveryRow(row);
}

export async function listRecoveryTasks(
  ctx: CommandHandlerContext,
  input: { subscriptionId?: string; status?: string; limit: number },
): Promise<RecoveryTaskRow[]> {
  const trx = requireTrx(ctx);
  let query = trx
    .selectFrom("renewal.recovery_tasks")
    .select(["id", "subscription_id", "cycle_id", "renewal_order_id", "reason", "status", "outcome"])
    .where("tenant_id", "=", ctx.tenantId)
    .orderBy("created_at", "desc")
    .limit(input.limit);
  if (input.subscriptionId !== undefined) {
    query = query.where("subscription_id", "=", input.subscriptionId);
  }
  if (input.status !== undefined) {
    query = query.where("status", "=", input.status);
  }
  const rows = await query.execute();
  return rows.map(toRecoveryRow);
}

/** Open (undecided) trust-renewal review for a cycle, if any. */
export async function findOpenTrustReview(
  ctx: CommandHandlerContext,
  cycleId: string,
): Promise<{ id: string; requestedById: string | null } | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("agent.human_review_requests")
    .select(["id", "requested_by_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("resource_type", "=", "subscription_trust_renewal")
    .where("resource_id", "=", cycleId)
    .where("status", "in", ["REQUESTED", "QUEUED", "ACKNOWLEDGED", "IN_REVIEW"])
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  return { id: row.id, requestedById: row.requested_by_id };
}

/**
 * Approval evidence for a trust grant: the review must be RESOLVED for THIS
 * cycle and carry an APPROVE action by someone other than the requester
 * (requester≠approver enforced here — the generic refund revalidator passes
 * non-refund reviews through untouched).
 */
export async function approvedTrustReview(
  ctx: CommandHandlerContext,
  reviewId: string,
  cycleId: string,
): Promise<{ approved: boolean; reason: string }> {
  const trx = requireTrx(ctx);
  const request = await trx
    .selectFrom("agent.human_review_requests")
    .select(["id", "status", "resource_type", "resource_id", "requested_by_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", reviewId)
    .executeTakeFirst();
  if (request === undefined) {
    return { approved: false, reason: "review request not found in this tenant" };
  }
  if (request.resource_type !== "subscription_trust_renewal" || request.resource_id !== cycleId) {
    return { approved: false, reason: "review does not approve trust renewal for this cycle" };
  }
  if (request.status !== "RESOLVED") {
    return { approved: false, reason: `review is ${request.status}; trust renewal requires a resolved approval` };
  }
  const approvals = await trx
    .selectFrom("agent.human_review_actions")
    .select(["actor_user_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("human_review_request_id", "=", reviewId)
    .where("action_type", "=", "APPROVE")
    .execute();
  if (approvals.length === 0) {
    return { approved: false, reason: "review carries no human approval" };
  }
  const selfApproved = approvals.some((a) => a.actor_user_id === request.requested_by_id);
  const otherApproval = approvals.some((a) => a.actor_user_id !== request.requested_by_id);
  if (!otherApproval) {
    void selfApproved;
    return { approved: false, reason: "self-approval rejected: approver must differ from the requester" };
  }
  return { approved: true, reason: "approved" };
}

export { getOpenCycle, getSubscription, insertCycle, updateEntitlementsStatusBySource, updateSubscription };

export interface RenewedEntitlement {
  id: string;
}

/**
 * Renewal entitlement refresh: existing subscription-source entitlements
 * move to the new cycle window as ACTIVE (continuity, not a new access
 * grant — the customer relationship never lapsed). Callers append one
 * RENEWAL grant row per entitlement (append-only history preserved).
 * Never touches closed cycles or the ledger.
 */
export async function reopenEntitlementsForRenewal(
  ctx: CommandHandlerContext,
  input: { subscriptionId: string; startsAt: Date; endsAt: Date },
): Promise<RenewedEntitlement[]> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .updateTable("entitlement.entitlements")
    .set({ status: "ACTIVE", starts_at: input.startsAt, ends_at: input.endsAt, updated_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("source_type", "=", "subscription")
    .where("source_id", "=", input.subscriptionId)
    .returning(["id"])
    .execute();
  return rows.map((row) => ({ id: row.id }));
}

/** Trust-renewal extension: push subscription-source entitlement ends forward. */
export async function extendEntitlementsEndsAt(
  ctx: CommandHandlerContext,
  input: { subscriptionId: string; endsAt: Date },
): Promise<void> {
  const trx = requireTrx(ctx);
  await trx
    .updateTable("entitlement.entitlements")
    .set({ ends_at: input.endsAt, updated_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("source_type", "=", "subscription")
    .where("source_id", "=", input.subscriptionId)
    .execute();
}
