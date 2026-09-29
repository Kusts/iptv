import { z } from "zod";
import { now } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { emitAndEnqueue, kyselyTrxOf } from "../crm/wave2-store.js";
import { mergePolicyRows } from "../trial/trial-policy.js";
import { UniqueViolationError } from "../trial/trial-store.js";
import { toMinor } from "../commerce/money-math.js";
import {
  SUSPENSION_POLICY_FAMILY,
  addBillingInterval,
  parseSuspensionPolicy,
} from "../subscription/subscription-policy.js";
import {
  getCatalogPlan,
  getPersonIdForCustomer,
  insertGrant,
  listEntitlementsBySource,
  updateCycle,
} from "../subscription/subscription-store.js";
import {
  RENEWAL_POLICY_FAMILY,
  SUBSCRIPTION_TRUST_RENEWAL_FAMILY,
  capExtensionDays,
  decideRenewalQuote,
  decideSubscriptionTrustRenewal,
  parseRenewalPolicy,
  parseSubscriptionTrustPolicy,
} from "./renewal-policy.js";
import {
  advisoryLockSubscription,
  appendRenewalReminder,
  approvedTrustReview,
  cancelQueuedRenewalReminder,
  cancelStaleRenewalReminders,
  createRenewalOrder,
  extendEntitlementsEndsAt,
  extendOpenCycle,
  findOpenTrustReview,
  findRenewalReminderMessage,
  getActivePlanPrice,
  getCycle,
  getCycleByRenewalOrder,
  getOpenCycle,
  getOrder,
  getOrderForUpdate,
  getRecoveryTask,
  getSubscription,
  getTrustGrantForCycle,
  hasEarlierCycleWithRenewalOrder,
  insertCycle,
  insertRecoveryTask,
  insertTrustGrant,
  listCycles,
  listOverdueCandidates,
  listRecoveryTasks,
  listRenewalWindowCandidates,
  reopenEntitlementsForRenewal,
  resolveRecoveryTask,
  setCycleRenewalOrder,
  updateEntitlementsStatusBySource,
  updateSubscription,
} from "./renewal-store.js";

/**
 * Wave 9 Renewal + Retention commands (owning context for renewal quoting,
 * renewal activation, trust-renewal extensions and the recovery queue).
 *
 * Canonical rules enforced here:
 * - A renewed period is a NEW SubscriptionCycle of the SAME
 *   CustomerSubscription (02): `subscription.renew` never creates a second
 *   subscription row; one OPEN cycle is guaranteed by the 019 partial index
 *   (close-then-open inside one transaction).
 * - Renewal payment follows Wave 5 billing discipline: `renewal.quote`
 *   creates a subscription-shaped RENEWAL order → AWAITING_PAYMENT (priced
 *   from the CURRENT catalog price with an immutable snapshot) → the
 *   existing `charge.create` + webhook PAID path settles it → only then
 *   `subscription.renew` opens the NEXT cycle + refreshes entitlements.
 *   Closed cycles and the ledger are never mutated.
 * - Trust Renewal ≠ regular renewal (06): `subscription.trust_renew` grants
 *   a bounded extension without payment, policy-gated
 *   (`subscription.trust_renewal`) and human-reviewed by default
 *   (requester≠approver enforced); single grant per cycle.
 * - Normal cancellation stays `cancel_at_period_end` (Wave 6 untouched);
 *   RENEWAL_DUE/OVERDUE/GRACE stay computed projections.
 * - `renewal.expire_overdue_due` ends at cycle end by default; SUSPENDED
 *   only under an explicit `subscription.suspension` policy (03).
 * - Events: registry-listed ONLY (`order.created.v1` on quote,
 *   `subscription.renewed.v1` on renew — both registered). Everything else
 *   is audit-only. No provider events, no invented ids.
 */

export const renewalQuoteInput = z.object({ subscriptionId: z.string().uuid() });
export type RenewalQuoteInput = z.infer<typeof renewalQuoteInput>;

export const renewInput = z.object({ orderId: z.string().uuid() });
export type RenewInput = z.infer<typeof renewInput>;

export const workerLimitInput = z.object({ limit: z.number().int().min(1).max(1000).default(100) });
export type WorkerLimitInput = z.infer<typeof workerLimitInput>;

export const trustRenewInput = z.object({
  subscriptionId: z.string().uuid(),
  extensionDays: z.number().int().positive().max(365).optional(),
  approvedReviewId: z.string().uuid().optional(),
});
export type TrustRenewInput = z.infer<typeof trustRenewInput>;

