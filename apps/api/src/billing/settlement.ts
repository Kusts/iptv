import { newId, now } from "@iptv/domain";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "@iptv/database";
import type { CommandHandlerContext } from "../commands/command-bus.js";
import { emitAndEnqueue } from "../crm/wave2-store.js";
import { evaluateCoverage, toMinor } from "../commerce/money-math.js";
import { postBalanced, settlementEntries } from "./ledger.js";

/**
 * Succeeded-refunds lookup scoped to one order. Extracted as a pure query
 * builder so the join shape is unit-testable without a database: both join
 * legs MUST be column references (`onRef`). Using `.on(lhs, "=", rhs)`
 * here would bind the literal string "billing.refunds.tenant_id" as a uuid
 * parameter and Postgres would reject it with
 * `invalid input syntax for type uuid` (FIX-WAVE5-LIVE #2).
 */
export function buildSucceededRefundsQuery(
  db: Kysely<Database> | Transaction<Database>,
  tenantId: string,
  orderId: string,
) {
  return db
    .selectFrom("billing.refunds")
    .innerJoin("billing.payments", (join) =>
      join
        .onRef("billing.payments.tenant_id", "=", "billing.refunds.tenant_id")
        .onRef("billing.payments.id", "=", "billing.refunds.payment_id"),
    )
    .select(["billing.refunds.amount_minor"])
    .where("billing.refunds.tenant_id", "=", tenantId)
    .where("billing.payments.order_id", "=", orderId)
    .where("billing.refunds.status", "=", "SUCCEEDED");
}

/**
 * Settlement evaluation (Wave 5, billing-owned).
 *
 * THE conversion moment: when confirmed payments (minus succeeded refunds)
 * cover the order net, the order moves `AWAITING_PAYMENT → SETTLED` and a
 * `crm.customers` row is created for the order's person IFF none exists
 * (idempotent on the `(tenant, person)` unique — a replay or a second order
 * for the same person never duplicates the customer).
 *
 * Financial recognition is a second balanced posting (Dr receivable /
 * Cr revenue) referencing the order; the confirmation posting (Dr cash /
 * Cr receivable) already landed when each payment confirmed.
 */
export async function evaluateOrderSettlement(
  ctx: CommandHandlerContext,
  trx: Transaction<Database>,
  orderId: string,
): Promise<{ settled: boolean; customerCreated: boolean }> {
  const order = await trx
    .selectFrom("commerce.orders")
    .select(["id", "person_id", "status", "currency", "net_amount_minor"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", orderId)
    .forUpdate()
    .executeTakeFirst();
  if (order === undefined || order.status !== "AWAITING_PAYMENT") {
    return { settled: false, customerCreated: false };
  }
  const netMinor = toMinor(order.net_amount_minor);
  const payments = await trx
    .selectFrom("billing.payments")
    .select(["id", "status", "amount_minor"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("order_id", "=", orderId)
    .forUpdate()
    .execute();
  const succeededRefunds = await buildSucceededRefundsQuery(trx, ctx.tenantId, orderId).execute();
  const coverage = evaluateCoverage({
    orderNetMinor: netMinor,
    payments: payments.map((p) => ({ status: p.status, amountMinor: toMinor(p.amount_minor) })),
    succeededRefundsMinor: succeededRefunds.reduce((acc, r) => acc + toMinor(r.amount_minor), 0n),
  });
  if (!coverage.settled) {
    return { settled: false, customerCreated: false };
  }
  const at = now();
  await trx
    .updateTable("commerce.orders")
    .set({
      status: "SETTLED",
      settled_amount_minor: coverage.settledAmountMinor.toString(),
      settled_at: at,
    })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", orderId)
    .where("status", "=", "AWAITING_PAYMENT")
    .execute();
  await postBalanced(trx, ctx.tenantId, {
    transactionType: "ORDER_SETTLEMENT",
    referenceType: "order",
    referenceId: orderId,
    idempotencyKey: `order-settlement:${orderId}`,
    metadata: { net_amount_minor: coverage.settledAmountMinor.toString(), currency: order.currency },
    entries: settlementEntries(coverage.settledAmountMinor, order.currency),
  });
  // Customer conversion: idempotent on (tenant, person) via
  // insert-on-conflict-do-nothing. A plain try/catch around the insert is
  // WRONG here: a caught unique violation aborts the Postgres transaction
  // and every later statement in this tx fails with "current transaction is
  // aborted" (FIX-WAVE5-LIVE-2 #2).
  const customerInsert = await trx
    .insertInto("crm.customers")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      person_id: order.person_id,
      status: "ACTIVE",
      customer_since: at,
      last_reactivated_at: null,
      created_at: at,
      updated_at: at,
    })
    .onConflict((oc) => oc.columns(["tenant_id", "person_id"]).doNothing())
    .returning(["id"])
    .executeTakeFirst();
  const customerCreated = customerInsert !== undefined;
  if (customerCreated) {
    await emitAndEnqueue(ctx, {
      eventType: "customer.created.v1",
      aggregateType: "customer",
      aggregateId: order.person_id,
      data: { person_id: order.person_id, order_id: orderId },
    });
  }
  await emitAndEnqueue(ctx, {
    eventType: "order.settled.v1",
    aggregateType: "order",
    aggregateId: orderId,
    data: {
      order_id: orderId,
      person_id: order.person_id,
      settled_amount_minor: coverage.settledAmountMinor.toString(),
      currency: order.currency,
    },
  });
  return { settled: true, customerCreated };
}
