import { z } from "zod";
import { now } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { mergePolicyRows } from "../trial/trial-policy.js";
import {
  UniqueViolationError,
  getProviderOperation,
  latestProviderOperationForEntity,
} from "../trial/trial-store.js";
import {
  SUSPENSION_POLICY_FAMILY,
  addBillingInterval,
  computeProjectedState,
  isSubscriptionTransition,
  parseSuspensionPolicy,
} from "./subscription-policy.js";
import {
  appendCredentialNotification,
  getCatalogPlan,
  getCustomerForPerson,
  getOpenCycle,
  getPersonIdForCustomer,
  getSubscription,
  getSubscriptionByOrder,
  insertCycle,
  insertEntitlement,
  insertGrant,
  insertProviderEvidence,
  insertSubscription,
  listActiveSubscriptionAddons,
  listDueCycles,
  listEntitlementsBySource,
  listSubscriptions,
  loadSettledOrderPlan,
  updateCycle,
  updateEntitlementsStatusBySource,
  updateSubscription,
  upsertSubscriptionBinding,
  type SubscriptionRow,
} from "./subscription-store.js";

/**
 * Wave 6 Subscription commands (owning context for CustomerSubscription,
 * SubscriptionCycle and Entitlements).
 *
 * Canonical rules enforced here:
 * - Activation follows settlement: `subscription.activate_from_order`
 *   requires the order SETTLED (a CONFIRMED payment alone never suffices)
 *   with a subscription-shaped (PLAN) line. It creates PENDING_ACTIVATION +
 *   a first PENDING cycle + PENDING entitlements — no access yet.
 * - `subscription.activate` requires the fulfillment postcondition:
 *   a SUCCEEDED provider operation for the subscription. It flips
 *   PENDING_ACTIVATION → ACTIVE, opens the cycle, grants entitlements for
 *   the period, records `provider_evidence` and appends the credential
 *   notification. Double activation is idempotent.
 * - Normal cancellation is `cancel_at_period_end` (flag + cancelled_at);
 *   ENDED arrives only via `subscription.expire_cycles_due` closing cycles
 *   past period end. Renewal itself is Wave 9 — the worker never opens a
 *   new cycle.
 * - `subscription.suspend` is policy-gated on the `subscription.suspension`
 *   family (safe default DENY) with an explicit reason — never a late
 *   webhook alone (the billing webhook path never touches subscriptions).
 * - Events: `subscription.created/cycle/entitlement/cancel_at_period_end`
 *   are KNOWN registry gaps with no public v1, so lifecycle transitions are
 *   audit-only. Only registry-listed `provider.*` events flow (emitted by
 *   the provider commands on the fulfillment path).
 */

export const activateFromOrderInput = z.object({ orderId: z.string().uuid() });
export type ActivateFromOrderInput = z.infer<typeof activateFromOrderInput>;

export const subscriptionIdInput = z.object({ subscriptionId: z.string().uuid() });
export type SubscriptionIdInput = z.infer<typeof subscriptionIdInput>;

export const activateInput = z.object({
  subscriptionId: z.string().uuid(),
  operationId: z.string().uuid().optional(),
});
export type ActivateInput = z.infer<typeof activateInput>;

export const suspendInput = z.object({
  subscriptionId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
});
export type SuspendInput = z.infer<typeof suspendInput>;

export const expireCyclesDueInput = z.object({ limit: z.number().int().min(1).max(1000).default(100) });
export type ExpireCyclesDueInput = z.infer<typeof expireCyclesDueInput>;