export const recoveryResolveInput = z.object({
  taskId: z.string().uuid(),
  outcome: z.enum(["WON_BACK", "LOST", "DISMISSED"]),
});
export type RecoveryResolveInput = z.infer<typeof recoveryResolveInput>;

export const recoveryListInput = z.object({
  subscriptionId: z.string().uuid().optional(),
  status: z.enum(["OPEN", "RESOLVED"]).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type RecoveryListInput = z.infer<typeof recoveryListInput>;

export interface RenewalQuoteResult {
  orderId: string;
  status: string;
  netAmountMinor: string;
  currency: string;
  early: boolean;
  already: boolean;
}

async function handleQuote(
  ctx: CommandHandlerContext,
  input: RenewalQuoteInput,
): Promise<CommandResult<RenewalQuoteResult>> {
  const subscription = await getSubscription(ctx, input.subscriptionId);
  if (subscription === null) {
    return { ok: false, code: "not_found", message: "subscription not found in this tenant" };
  }
  if (subscription.status !== "ACTIVE") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `subscription is ${subscription.status}; only ACTIVE subscriptions quote a renewal`,
    };
  }
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    return { ok: false, code: "precondition_failed", message: "renewal commands require a database transaction" };
  }
  await advisoryLockSubscription(trx, subscription.id);
  const open = await getOpenCycle(ctx, subscription.id);
  if (open === null) {
    return { ok: false, code: "precondition_failed", message: "subscription has no open cycle to renew from" };
  }
  const rows = await ctx.tx.listPublishedPolicies(RENEWAL_POLICY_FAMILY, ctx.tenantId);
  const { document } = mergePolicyRows(rows);
  const policy = parseRenewalPolicy(document);
  const at = now();
  const window = decideRenewalQuote(policy, { cycleEnd: open.endsAt, at });
  if (!window.allowed) {
    return { ok: false, code: "precondition_failed", message: window.reason };
  }
  // Idempotency: one OPEN renewal order per subscription, linked on the
  // current cycle's existing `renewal_order_id` (no new column).
  if (open.renewalOrderId !== null) {
    const linked = await getOrder(ctx, open.renewalOrderId);
    if (linked !== null && (linked.status === "DRAFT" || linked.status === "AWAITING_PAYMENT")) {
      return {
        ok: true,
        data: {
          orderId: linked.id,
          status: linked.status,
          netAmountMinor: linked.netMinor,
          currency: linked.currency,
          early: window.early,
          already: true,
        },
      };
    }
    if (linked !== null && linked.status === "SETTLED") {
      // Legacy compatibility: rows written before the F13 lifecycle fix
      // carry the same settled order on both the prior and the newly opened
      // cycle. An earlier cycle with the same order proves the open-cycle
      // pointer is a stale copy — clear it inside this tenant transaction
      // and quote fresh instead of refusing.
      const legacyDuplicate = await hasEarlierCycleWithRenewalOrder(
        ctx,
        subscription.id,
        open.cycleNo,
        linked.id,
      );
      if (legacyDuplicate) {
        await setCycleRenewalOrder(ctx, open.id, null);
      } else {
        return {
          ok: false,
          code: "precondition_failed",
          message: "renewal order already settled; run subscription.renew to open the next cycle",
        };
      }
    }
    // CANCELLED / EXPIRED / missing: drop the stale link and quote fresh.
    await setCycleRenewalOrder(ctx, open.id, null);
  }
  const personId = await getPersonIdForCustomer(ctx, subscription.customerId);
  if (personId === null) {
    return { ok: false, code: "precondition_failed", message: "subscription customer has no person" };
  }
  const price = await getActivePlanPrice(ctx, subscription.planId, at);
  if (price === null) {
    return {
      ok: false,
      code: "validation_failed",
      message: "no active catalog price for the subscription plan",
    };
  }
  const order = await createRenewalOrder(ctx, {
    personId,
    customerId: subscription.customerId,
    planId: subscription.planId,
    unitMinor: price.amountMinor,
    currency: price.currency,
    priceId: price.priceId,
  });
  await setCycleRenewalOrder(ctx, open.id, order.id);
  // `order.created.v1` is emitted inside `createRenewalOrder`
  // (registry-listed); the DRAFT→AWAITING_PAYMENT submit stays audit-only
  // (`commerce.order.awaiting_payment` has no public v1 — known gap).
  return {
    ok: true,
    data: {
      orderId: order.id,
      status: order.status,
      netAmountMinor: order.netMinor,
      currency: order.currency,
      early: window.early,
      already: false,
    },
  };
}

