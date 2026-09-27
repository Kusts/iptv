import { z } from "zod";
import { newId, now } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { emitAndEnqueue, kyselyTrxOf } from "../crm/wave2-store.js";
import type { Transaction } from "kysely";
import type { Database } from "@iptv/database";
import { isOrderTransition, lineGross, sumMinors, toMinor } from "./money-math.js";

/**
 * Wave 5 Commerce slice (owning context for Offer/Order economics).
 *
 * Canonical rules enforced here:
 * - Order = economic obligation. `DRAFT → AWAITING_PAYMENT → SETTLED`;
 *   `SETTLED` means the obligation is satisfied, NOT fulfillment.
 * - `offer.quote` builds a DRAFT order from catalog prices with an IMMUTABLE
 *   `price_snapshots` copy per line (one per order item, never rewritten).
 * - Only the settlement service (billing) may move an order to SETTLED —
 *   there is deliberately NO `order.settle` command here.
 * - Events are registry-listed ONLY: `order.created|cancelled|expired.v1`
 *   and (via billing) `order.settled.v1`. `order.submit` is audit-only:
 *   `commerce.order.awaiting_payment` has no public v1 (known registry gap).
 * - Money is exact: integer minor units as `bigint` in code, exact decimal
 *   strings in storage. No float/number money arithmetic anywhere.
 */

export const ORDER_TYPES = ["NEW_SUBSCRIPTION", "RENEWAL", "ADDON", "APP", "MIXED", "ADJUSTMENT"] as const;
export const SELLABLE_TYPES = ["PRODUCT", "PLAN", "ADDON"] as const;

export const quoteItemInput = z.object({
  sellableType: z.enum(SELLABLE_TYPES),
  sellableId: z.string().uuid(),
  /** v1 supports integer quantities only — exact `unit × qty`, never float. */
  quantity: z.number().int().positive().max(1000),
});

export const offerQuoteInput = z.object({
  personId: z.string().uuid(),
  items: z.array(quoteItemInput).min(1).max(50),
  orderType: z.enum(ORDER_TYPES).default("NEW_SUBSCRIPTION"),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});

export type OfferQuoteInput = z.infer<typeof offerQuoteInput>;

export const orderIdInput = z.object({ orderId: z.string().uuid() });
export type OrderIdInput = z.infer<typeof orderIdInput>;

export const orderCancelInput = z.object({
  orderId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type OrderCancelInput = z.infer<typeof orderCancelInput>;

export const expireDueInput = z.object({ limit: z.number().int().min(1).max(1000).default(100) });
export type ExpireDueInput = z.infer<typeof expireDueInput>;

function requireTrx(ctx: CommandHandlerContext): Transaction<Database> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("commerce commands require a database transaction");
  }
  return trx;
}