export const listSubscriptionsInput = z.object({
  status: z.enum(["PENDING_ACTIVATION", "ACTIVE", "SUSPENDED", "ENDED"]).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListSubscriptionsInput = z.infer<typeof listSubscriptionsInput>;

export interface SubscriptionView {
  id: string;
  customerId: string;
  planId: string;
  status: string;
  projectedState: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
}

export function toSubscriptionView(row: SubscriptionRow, at = new Date()): SubscriptionView {
  return {
    id: row.id,
    customerId: row.customerId,
    planId: row.planId,
    status: row.status,
    projectedState: computeProjectedState({ status: row.status, currentPeriodEnd: row.currentPeriodEnd, at }),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    currentPeriodStart: row.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
  };
}

async function derivePendingEntitlements(
  ctx: CommandHandlerContext,
  input: { customerId: string; planKey: string; subscriptionId: string; startsAt: Date; endsAt: Date },
): Promise<void> {
  await insertEntitlement(ctx, {
    customerId: input.customerId,
    featureKey: `plan:${input.planKey}`,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    status: "PENDING",
    sourceType: "subscription",
    sourceId: input.subscriptionId,
    metadata: { subscription_id: input.subscriptionId },
  });
  const addons = await listActiveSubscriptionAddons(ctx, input.subscriptionId);
  for (const addon of addons) {
    if (addon.featureKey === null) {
      continue;
    }
    await insertEntitlement(ctx, {
      customerId: input.customerId,
      featureKey: addon.featureKey,
      quantity: addon.quantity,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: "PENDING",
      sourceType: "subscription_addon",
      sourceId: addon.addonId,
      metadata: { subscription_id: input.subscriptionId },
    });
  }
}

async function handleActivateFromOrder(
  ctx: CommandHandlerContext,
  input: ActivateFromOrderInput,
): Promise<CommandResult<{ id: string; status: string; already: boolean }>> {
  const plan = await loadSettledOrderPlan(ctx, input.orderId);
  if (plan === null) {
    return { ok: false, code: "not_found", message: "order not found or has no subscription-shaped plan line" };
  }
  if (plan.status !== "SETTLED") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `order is ${plan.status}; subscription activation follows settlement, never payment alone`,
    };
  }
  const existing = await getSubscriptionByOrder(ctx, plan.orderId);
  if (existing !== null) {
    return { ok: true, data: { id: existing.id, status: existing.status, already: true } };
  }
  const catalogPlan = await getCatalogPlan(ctx, plan.planId);
  if (catalogPlan === null) {
    return { ok: false, code: "not_found", message: "catalog plan not found in this tenant" };
  }
  const customerId = plan.customerId ?? (await getCustomerForPerson(ctx, plan.personId))?.id ?? null;
  if (customerId === null) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "no customer for this order; settlement must convert the person first",
    };
  }
  const startsAt = now();
  const endsAt = addBillingInterval(startsAt, catalogPlan.intervalUnit, catalogPlan.intervalCount);
  const subscription = await insertSubscription(ctx, {
    customerId,
    planId: plan.planId,
    originatingOrderId: plan.orderId,
    periodStart: startsAt,
    periodEnd: endsAt,
  });
  try {
    await insertCycle(ctx, {
      subscriptionId: subscription.id,
      cycleNo: 1,
      startsAt,
      endsAt,
      status: "PENDING",
      baseRevenueMinor: plan.netMinor,
      currency: plan.currency,
    });
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      return { ok: false, code: "precondition_failed", message: err.message };
    }
    throw err;
  }
  await derivePendingEntitlements(ctx, {
    customerId,
    planKey: catalogPlan.planKey,
    subscriptionId: subscription.id,
    startsAt,
    endsAt,
  });
  // No registry-listed `subscription.created` public v1 exists (known gap):
  // audit-only by design.
  return { ok: true, data: { id: subscription.id, status: "PENDING_ACTIVATION", already: false } };
}

export interface ActivationResult {
  id: string;
  status: string;
  already: boolean;
  cycleId: string;
  operationId: string;
}

/**
 * Shared activation core: fulfillment postcondition SUCCEEDED → ACTIVE.
 * Used by `subscription.activate` and by the provider resolve/reconcile
 * resume hooks for `entity_type=subscription` operations.
 */