export interface RenewResult {
  subscriptionId: string;
  priorCycleId: string;
  cycleId: string;
  cycleNo: number;
  startsAt: string;
  endsAt: string;
  already: boolean;
}

async function handleRenew(
  ctx: CommandHandlerContext,
  input: RenewInput,
): Promise<CommandResult<RenewResult>> {
  const order = await getOrder(ctx, input.orderId);
  if (order === null) {
    return { ok: false, code: "not_found", message: "order not found in this tenant" };
  }
  if (order.orderType !== "RENEWAL") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `order is ${order.orderType}; subscription.renew requires a RENEWAL order`,
    };
  }
  if (order.status !== "SETTLED") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `order is ${order.status}; renewal follows settlement, never payment alone`,
    };
  }
  const prior = await getCycleByRenewalOrder(ctx, order.id);
  if (prior === null) {
    return { ok: false, code: "not_found", message: "no renewal link for this order" };
  }
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    return { ok: false, code: "precondition_failed", message: "renewal commands require a database transaction" };
  }
  await advisoryLockSubscription(trx, prior.subscriptionId);
  const subscription = await getSubscription(ctx, prior.subscriptionId);
  if (subscription === null) {
    return { ok: false, code: "not_found", message: "subscription not found in this tenant" };
  }
  if (subscription.status !== "ACTIVE" && subscription.status !== "SUSPENDED" && subscription.status !== "ENDED") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `subscription is ${subscription.status}; renewal requires ACTIVE/SUSPENDED/ENDED`,
    };
  }
  // Idempotency: the renewal link rides on the PRIOR cycle only (canonical
  // `renewal-store.ts` storage comment). Two replay shapes are accepted:
  // (a) legacy rows where the next cycle duplicated the same order pointer,
  // (b) current rows where the next cycle is identified by the sequential
  // chain — it starts exactly at the prior cycle end with a greater cycle_no.
  const priorRow = await getCycle(ctx, prior.id);
  if (priorRow === null) {
    return { ok: false, code: "not_found", message: "prior cycle not found in this tenant" };
  }
  const cycles = await listCycles(ctx, subscription.id);
  const newerByLink = cycles.find((c) => c.cycleNo > prior.cycleNo && c.renewalOrderId === order.id);
  if (newerByLink !== undefined) {
    return {
      ok: true,
      data: {
        subscriptionId: subscription.id,
        priorCycleId: prior.id,
        cycleId: newerByLink.id,
        cycleNo: newerByLink.cycleNo,
        startsAt: newerByLink.startsAt.toISOString(),
        endsAt: newerByLink.endsAt.toISOString(),
        already: true,
      },
    };
  }
  const chained = cycles
    .filter(
      (c) => c.cycleNo > priorRow.cycleNo && c.startsAt.getTime() === priorRow.endsAt.getTime(),
    )
    .sort((a, b) => a.cycleNo - b.cycleNo)[0];
  if (chained !== undefined) {
    return {
      ok: true,
      data: {
        subscriptionId: subscription.id,
        priorCycleId: priorRow.id,
        cycleId: chained.id,
        cycleNo: chained.cycleNo,
        startsAt: chained.startsAt.toISOString(),
        endsAt: chained.endsAt.toISOString(),
        already: true,
      },
    };
  }
  const catalogPlan = await getCatalogPlan(ctx, subscription.planId);
  if (catalogPlan === null) {
    return { ok: false, code: "not_found", message: "catalog plan not found in this tenant" };
  }
  // Money exact: the next cycle carries the SETTLED order net (integer
  // minor units as exact strings — never floats, never webhook amounts).
  const netMinor = toMinor(order.netMinor);
  if (netMinor <= 0n) {
    return { ok: false, code: "precondition_failed", message: "renewal order net is zero; nothing to renew" };
  }
  const nextStart = priorRow.endsAt;
  const nextEnd = addBillingInterval(nextStart, catalogPlan.intervalUnit, catalogPlan.intervalCount);
  const nextNo = Math.max(priorRow.cycleNo, ...cycles.map((c) => c.cycleNo)) + 1;
  // Close-then-open inside ONE transaction: the 019 partial index keeps
  // exactly one OPEN cycle; closed cycles are never mutated afterwards.
  if (priorRow.status === "PENDING" || priorRow.status === "ACTIVE") {
    const closed = await updateCycle(ctx, priorRow.id, { status: "COMPLETED" }, priorRow.status);
    if (closed === null) {
      return { ok: false, code: "precondition_failed", message: "prior cycle changed concurrently" };
    }
    await updateEntitlementsStatusBySource(ctx, "subscription", subscription.id, "EXPIRED");
  }
  const next = await insertCycle(ctx, {
    subscriptionId: subscription.id,
    cycleNo: nextNo,
    startsAt: nextStart,
    endsAt: nextEnd,
    status: "ACTIVE",
    baseRevenueMinor: netMinor.toString(),
    currency: order.currency,
  });
  // The renewal link stays on the PRIOR cycle (canonical storage rule):
  // the newly opened cycle starts with a null `renewal_order_id` so the
  // next `renewal.quote` and future reminders are never blocked by the
  // already-settled order. `insertCycle` defaults the link to null.
  await updateSubscription(ctx, subscription.id, {
    status: "ACTIVE",
    currentPeriodStart: nextStart,
    currentPeriodEnd: nextEnd,
  });
  const reopened = await reopenEntitlementsForRenewal(ctx, {
    subscriptionId: subscription.id,
    startsAt: nextStart,
    endsAt: nextEnd,
  });
  const existing = await listEntitlementsBySource(ctx, "subscription", subscription.id);
  const existingIds = new Set(existing.map((e) => e.id));
  for (const entitlement of reopened) {
    if (!existingIds.has(entitlement.id)) {
      continue;
    }
    await insertGrant(ctx, {
      entitlementId: entitlement.id,
      grantType: "RENEWAL",
      startsAt: nextStart,
      endsAt: nextEnd,
      sourceType: "subscription_cycle",
      sourceId: next.id,
    });
  }
  // Registry-listed renewal fact (`subscription.renewed.v1` is registered —
  // not a gap). Never reused as an ending signal.
  await emitAndEnqueue(ctx, {
    eventType: "subscription.renewed.v1",
    aggregateType: "subscription",
    aggregateId: subscription.id,
    data: {
      subscription_id: subscription.id,
      prior_cycle_id: priorRow.id,
      cycle_id: next.id,
      cycle_no: nextNo,
      order_id: order.id,
    },
  });
  return {
    ok: true,
    data: {
      subscriptionId: subscription.id,
      priorCycleId: priorRow.id,
      cycleId: next.id,
      cycleNo: nextNo,
      startsAt: nextStart.toISOString(),
      endsAt: nextEnd.toISOString(),
      already: false,
    },
  };
}

