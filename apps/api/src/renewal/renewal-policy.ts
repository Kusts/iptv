/**
 * Wave 9 Renewal + Retention policy helpers (pure, unit-tested).
 *
 * Canonical rules (docs/15-implementation-baseline/02 + 03 + 06):
 * - A renewed period is a NEW SubscriptionCycle of the SAME
 *   CustomerSubscription; the subscription persists across renewals.
 * - `subscription.renewal` policy family: `window_days` (default 7) opens
 *   the quote window `[cycle_end - window_days, cycle_end]`; quoting before
 *   the window (`early`) is allowed only when `early_allowed` is true.
 *   Quoting after the cycle end is never a renewal — that path belongs to
 *   trust renewal (policy-gated, human-reviewed) or overdue expiry.
 * - `subscription.trust_renewal` policy family: Trust Renewal is NOT a
 *   regular renewal — it grants a bounded extension without payment,
 *   human-reviewed by default. Documented trial semantics (+3d ACTIVE &
 *   remaining<=3) are mirrored for subscriptions as the safe default:
 *   `max_extension_days` (default 3), `max_remaining_days` (default 3),
 *   `require_review` (default true).
 * - RENEWAL_DUE / OVERDUE / GRACE stay COMPUTED projections, never stored;
 *   the helpers below agree with `computeProjectedState` under default
 *   policy (covered by the interplay test).
 */

export const RENEWAL_POLICY_FAMILY = "subscription.renewal";
export const SUBSCRIPTION_TRUST_RENEWAL_FAMILY = "subscription.trust_renewal";

const DAY_MS = 86_400_000;

export interface RenewalPolicy {
  windowDays: number;
  earlyAllowed: boolean;
  graceDays: number;
}

export const DEFAULT_RENEWAL_POLICY: RenewalPolicy = {
  windowDays: 7,
  earlyAllowed: false,
  graceDays: 3,
};

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Parse a merged `subscription.renewal` document; unknown shapes fall back safely. */
export function parseRenewalPolicy(doc: Record<string, unknown> | null): RenewalPolicy {
  if (doc === null) {
    return { ...DEFAULT_RENEWAL_POLICY };
  }
  return {
    windowDays: asPositiveNumber(doc["window_days"], DEFAULT_RENEWAL_POLICY.windowDays),
    earlyAllowed: asBoolean(doc["early_allowed"], DEFAULT_RENEWAL_POLICY.earlyAllowed),
    graceDays: asPositiveNumber(doc["grace_days"], DEFAULT_RENEWAL_POLICY.graceDays),
  };
}

export type RenewalQuoteDecision =
  | { allowed: true; early: boolean }
  | { allowed: false; reason: string };

/**
 * Pure renewal-quote window gate (boundary-exact):
 * - `at > cycleEnd` → denied (window closed; trust/expiry own that path).
 * - `at >= cycleEnd - windowDays` → allowed, in-window.
 * - earlier → allowed only when `earlyAllowed`, flagged `early: true`.
 * Exactly `windowDays` before the end is in-window; one millisecond past
 * the end is closed.
 */
export function decideRenewalQuote(
  policy: RenewalPolicy,
  input: { cycleEnd: Date; at: Date },
): RenewalQuoteDecision {
  const remainingMs = input.cycleEnd.getTime() - input.at.getTime();
  if (remainingMs < 0) {
    return { allowed: false, reason: "renewal window closed: the cycle already ended" };
  }
  if (remainingMs <= policy.windowDays * DAY_MS) {
    return { allowed: true, early: false };
  }
  if (policy.earlyAllowed) {
    return { allowed: true, early: true };
  }
  return {
    allowed: false,
    reason: `early renewal is not allowed by policy (window opens ${policy.windowDays} days before cycle end)`,
  };
}

export interface SubscriptionTrustRenewalPolicy {
  allow: boolean;
  maxExtensionDays: number;
  maxRemainingDays: number;
  requireReview: boolean;
}

/** Safe default mirroring the documented trial rule: +3d, remaining<=3, reviewed. */
export const DEFAULT_SUBSCRIPTION_TRUST_POLICY: SubscriptionTrustRenewalPolicy = {
  allow: true,
  maxExtensionDays: 3,
  maxRemainingDays: 3,
  requireReview: true,
};

/** Parse a merged `subscription.trust_renewal` document; unknown shapes fall back safely. */
export function parseSubscriptionTrustPolicy(
  doc: Record<string, unknown> | null,
): SubscriptionTrustRenewalPolicy {
  if (doc === null) {
    return { ...DEFAULT_SUBSCRIPTION_TRUST_POLICY };
  }
  return {
    allow: asBoolean(doc["allow"], DEFAULT_SUBSCRIPTION_TRUST_POLICY.allow),
    maxExtensionDays: asPositiveNumber(
      doc["max_extension_days"],
      DEFAULT_SUBSCRIPTION_TRUST_POLICY.maxExtensionDays,
    ),
    maxRemainingDays: asPositiveNumber(
      doc["max_remaining_days"],
      DEFAULT_SUBSCRIPTION_TRUST_POLICY.maxRemainingDays,
    ),
    requireReview: asBoolean(doc["require_review"], DEFAULT_SUBSCRIPTION_TRUST_POLICY.requireReview),
  };
}

export type SubscriptionTrustDecision =
  | { allowed: true; extensionDays: number; remainingMs: number }
  | { allowed: false; reason: string };

/**
 * Pure trust-renewal gate (boundary-exact): ACTIVE only,
 * `remaining <= maxRemainingDays` (exactly 3 days remaining is allowed,
 * 4 days is denied under the default policy). No lower bound — a cycle in
 * GRACE may still receive a bounded extension.
 */
export function decideSubscriptionTrustRenewal(
  policy: SubscriptionTrustRenewalPolicy,
  input: { status: string; cycleEnd: Date | null; at: Date },
): SubscriptionTrustDecision {
  if (!policy.allow) {
    return { allowed: false, reason: "trust renewal is disabled by policy" };
  }
  if (input.status !== "ACTIVE") {
    return { allowed: false, reason: `subscription is ${input.status}; trust renewal requires ACTIVE` };
  }
  if (input.cycleEnd === null) {
    return { allowed: false, reason: "subscription has no open cycle to extend" };
  }
  const remainingMs = input.cycleEnd.getTime() - input.at.getTime();
  if (remainingMs > policy.maxRemainingDays * DAY_MS) {
    return {
      allowed: false,
      reason: `remaining time exceeds the policy threshold of ${policy.maxRemainingDays} days`,
    };
  }
  return { allowed: true, extensionDays: policy.maxExtensionDays, remainingMs };
}

/** Cap a requested extension at the policy maximum (positive integer days). */
export function capExtensionDays(requested: number | undefined, maxExtensionDays: number): number {
  if (requested === undefined) {
    return maxExtensionDays;
  }
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new Error(`extension days must be a positive integer, got ${requested}`);
  }
  return Math.min(requested, maxExtensionDays);
}

/** Reminder idempotency key: one internal record per subscription cycle. */
export function renewalReminderKey(subscriptionId: string, cycleId: string): string {
  return `renewal-reminder:${subscriptionId}:${cycleId}`;
}