export async function activateSubscriptionInternal(
  ctx: CommandHandlerContext,
  subscriptionId: string,
  operationId?: string,
): Promise<CommandResult<ActivationResult>> {
  const subscription = await getSubscription(ctx, subscriptionId);
  if (subscription === null) {
    return { ok: false, code: "not_found", message: "subscription not found in this tenant" };
  }
  if (subscription.status === "ACTIVE") {
    const open = await getOpenCycle(ctx, subscriptionId);
    return {
      ok: true,
      data: {
        id: subscription.id,
        status: "ACTIVE",
        already: true,
        cycleId: open?.id ?? "",
        operationId: operationId ?? "",
      },
    };
  }
  if (!isSubscriptionTransition(subscription.status, "ACTIVE")) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `subscription is ${subscription.status}; only PENDING_ACTIVATION activates`,
    };
  }
  // Fulfillment postcondition: the linked provider operation must be
  // SUCCEEDED (KNOWN_APPLIED). Never activate on a parked/failed effect.
  const operation =
    operationId !== undefined
      ? await getProviderOperation(ctx, operationId)
      : await latestProviderOperationForEntity(ctx, "subscription", subscriptionId);
  if (operation === null || operation.entityId !== subscriptionId || operation.entityType !== "subscription") {
    return {
      ok: false,
      code: "precondition_failed",
      message: "no fulfillment operation for this subscription; request fulfillment first",
    };
  }
  if (operation.status !== "SUCCEEDED") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `fulfillment postcondition not met: operation is ${operation.status}`,
    };
  }
  const cycle = await getOpenCycle(ctx, subscriptionId);
  if (cycle === null) {
    return { ok: false, code: "precondition_failed", message: "subscription has no open cycle" };
  }
  const at = now();
  const updated = await updateSubscription(
    ctx,
    subscriptionId,
    { status: "ACTIVE", startedAt: subscription.startedAt ?? at },
    "PENDING_ACTIVATION",
  );
  if (updated === null) {
    return { ok: false, code: "precondition_failed", message: "subscription left PENDING_ACTIVATION concurrently" };
  }
  const opened = await updateCycle(ctx, cycle.id, { status: "ACTIVE" }, "PENDING");
  if (opened === null) {
    return { ok: false, code: "precondition_failed", message: "cycle left PENDING concurrently" };
  }
  await updateEntitlementsStatusBySource(ctx, "subscription", subscriptionId, "ACTIVE");
  for (const entitlement of await listEntitlementsBySource(ctx, "subscription", subscriptionId)) {
    await insertGrant(ctx, {
      entitlementId: entitlement.id,
      grantType: "INITIAL",
      startsAt: cycle.startsAt,
      endsAt: cycle.endsAt,
      sourceType: "subscription_cycle",
      sourceId: cycle.id,
    });
  }
  // Postcondition readback evidence: what the provider observed when the
  // effect was verified (echo stub validates the expected synthetic state).
  await insertProviderEvidence(ctx, {
    operationId: operation.id,
    evidenceType: "ACTIVATION_POSTCONDITION",
    objectRef: `subscription:${subscriptionId}`,
    structured: {
      subscription_id: subscriptionId,
      cycle_id: cycle.id,
      effect_certainty: operation.effectCertainty,
      result_summary: operation.resultSummary ?? {},
    },
  });
  const personId = await getPersonIdForCustomer(ctx, subscription.customerId);
  if (personId !== null) {
    try {
      await appendCredentialNotification(ctx, {
        personId,
        subscriptionId,
        fulfillmentRef: operation.id,
      });
    } catch (err) {
      if (!(err instanceof UniqueViolationError) &&
        !(typeof err === "object" && err !== null && (err as { code?: string }).code === "23505")) {
        throw err;
      }
      // Notification already recorded for this subscription — idempotent.
    }
  }
  // No registry-listed subscription public v1 exists (known gaps):
  // audit-only by design.
  return {
    ok: true,
    data: { id: subscription.id, status: "ACTIVE", already: false, cycleId: cycle.id, operationId: operation.id },
  };
}