async function handleRemindersDue(
  ctx: CommandHandlerContext,
  input: WorkerLimitInput,
): Promise<CommandResult<{ scanned: number; reminded: string[] }>> {
  const rows = await ctx.tx.listPublishedPolicies(RENEWAL_POLICY_FAMILY, ctx.tenantId);
  const { document } = mergePolicyRows(rows);
  const policy = parseRenewalPolicy(document);
  const at = now();
  const candidates = await listRenewalWindowCandidates(
    ctx,
    { from: at, to: new Date(at.getTime() + policy.windowDays * 86_400_000), limit: input.limit },
  );
  const reminded: string[] = [];
  for (const candidate of candidates) {
    const trx = kyselyTrxOf(ctx);
    if (trx !== null) {
      await advisoryLockSubscription(trx, candidate.subscriptionId);
    }
    // Race revalidation (tenant-scoped): the candidate snapshot may predate
    // a concurrent settlement OR a Trust Renewal extension applied while
    // this worker waited on the advisory lock. Re-read the live
    // subscription/cycle and re-evaluate the CURRENT time against
    // `[now, now + windowDays]` — never the pre-lock candidate date. A cycle
    // that left ACTIVE/PENDING or moved outside the window is skipped, and
    // an eligible cycle is reminded with its FRESH end date.
    // The linked order is then row-locked (`FOR UPDATE` serializes against
    // settlement's own row lock). A same-tenant SETTLED link suppresses the
    // reminder — except a legacy duplicate (an earlier cycle carries the
    // same order), which stays reminder-eligible. Missing/foreign links
    // never suppress. Never auto-runs `subscription.renew` here; only skips
    // stale appends.
    const freshSubscription = await getSubscription(ctx, candidate.subscriptionId);
    if (freshSubscription === null || freshSubscription.status !== "ACTIVE") {
      continue;
    }
    const freshCycle = await getCycle(ctx, candidate.cycleId);
    if (freshCycle === null || freshCycle.subscriptionId !== candidate.subscriptionId) {
      continue;
    }
    if (freshCycle.status !== "PENDING" && freshCycle.status !== "ACTIVE") {
      continue;
    }
    const recheckAt = now();
    const freshEndsAtMs = freshCycle.endsAt.getTime();
    if (freshEndsAtMs < recheckAt.getTime() || freshEndsAtMs > recheckAt.getTime() + policy.windowDays * 86_400_000) {
      continue;
    }
    if (freshCycle.renewalOrderId !== null) {
      const locked = await getOrderForUpdate(ctx, freshCycle.renewalOrderId);
      if (locked !== null && locked.status === "SETTLED") {
        const legacyDuplicate = await hasEarlierCycleWithRenewalOrder(
          ctx,
          candidate.subscriptionId,
          freshCycle.cycleNo,
          locked.id,
        );
        if (!legacyDuplicate) {
          // Settlement raced the candidate snapshot after an earlier run
          // already queued the reminder: append the append-only CANCELLED
          // attempt for the existing message instead of leaving a stale
          // QUEUED delivery behind. Never UPDATEs/DELETEs; legacy
          // duplicates and missing messages stay untouched.
          const existing = await findRenewalReminderMessage(ctx, {
            subscriptionId: candidate.subscriptionId,
            cycleId: freshCycle.id,
          });
          if (existing !== null) {
            await cancelQueuedRenewalReminder(ctx, {
              messageId: existing.id,
              subscriptionId: candidate.subscriptionId,
              cycleId: freshCycle.id,
              orderId: locked.id,
            });
          }
          continue;
        }
      }
    }
    const personId = await getPersonIdForCustomer(ctx, candidate.customerId);
    if (personId === null) {
      continue;
    }
    const recorded = await appendRenewalReminder(ctx, {
      personId,
      subscriptionId: candidate.subscriptionId,
      cycleId: candidate.cycleId,
      cycleEnd: freshCycle.endsAt,
    });
    if (!recorded.duplicate) {
      reminded.push(candidate.subscriptionId);
    }
  }
  // Idempotent recheck pass (F13): the due-window query already excludes
  // genuine settled links, so a reminder queued by an earlier run would
  // otherwise keep a stale QUEUED latest delivery forever. Re-evaluate every
  // generated reminder whose latest delivery is still QUEUED and append a
  // CANCELLED attempt where its cycle's genuine same-tenant order settled.
  // The public result shape stays `{ scanned, reminded }`.
  await cancelStaleRenewalReminders(ctx, { limit: input.limit });
  return { ok: true, data: { scanned: candidates.length, reminded } };
}