async function personExists(trx: Transaction<Database>, tenantId: string, personId: string): Promise<boolean> {
  const row = await trx
    .selectFrom("identity.persons")
    .select(["id"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", personId)
    .executeTakeFirst();
  return row !== undefined;
}

async function sellableActive(
  trx: Transaction<Database>,
  tenantId: string,
  sellableType: "PRODUCT" | "PLAN" | "ADDON",
  sellableId: string,
): Promise<boolean> {
  if (sellableType === "PRODUCT") {
    const row = await trx
      .selectFrom("catalog.products")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", sellableId)
      .where("status", "=", "ACTIVE")
      .executeTakeFirst();
    return row !== undefined;
  }
  if (sellableType === "PLAN") {
    const row = await trx
      .selectFrom("catalog.plans")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", sellableId)
      .where("status", "=", "ACTIVE")
      .executeTakeFirst();
    return row !== undefined;
  }
  const row = await trx
    .selectFrom("catalog.addons")
    .select(["id"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", sellableId)
    .where("status", "=", "ACTIVE")
    .executeTakeFirst();
  return row !== undefined;
}

async function activePrice(
  trx: Transaction<Database>,
  tenantId: string,
  sellableType: string,
  sellableId: string,
  at: Date,
): Promise<{ id: string; amountMinor: bigint; currency: string } | null> {
  const row = await trx
    .selectFrom("catalog.prices")
    .select(["id", "amount_minor", "currency"])
    .where("tenant_id", "=", tenantId)
    .where("sellable_type", "=", sellableType)
    .where("sellable_id", "=", sellableId)
    .where("status", "=", "ACTIVE")
    .where("starts_at", "<=", at)
    .where((eb) => eb.or([eb("ends_at", "is", null), eb("ends_at", ">", at)]))
    .orderBy("starts_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  return { id: row.id, amountMinor: toMinor(row.amount_minor), currency: row.currency };
}

async function emitOrder(
  ctx: CommandHandlerContext,
  input: { eventType: string; orderId: string; data: Record<string, unknown> },
): Promise<void> {
  await emitAndEnqueue(ctx, {
    eventType: input.eventType,
    aggregateType: "order",
    aggregateId: input.orderId,
    data: { order_id: input.orderId, ...input.data },
  });
}

async function handleQuote(
  ctx: CommandHandlerContext,
  input: OfferQuoteInput,
): Promise<CommandResult<{ id: string; status: string; netAmountMinor: string; currency: string }>> {
  const trx = requireTrx(ctx);
  if (!(await personExists(trx, ctx.tenantId, input.personId))) {
    return { ok: false, code: "not_found", message: "person not found in this tenant" };
  }
  const at = new Date();
  const lines: Array<{
    sellableType: "PRODUCT" | "PLAN" | "ADDON";
    sellableId: string;
    quantity: number;
    unitMinor: bigint;
    grossMinor: bigint;
    priceId: string;
  }> = [];
  let currency: string | null = input.currency ?? null;
  for (const item of input.items) {
    if (!(await sellableActive(trx, ctx.tenantId, item.sellableType, item.sellableId))) {
      return {
        ok: false,
        code: "validation_failed",
        message: `sellable ${item.sellableType}/${item.sellableId} is not ACTIVE in this tenant`,
      };
    }
    const price = await activePrice(trx, ctx.tenantId, item.sellableType, item.sellableId, at);
    if (price === null) {
      return {
        ok: false,
        code: "validation_failed",
        message: `no active price for ${item.sellableType}/${item.sellableId}`,
      };
    }
    if (currency === null) {
      currency = price.currency;
    } else if (currency !== price.currency) {
      return {
        ok: false,
        code: "validation_failed",
        message: `mixed currencies in one order: ${currency} vs ${price.currency}`,
      };
    }
    lines.push({
      sellableType: item.sellableType,
      sellableId: item.sellableId,
      quantity: item.quantity,
      unitMinor: price.amountMinor,
      grossMinor: lineGross(price.amountMinor, item.quantity),
      priceId: price.id,
    });
  }
  const resolvedCurrency = currency as string;
  const grossMinor = sumMinors(lines.map((l) => l.grossMinor));
  const orderId = newId();
  await trx
    .insertInto("commerce.orders")
    .values({
      id: orderId,
      tenant_id: ctx.tenantId,
      person_id: input.personId,
      customer_id: null,
      source_offer_id: null,
      order_type: input.orderType,
      status: "DRAFT",
      currency: resolvedCurrency,
      gross_amount_minor: grossMinor.toString(),
      discount_amount_minor: "0",
      reward_amount_minor: "0",
      net_amount_minor: grossMinor.toString(),
      settled_amount_minor: "0",
      created_at: at,
      awaiting_payment_at: null,
      settled_at: null,
      cancelled_at: null,
      expires_at: input.expiresAt !== undefined ? new Date(input.expiresAt) : null,
    })
    .execute();
  for (const line of lines) {
    const itemId = newId();
    await trx
      .insertInto("commerce.order_items")
      .values({
        id: itemId,
        tenant_id: ctx.tenantId,
        order_id: orderId,
        item_type: line.sellableType === "PLAN" ? "BASE_PLAN" : "OTHER",
        sellable_type: line.sellableType,
        sellable_id: line.sellableId,
        quantity: line.quantity.toString(),
        unit_price_minor: line.unitMinor.toString(),
        gross_minor: line.grossMinor.toString(),
        discount_minor: "0",
        reward_minor: "0",
        net_minor: line.grossMinor.toString(),
        metadata_json: {},
        created_at: at,
      })
      .execute();
    // Immutable price copy: written once with the order, never updated.
    await trx
      .insertInto("commerce.price_snapshots")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        order_item_id: itemId,
        sale_price_minor: line.unitMinor.toString(),
        supplier_cost_minor: null,
        currency: resolvedCurrency,
        price_source_ref: `catalog.prices:${line.priceId}`,
        captured_at: at,
        context_json: { quantity: line.quantity },
      })
      .execute();
  }
  await emitOrder(ctx, {
    eventType: "order.created.v1",
    orderId,
    data: {
      person_id: input.personId,
      order_type: input.orderType,
      net_amount_minor: grossMinor.toString(),
      currency: resolvedCurrency,
    },
  });
  return {
    ok: true,
    data: { id: orderId, status: "DRAFT", netAmountMinor: grossMinor.toString(), currency: resolvedCurrency },
  };
}

async function loadOrderForUpdate(
  trx: Transaction<Database>,
  tenantId: string,
  orderId: string,
): Promise<{ id: string; personId: string; status: string; netMinor: bigint; currency: string } | null> {
  const row = await trx
    .selectFrom("commerce.orders")
    .select(["id", "person_id", "status", "net_amount_minor", "currency"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", orderId)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    personId: row.person_id,
    status: row.status,
    netMinor: toMinor(row.net_amount_minor),
    currency: row.currency,
  };
}

async function handleSubmit(
  ctx: CommandHandlerContext,
  input: OrderIdInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const trx = requireTrx(ctx);
  const order = await loadOrderForUpdate(trx, ctx.tenantId, input.orderId);
  if (order === null) {
    return { ok: false, code: "not_found", message: "order not found in this tenant" };
  }
  if (!isOrderTransition(order.status, "AWAITING_PAYMENT")) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `order is ${order.status}; only DRAFT orders submit`,
    };
  }
  const at = now();
  await trx
    .updateTable("commerce.orders")
    .set({ status: "AWAITING_PAYMENT", awaiting_payment_at: at })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", order.id)
    .where("status", "=", "DRAFT")
    .execute();
  // Audit-only: `commerce.order.awaiting_payment` has no public v1 (registry gap).
  return { ok: true, data: { id: order.id, status: "AWAITING_PAYMENT" } };
}

async function handleCancel(
  ctx: CommandHandlerContext,
  input: OrderCancelInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const trx = requireTrx(ctx);
  const order = await loadOrderForUpdate(trx, ctx.tenantId, input.orderId);
  if (order === null) {
    return { ok: false, code: "not_found", message: "order not found in this tenant" };
  }
  if (!isOrderTransition(order.status, "CANCELLED")) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `order is ${order.status}; only DRAFT/AWAITING_PAYMENT orders cancel`,
    };
  }
  await trx
    .updateTable("commerce.orders")
    .set({ status: "CANCELLED", cancelled_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", order.id)
    .execute();
  await emitOrder(ctx, {
    eventType: "order.cancelled.v1",
    orderId: order.id,
    data: { person_id: order.personId, reason: input.reason ?? null },
  });
  return { ok: true, data: { id: order.id, status: "CANCELLED" } };
}

async function handleExpireDue(
  ctx: CommandHandlerContext,
  input: ExpireDueInput,
): Promise<CommandResult<{ expired: string[] }>> {
  const trx = requireTrx(ctx);
  const at = new Date();
  const rows = await trx
    .selectFrom("commerce.orders")
    .select(["id", "person_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("status", "in", ["DRAFT", "AWAITING_PAYMENT"])
    .where("expires_at", "is not", null)
    .where("expires_at", "<=", at)
    .orderBy("expires_at", "asc")
    .limit(input.limit)
    .execute();
  const expired: string[] = [];
  for (const row of rows) {
    const updated = await trx
      .updateTable("commerce.orders")
      .set({ status: "EXPIRED" })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", row.id)
      .where("status", "in", ["DRAFT", "AWAITING_PAYMENT"])
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      continue;
    }
    await emitOrder(ctx, {
      eventType: "order.expired.v1",
      orderId: row.id,
      data: { person_id: row.person_id, scheduler: "order.expire_due" },
    });
    expired.push(row.id);
  }
  return { ok: true, data: { expired } };
}

export function registerCommerceCommands(bus: CommandBus): void {
  bus.register<OfferQuoteInput, { id: string; status: string; netAmountMinor: string; currency: string }>({
    name: "offer.quote",
    permission: "commerce.order.write",
    auditAction: "offer.quote",
    auditResource: "order",
    input: offerQuoteInput,
    handler: handleQuote,
  });
  bus.register<OrderIdInput, { id: string; status: string }>({
    name: "order.submit",
    permission: "commerce.order.write",
    auditAction: "order.submit",
    auditResource: "order",
    input: orderIdInput,
    handler: handleSubmit,
  });
  bus.register<OrderCancelInput, { id: string; status: string }>({
    name: "order.cancel",
    permission: "commerce.order.write",
    auditAction: "order.cancel",
    auditResource: "order",
    input: orderCancelInput,
    handler: handleCancel,
  });
  bus.register<ExpireDueInput, { expired: string[] }>({
    name: "order.expire_due",
    permission: "commerce.order.write",
    auditAction: "order.expire_due",
    auditResource: "order",
    input: expireDueInput,
    handler: handleExpireDue,
  });
}