async function handleActivate(
  ctx: CommandHandlerContext,
  input: ActivateInput,
): Promise<CommandResult<ActivationResult>> {
  return activateSubscriptionInternal(ctx, input.subscriptionId, input.operationId);
}

async function handleCancelAtPeriodEnd(
  ctx: CommandHandlerContext,
  input: SubscriptionIdInput,
): Promise<CommandResult<{ id: string; cancelAtPeriodEnd: boolean }>> {
  const subscription = await getSubscription(ctx, input.subscriptionId);
  if (subscription === null) {
    return { ok: false, code: "not_found", message: "subscription not found in this tenant" };
  }
  if (subscription.status !== "ACTIVE") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `subscription is ${subscription.status}; only ACTIVE subscriptions schedule cancel_at_period_end`,
    };
  }
  if (subscription.cancelAtPeriodEnd) {
    return { ok: true, data: { id: subscription.id, cancelAtPeriodEnd: true } };
  }
  const updated = await updateSubscription(
    ctx,
    subscription.id,
    { cancelAtPeriodEnd: true, cancelledAt: now() },
    "ACTIVE",
  );
  if (updated === null) {
    return { ok: false, code: "precondition_failed", message: "subscription left ACTIVE concurrently" };
  }
  // Access continues through the current cycle; ENDED arrives via
  // `subscription.expire_cycles_due`. Audit-only (registry gap).
  return { ok: true, data: { id: subscription.id, cancelAtPeriodEnd: true } };
}

async function handleResume(
  ctx: CommandHandlerContext,
  input: SubscriptionIdInput,
): Promise<CommandResult<{ id: string; cancelAtPeriodEnd: boolean }>> {
  const subscription = await getSubscription(ctx, input.subscriptionId);
  if (subscription === null) {
    return { ok: false, code: "not_found", message: "subscription not found in this tenant" };
  }
  if (!subscription.cancelAtPeriodEnd) {
    return { ok: true, data: { id: subscription.id, cancelAtPeriodEnd: false } };
  }
  if (subscription.status !== "ACTIVE" && subscription.status !== "SUSPENDED") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `subscription is ${subscription.status}; resume only clears the flag on ACTIVE/SUSPENDED`,
    };
  }
  const updated = await updateSubscription(ctx, subscription.id, { cancelAtPeriodEnd: false, cancelledAt: null });
  if (updated === null) {
    return { ok: false, code: "precondition_failed", message: "subscription changed concurrently" };
  }
  return { ok: true, data: { id: subscription.id, cancelAtPeriodEnd: false } };
}

async function handleSuspend(
  ctx: CommandHandlerContext,
  input: SuspendInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const subscription = await getSubscription(ctx, input.subscriptionId);
  if (subscription === null) {
    return { ok: false, code: "not_found", message: "subscription not found in this tenant" };
  }
  // Explicit service-policy decision only — safe default DENY. A late
  // payment webhook alone can never reach this command (the billing webhook
  // path never touches subscriptions).
  const rows = await ctx.tx.listPublishedPolicies(SUSPENSION_POLICY_FAMILY, ctx.tenantId);
  const { document } = mergePolicyRows(rows);
  if (!parseSuspensionPolicy(document).allowed) {
    return {
      ok: false,
      code: "forbidden",
      message: "subscription suspension is not allowed by service policy",
    };
  }
  if (!isSubscriptionTransition(subscription.status, "SUSPENDED")) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `subscription is ${subscription.status}; only ACTIVE suspends`,
    };
  }
  const updated = await updateSubscription(ctx, subscription.id, { status: "SUSPENDED" }, "ACTIVE");
  if (updated === null) {
    return { ok: false, code: "precondition_failed", message: "subscription left ACTIVE concurrently" };
  }
  const open = await getOpenCycle(ctx, subscription.id);
  if (open !== null) {
    await updateEntitlementsStatusBySource(ctx, "subscription", subscription.id, "SUSPENDED");
  }
  return { ok: true, data: { id: subscription.id, status: "SUSPENDED" } };
}