export interface TrustRenewResult {
  subscriptionId: string;
  cycleId: string;
  previousEndsAt: string;
  newEndsAt: string;
  extensionDays: number;
  reviewRequestId: string | null;
}

async function handleTrustRenew(
  ctx: CommandHandlerContext,
  input: TrustRenewInput,
): Promise<CommandResult<TrustRenewResult>> {
  const subscription = await getSubscription(ctx, input.subscriptionId);
  if (subscription === null) {
    return { ok: false, code: "not_found", message: "subscription not found in this tenant" };
  }
  const open = await getOpenCycle(ctx, subscription.id);
  if (open === null) {
    return { ok: false, code: "precondition_failed", message: "subscription has no open cycle to extend" };
  }
  const rows = await ctx.tx.listPublishedPolicies(SUBSCRIPTION_TRUST_RENEWAL_FAMILY, ctx.tenantId);
  const { document } = mergePolicyRows(rows);
  const policy = parseSubscriptionTrustPolicy(document);
  // Replay-first: an existing grant short-circuits before the policy gate
  // (the extension itself pushes the cycle out of the eligibility window,
  // so gating first would misreport a successful retry as denied).
  const existing = await getTrustGrantForCycle(ctx, open.id);
  if (existing !== null) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "trust renewal already granted for this cycle",
    };
  }
  const decision = decideSubscriptionTrustRenewal(
    policy,
    { status: subscription.status, cycleEnd: open.endsAt, at: now() },
  );
  if (!decision.allowed) {
    return { ok: false, code: "forbidden", message: `trust renewal denied: ${decision.reason}` };
  }
  let extensionDays: number;
  try {
    extensionDays = capExtensionDays(input.extensionDays, policy.maxExtensionDays);
  } catch (err) {
    return {
      ok: false,
      code: "validation_failed",
      message: err instanceof Error ? err.message : "invalid extension days",
    };
  }
  // Human review first: without an approved review the extension is
  // forbidden. The review request is created (or the open one reused) so
  // the operator has something to decide; the grant applies on re-entry
  // with `approvedReviewId`.
  if (input.approvedReviewId === undefined) {
    if (!policy.requireReview) {
      return applyTrustGrant(ctx, {
        subscriptionId: subscription.id,
        cycleId: open.id,
        previousEndsAt: open.endsAt,
        extensionDays,
        reviewRequestId: null,
      });
    }
    const openReview = await findOpenTrustReview(ctx, open.id);
    const reviewId =
      openReview?.id ??
      (
        await ctx.tx.createReviewRequest({
          resourceType: "subscription_trust_renewal",
          resourceId: open.id,
          reviewMode: "APPROVAL",
          reason: "RISK_REVIEW",
          riskClass: "R2",
          priority: "HIGH",
          summary: `Trust renewal +${extensionDays}d for subscription ${subscription.id} (no payment; bounded extension)`,
          contextJson: {
            subscription_id: subscription.id,
            cycle_id: open.id,
            extension_days: extensionDays,
          },
          requestedByType: ctx.actor.actorType,
          requestedById: ctx.actor.userId,
        })
      ).id;
    await emitAndEnqueue(ctx, {
      eventType: "hitl.review_requested.v1",
      aggregateType: "human_review",
      aggregateId: reviewId,
      data: {
        review_id: reviewId,
        review_mode: "APPROVAL",
        reason: "RISK_REVIEW",
        resource_type: "subscription_trust_renewal",
        resource_id: open.id,
      },
    });
    return {
      ok: false,
      code: "forbidden",
      message: `trust renewal requires human approval (review ${reviewId})`,
    };
  }
  const approval = await approvedTrustReview(ctx, input.approvedReviewId, open.id);
  if (!approval.approved) {
    return { ok: false, code: "forbidden", message: `trust renewal denied: ${approval.reason}` };
  }
  return applyTrustGrant(ctx, {
    subscriptionId: subscription.id,
    cycleId: open.id,
    previousEndsAt: open.endsAt,
    extensionDays,
    reviewRequestId: input.approvedReviewId,
  });
}

