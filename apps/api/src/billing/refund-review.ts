import { now } from "@iptv/domain";
import type { CommandHandlerContext, StoredReviewRequest } from "../commands/command-bus.js";
import { kyselyTrxOf } from "../crm/wave2-store.js";
import { remainingRefundable, toMinor } from "../commerce/money-math.js";

/**
 * Refund-aware HumanReview hooks (Wave 5).
 *
 * `refund.request` creates a `billing.refund_requests` row PLUS a linked
 * `agent.human_review_requests` row (resourceType `refund_request`). The
 * human decision flows through `human_review.approve|reject`; these hooks
 * wire the refund contract into that decision atomically:
 *
 * - revalidator: rejects stale approvals (request left UNDER_REVIEW,
 *   payment drained, wrong tenant) and enforces NO SELF-APPROVAL — the
 *   requester cannot APPROVE their own request (they may still REJECT /
 *   withdraw it). Non-refund reviews pass through untouched.
 * - onResolved: propagates APPROVE/REJECT onto the refund request row in
 *   the SAME transaction (throwing rolls the decision back).
 */

export const REFUND_REVIEW_RESOURCE = "refund_request";

const DECIDABLE_PAYMENT_STATUSES = ["CONFIRMED", "PARTIALLY_REFUNDED"] as const;

/**
 * Linkage guard: the refund hooks engage ONLY for reviews genuinely created
 * by `refund.request`, which stamps `contextJson.refund_request_id` with the
 * refund request id (equal to the review's `resourceId`). Any other review —
 * including pre-Wave-5 tests and flows that merely reuse the
 * `refund_request` resource type with an unrelated id — passes through
 * untouched, preserving the exact pre-Wave-5 decision behavior.
 */
function linkedRefundRequestId(request: StoredReviewRequest): string | null {
  if (request.resourceType !== REFUND_REVIEW_RESOURCE) {
    return null;
  }
  const context = request.contextJson;
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    return null;
  }
  const marker = (context as Record<string, unknown>)["refund_request_id"];
  if (typeof marker !== "string" || marker !== request.resourceId) {
    return null;
  }
  return marker;
}

interface RefundRequestRow {
  id: string;
  tenantId: string;
  paymentId: string;
  status: string;
  amountMinor: bigint;
  requestedById: string | null;
}

async function loadRefundRequest(
  ctx: CommandHandlerContext,
  resourceId: string,
): Promise<RefundRequestRow | null> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("refund review hooks require a database transaction");
  }
  const row = await trx
    .selectFrom("billing.refund_requests")
    .select(["id", "tenant_id", "payment_id", "status", "amount_minor", "requested_by_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", resourceId)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    paymentId: row.payment_id,
    status: row.status,
    amountMinor: toMinor(row.amount_minor),
    requestedById: row.requested_by_id,
  };
}

async function currentRemainingMinor(ctx: CommandHandlerContext, paymentId: string): Promise<{ found: boolean; status: string; remaining: bigint }> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("refund review hooks require a database transaction");
  }
  const payment = await trx
    .selectFrom("billing.payments")
    .select(["id", "status", "amount_minor"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", paymentId)
    .forUpdate()
    .executeTakeFirst();
  if (payment === undefined) {
    return { found: false, status: "", remaining: 0n };
  }
  const consumed = await trx
    .selectFrom("billing.refunds")
    .select(["amount_minor"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("payment_id", "=", paymentId)
    .where("status", "in", ["PROCESSING", "RECONCILING", "SUCCEEDED"])
    .execute();
  const consumedMinor = consumed.reduce((acc, r) => acc + toMinor(r.amount_minor), 0n);
  return {
    found: true,
    status: payment.status,
    remaining: remainingRefundable({ paidMinor: toMinor(payment.amount_minor), consumedMinor }),
  };
}

export async function refundTargetRevalidator(
  ctx: CommandHandlerContext,
  request: StoredReviewRequest,
  decision?: "APPROVED" | "REJECTED",
): Promise<string | null> {
  const linked = linkedRefundRequestId(request);
  if (linked === null) {
    return null;
  }
  const rr = await loadRefundRequest(ctx, linked);
  if (rr === null) {
    return "linked refund request not found in this tenant";
  }
  if (rr.status !== "UNDER_REVIEW") {
    return `refund request is already ${rr.status}`;
  }
  if (
    decision === "APPROVED" &&
    rr.requestedById !== null &&
    ctx.actor.userId === rr.requestedById
  ) {
    return "self-approval forbidden: the requester cannot approve their own refund";
  }
  const current = await currentRemainingMinor(ctx, rr.paymentId);
  if (!current.found) {
    return "linked payment not found in this tenant";
  }
  if (!(DECIDABLE_PAYMENT_STATUSES as readonly string[]).includes(current.status)) {
    return `linked payment is ${current.status}`;
  }
  if (current.remaining < rr.amountMinor) {
    return `refund amount exceeds the remaining refundable (${current.remaining} < ${rr.amountMinor})`;
  }
  return null;
}

export async function refundReviewResolvedHook(
  ctx: CommandHandlerContext,
  request: StoredReviewRequest,
  decision: "APPROVED" | "REJECTED",
): Promise<void> {
  const linked = linkedRefundRequestId(request);
  if (linked === null) {
    return;
  }
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("refund review hooks require a database transaction");
  }
  const status = decision === "APPROVED" ? "APPROVED" : "REJECTED";
  const updated = await trx
    .updateTable("billing.refund_requests")
    .set({ status, decided_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", linked)
    .where("status", "=", "UNDER_REVIEW")
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) === 0) {
    throw new Error("refund request left UNDER_REVIEW concurrently; decision rolled back");
  }
}