async function handleReinstate(
  ctx: CommandHandlerContext,
  input: SubscriptionIdInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const subscription = await getSubscription(ctx, input.subscriptionId);
  if (subscription === null) {
    return { ok: false, code: "not_found", message: "subscription not found in this tenant" };
  }
  if (subscription.status === "ACTIVE") {
    return { ok: true, data: { id: subscription.id, status: "ACTIVE" } };
  }
  if (!isSubscriptionTransition(subscription.status, "ACTIVE")) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `subscription is ${subscription.status}; only SUSPENDED reinstates`,
    };
  }
  const updated = await updateSubscription(ctx, subscription.id, { status: "ACTIVE" }, "SUSPENDED");
  if (updated === null) {
    return { ok: false, code: "precondition_failed", message: "subscription left SUSPENDED concurrently" };
  }
  await updateEntitlementsStatusBySource(ctx, "subscription", subscription.id, "ACTIVE");
  return { ok: true, data: { id: subscription.id, status: "ACTIVE" } };
}

async function handleExpireCyclesDue(
  ctx: CommandHandlerContext,
  input: ExpireCyclesDueInput,
): Promise<CommandResult<{ expired: string[]; ended: string[] }>> {
  const at = now();
  const expired: string[] = [];
  const ended: string[] = [];
  const due = await listDueCycles(ctx, at, input.limit);
  for (const cycle of due) {
    const closed = await updateCycle(ctx, cycle.id, { status: "COMPLETED" });
    if (closed === null) {
      continue;
    }
    await updateEntitlementsStatusBySource(ctx, "subscription", cycle.subscriptionId, "EXPIRED");
    expired.push(cycle.id);
    // ENDED only when the customer asked out (cancel_at_period_end) and no
    // renewal cycle exists. Renewal itself is Wave 9 — never open one here.
    const subscription = await getSubscription(ctx, cycle.subscriptionId);
    if (subscription === null || !subscription.cancelAtPeriodEnd) {
      continue;
    }
    if (subscription.status !== "ACTIVE" && subscription.status !== "SUSPENDED") {
      continue;
    }
    const stillOpen = await getOpenCycle(ctx, subscription.id);
    if (stillOpen !== null) {
      continue;
    }
    const endedRow = await updateSubscription(ctx, subscription.id, { status: "ENDED" }, subscription.status);
    if (endedRow !== null) {
      ended.push(subscription.id);
      // No registry-listed cycle/end public v1 exists (known gaps:
      // `subscription.cycle.started|ended` stay unversioned), so the
      // ENDED transition is audit-only. `subscription.renewed.v1` is a
      // renewal fact and must NOT be reused as an ending signal.
    }
  }
  return { ok: true, data: { expired, ended } };
}

export function registerSubscriptionCommands(bus: CommandBus): void {
  bus.register<ActivateFromOrderInput, { id: string; status: string; already: boolean }>({
    name: "subscription.activate_from_order",
    permission: "subscription.write",
    auditAction: "subscription.activate_from_order",
    auditResource: "subscription",
    input: activateFromOrderInput,
    handler: handleActivateFromOrder,
  });
  bus.register<ActivateInput, ActivationResult>({
    name: "subscription.activate",
    permission: "subscription.write",
    auditAction: "subscription.activate",
    auditResource: "subscription",
    input: activateInput,
    handler: handleActivate,
  });
  bus.register<SubscriptionIdInput, { id: string; cancelAtPeriodEnd: boolean }>({
    name: "subscription.cancel_at_period_end",
    permission: "subscription.write",
    auditAction: "subscription.cancel_at_period_end",
    auditResource: "subscription",
    input: subscriptionIdInput,
    handler: handleCancelAtPeriodEnd,
  });
  bus.register<SubscriptionIdInput, { id: string; cancelAtPeriodEnd: boolean }>({
    name: "subscription.resume",
    permission: "subscription.write",
    auditAction: "subscription.resume",
    auditResource: "subscription",
    input: subscriptionIdInput,
    handler: handleResume,
  });
  bus.register<SuspendInput, { id: string; status: string }>({
    name: "subscription.suspend",
    permission: "subscription.write",
    auditAction: "subscription.suspend",
    auditResource: "subscription",
    input: suspendInput,
    handler: handleSuspend,
  });
  bus.register<SubscriptionIdInput, { id: string; status: string }>({
    name: "subscription.reinstate",
    permission: "subscription.write",
    auditAction: "subscription.reinstate",
    auditResource: "subscription",
    input: subscriptionIdInput,
    handler: handleReinstate,
  });
  bus.register<ExpireCyclesDueInput, { expired: string[]; ended: string[] }>({
    name: "subscription.expire_cycles_due",
    permission: "subscription.write",
    auditAction: "subscription.expire_cycles_due",
    auditResource: "subscription_cycle",
    input: expireCyclesDueInput,
    handler: handleExpireCyclesDue,
  });
}