async function applyTrustGrant(
  ctx: CommandHandlerContext,
  input: {
    subscriptionId: string;
    cycleId: string;
    previousEndsAt: Date;
    extensionDays: number;
    reviewRequestId: string | null;
  },
): Promise<CommandResult<TrustRenewResult>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    return { ok: false, code: "precondition_failed", message: "renewal commands require a database transaction" };
  }
  await advisoryLockSubscription(trx, input.subscriptionId);
  const current = await getCycle(ctx, input.cycleId);
  if (current === null || (current.status !== "PENDING" && current.status !== "ACTIVE")) {
    return { ok: false, code: "precondition_failed", message: "cycle is no longer open" };
  }
  const newEndsAt = new Date(current.endsAt.getTime() + input.extensionDays * 86_400_000);
  const extended = await extendOpenCycle(ctx, current.id, newEndsAt);
  if (extended === null) {
    return { ok: false, code: "precondition_failed", message: "cycle closed concurrently" };
  }
  await updateSubscription(ctx, input.subscriptionId, { currentPeriodEnd: newEndsAt });
  await extendEntitlementsEndsAt(ctx, { subscriptionId: input.subscriptionId, endsAt: newEndsAt });
  try {
    await insertTrustGrant(ctx, {
      subscriptionId: input.subscriptionId,
      cycleId: current.id,
      extensionDays: input.extensionDays,
      previousEndsAt: current.endsAt,
      newEndsAt,
      reviewRequestId: input.reviewRequestId,
      grantedBy: ctx.actor.userId,
    });
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      return {
        ok: false,
        code: "precondition_failed",
        message: "trust renewal already granted for this cycle",
      };
    }
    throw err;
  }
  // Audit-only by design: trust renewal has no registry-listed public v1
  // (the `subscription.*` cycle/entitlement families stay unversioned gaps;
  // `subscription.renewed.v1` is a paid-renewal fact and must NOT be reused
  // for a paymentless extension).
  return {
    ok: true,
    data: {
      subscriptionId: input.subscriptionId,
      cycleId: current.id,
      previousEndsAt: current.endsAt.toISOString(),
      newEndsAt: newEndsAt.toISOString(),
      extensionDays: input.extensionDays,
      reviewRequestId: input.reviewRequestId,
    },
  };
}