export async function getSubscriptionView(
  ctx: CommandHandlerContext,
  subscriptionId: string,
): Promise<SubscriptionView | null> {
  const row = await getSubscription(ctx, subscriptionId);
  return row === null ? null : toSubscriptionView(row);
}

export async function listSubscriptionViews(
  ctx: CommandHandlerContext,
  input: ListSubscriptionsInput,
): Promise<SubscriptionView[]> {
  const rows = await listSubscriptions(ctx, { status: input.status, limit: input.limit });
  return rows.map((row) => toSubscriptionView(row));
}

/**
 * Failure exception for a dead fulfillment effect: a MANUAL_EXECUTION
 * HumanReview so a provider operator handles it. The subscription stays
 * PENDING_ACTIVATION — a FAILED effect never grants access.
 */
export async function openFulfillmentFailureReview(
  ctx: CommandHandlerContext,
  subscriptionId: string,
  operationId: string,
): Promise<{ reviewRequestId: string }> {
  const stored = await ctx.tx.createReviewRequest({
    resourceType: "subscription",
    resourceId: subscriptionId,
    reviewMode: "MANUAL_EXECUTION",
    reason: "PROVIDER_EXCEPTION",
    riskClass: "R2",
    priority: "HIGH",
    summary: `Subscription fulfillment failed for ${subscriptionId}: manual provider handling required`,
    contextJson: { subscription_id: subscriptionId, operation_id: operationId },
    requestedByType: ctx.actor.actorType,
    requestedById: ctx.actor.userId,
  });
  return { reviewRequestId: stored.id };
}

/**
 * Resume hook for `entity_type=subscription` provider operations, called
 * from the Wave 4 `provider.resolve_operation` / `provider.reconcile`
 * terminal paths (SUCCEEDED → activate with postcondition readback;
 * FAILED → HUMAN_REQUIRED-shaped HumanReview, subscription stays
 * PENDING_ACTIVATION). Emits nothing itself: the caller already emitted
 * the registry-listed `provider.operation_succeeded|failed.v1`.
 */
export async function resumeLinkedSubscription(
  ctx: CommandHandlerContext,
  subscriptionId: string,
  terminal: "SUCCEEDED" | "FAILED",
  operationId: string,
): Promise<{ resumedSubscription: boolean; reviewRequestId?: string }> {
  if (terminal === "SUCCEEDED") {
    const operation = await getProviderOperation(ctx, operationId);
    const externalRef =
      typeof operation?.resultSummary?.["external_ref"] === "string"
        ? (operation.resultSummary["external_ref"] as string)
        : null;
    if (operation !== null && externalRef !== null) {
      await upsertSubscriptionBinding(ctx, {
        providerAccountId: operation.providerAccountId,
        subscriptionId,
        externalId: externalRef,
      });
    }
    const activated = await activateSubscriptionInternal(ctx, subscriptionId, operationId);
    return { resumedSubscription: activated.ok };
  }
  const { reviewRequestId } = await openFulfillmentFailureReview(ctx, subscriptionId, operationId);
  return { resumedSubscription: false, reviewRequestId };
}