async function handleExpireOverdueDue(
  ctx: CommandHandlerContext,
  input: WorkerLimitInput,
): Promise<CommandResult<{ expired: string[]; suspended: string[]; recoveryTasks: string[] }>> {
  const renewalRows = await ctx.tx.listPublishedPolicies(RENEWAL_POLICY_FAMILY, ctx.tenantId);
  const { document: renewalDoc } = mergePolicyRows(renewalRows);
  const renewalPolicy = parseRenewalPolicy(renewalDoc);
  const suspensionRows = await ctx.tx.listPublishedPolicies(SUSPENSION_POLICY_FAMILY, ctx.tenantId);
  const { document: suspensionDoc } = mergePolicyRows(suspensionRows);
  const suspension = parseSuspensionPolicy(suspensionDoc);
  const at = now();
  const cutoff = new Date(at.getTime() - renewalPolicy.graceDays * 86_400_000);
  const candidates = await listOverdueCandidates(ctx, { before: cutoff, limit: input.limit });
  const expired: string[] = [];
  const suspended: string[] = [];
  const recoveryTasks: string[] = [];
  for (const candidate of candidates) {
    const trx = kyselyTrxOf(ctx);
    if (trx !== null) {
      await advisoryLockSubscription(trx, candidate.subscriptionId);
    }
    const subscription = await getSubscription(ctx, candidate.subscriptionId);
    if (subscription === null || subscription.status !== "ACTIVE") {
      continue;
    }
    // `cancel_at_period_end` rows belong to `subscription.expire_cycles_due`
    // (Wave 6) — never double-process them here.
    if (subscription.cancelAtPeriodEnd) {
      continue;
    }
    const cycle = await getCycle(ctx, candidate.cycleId);
    if (cycle === null || (cycle.status !== "PENDING" && cycle.status !== "ACTIVE")) {
      continue;
    }
    if (cycle.endsAt.getTime() > cutoff.getTime()) {
      continue;
    }
    // A SETTLED renewal order means the money arrived and `subscription.renew`
    // owns the transition — the worker must never steal it. The link is
    // row-locked (`FOR UPDATE` serializes against settlement's own row
    // lock) and tenant-scoped (missing/foreign links never suppress).
    // Legacy compatibility: rows written before the F13 lifecycle fix carry
    // the same settled order on both the prior and the newly opened cycle.
    // An earlier cycle with the same order proves the overdue cycle's
    // pointer is a stale copy — not a paid link for the current cycle — so
    // expiry proceeds with `renewalOrderId: null` (no stale pointer on the
    // recovery task). Only a genuine upcoming renewal for the currently
    // overdue cycle (no earlier cycle carries the order) suppresses expiry.
    let linkedRenewalOrderId: string | null = null;
    if (cycle.renewalOrderId !== null) {
      const linked = await getOrderForUpdate(ctx, cycle.renewalOrderId);
      if (linked !== null && linked.status === "SETTLED") {
        const legacyDuplicate = await hasEarlierCycleWithRenewalOrder(
          ctx,
          subscription.id,
          cycle.cycleNo,
          linked.id,
        );
        if (!legacyDuplicate) {
          continue;
        }
      } else if (linked !== null && (linked.status === "DRAFT" || linked.status === "AWAITING_PAYMENT")) {
        linkedRenewalOrderId = linked.id;
      }
    }
    if (suspension.allowed) {
      const updated = await updateSubscription(ctx, subscription.id, { status: "SUSPENDED" }, "ACTIVE");
      if (updated === null) {
        continue;
      }
      await updateEntitlementsStatusBySource(ctx, "subscription", subscription.id, "SUSPENDED");
      const task = await insertRecoveryTask(ctx, {
        subscriptionId: subscription.id,
        cycleId: cycle.id,
        renewalOrderId: linkedRenewalOrderId,
        reason: "OVERDUE_SUSPENDED",
      });
      suspended.push(subscription.id);
      recoveryTasks.push(task.id);
      continue;
    }
    // Default path (03): ENDED at cycle end — suspension requires an
    // explicit service policy decision, never a late payment alone.
    const closed = await updateCycle(ctx, cycle.id, { status: "COMPLETED" }, cycle.status);
    if (closed === null) {
      continue;
    }
    await updateEntitlementsStatusBySource(ctx, "subscription", subscription.id, "EXPIRED");
    const ended = await updateSubscription(ctx, subscription.id, { status: "ENDED" }, "ACTIVE");
    if (ended === null) {
      continue;
    }
    const task = await insertRecoveryTask(ctx, {
      subscriptionId: subscription.id,
      cycleId: cycle.id,
      renewalOrderId: linkedRenewalOrderId,
      reason: "OVERDUE_NO_RENEWAL",
    });
    expired.push(subscription.id);
    recoveryTasks.push(task.id);
  }
  return { ok: true, data: { expired, suspended, recoveryTasks } };
}

async function handleRecoveryResolve(
  ctx: CommandHandlerContext,
  input: RecoveryResolveInput,
): Promise<CommandResult<{ id: string; status: string; outcome: string }>> {
  const task = await getRecoveryTask(ctx, input.taskId);
  if (task === null) {
    return { ok: false, code: "not_found", message: "recovery task not found in this tenant" };
  }
  if (task.status !== "OPEN") {
    return { ok: false, code: "precondition_failed", message: `recovery task is already ${task.status}` };
  }
  // Human-resolved only: the bus audit records actor + outcome atomically
  // with the transition. No campaign automation exists on this path.
  const resolved = await resolveRecoveryTask(ctx, {
    taskId: task.id,
    outcome: input.outcome,
    resolvedBy: ctx.actor.userId,
  });
  if (resolved === null) {
    return { ok: false, code: "precondition_failed", message: "recovery task changed concurrently" };
  }
  return { ok: true, data: { id: resolved.id, status: resolved.status, outcome: resolved.outcome as string } };
}

export function registerRenewalCommands(bus: CommandBus): void {
  bus.register<RenewalQuoteInput, RenewalQuoteResult>({
    name: "renewal.quote",
    permission: "subscription.write",
    auditAction: "renewal.quote",
    auditResource: "order",
    input: renewalQuoteInput,
    handler: handleQuote,
  });
  bus.register<RenewInput, RenewResult>({
    name: "subscription.renew",
    permission: "subscription.write",
    auditAction: "subscription.renew",
    auditResource: "subscription",
    input: renewInput,
    handler: handleRenew,
  });
  bus.register<WorkerLimitInput, { scanned: number; reminded: string[] }>({
    name: "renewal.reminders_due",
    permission: "subscription.write",
    auditAction: "renewal.reminders_due",
    auditResource: "message",
    input: workerLimitInput,
    handler: handleRemindersDue,
  });
  bus.register<TrustRenewInput, TrustRenewResult>({
    name: "subscription.trust_renew",
    permission: "subscription.write",
    auditAction: "subscription.trust_renew",
    auditResource: "subscription",
    input: trustRenewInput,
    handler: handleTrustRenew,
  });
  bus.register<WorkerLimitInput, { expired: string[]; suspended: string[]; recoveryTasks: string[] }>({
    name: "renewal.expire_overdue_due",
    permission: "subscription.write",
    auditAction: "renewal.expire_overdue_due",
    auditResource: "subscription",
    input: workerLimitInput,
    handler: handleExpireOverdueDue,
  });
  bus.register<RecoveryResolveInput, { id: string; status: string; outcome: string }>({
    name: "recovery.resolve",
    permission: "subscription.write",
    auditAction: "recovery.resolve",
    auditResource: "recovery_task",
    input: recoveryResolveInput,
    handler: handleRecoveryResolve,
  });
}

export async function listRecoveryTaskViews(
  ctx: CommandHandlerContext,
  input: RecoveryListInput,
): Promise<Array<{ id: string; subscriptionId: string; cycleId: string | null; reason: string; status: string; outcome: string | null }>> {
  const rows = await listRecoveryTasks(ctx, {
    subscriptionId: input.subscriptionId,
    status: input.status,
    limit: input.limit,
  });
  return rows.map((row) => ({
    id: row.id,
    subscriptionId: row.subscriptionId,
    cycleId: row.cycleId,
    reason: row.reason,
    status: row.status,
    outcome: row.outcome,
  }));
}
