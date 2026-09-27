/**
 * Wave 6 Subscription policy helpers (pure, unit-tested).
 *
 * Canonical rules (docs/15-implementation-baseline/03-state-machines.md):
 * - `CustomerSubscription`: PENDING_ACTIVATION | ACTIVE | SUSPENDED | ENDED.
 *   Normal cancellation is `cancel_at_period_end`, never an immediate
 *   CANCELLED state. ENDED arrives only via cycle expiry.
 * - RENEWAL_DUE / OVERDUE / GRACE are computed PROJECTIONS, never stored.
 * - Suspension requires an explicit service-policy decision, never a late
 *   webhook alone.
 * - Each paid period = one SubscriptionCycle; at most one OPEN
 *   (PENDING|ACTIVE) cycle per subscription.
 */

export const SUBSCRIPTION_STATUSES = ["PENDING_ACTIVATION", "ACTIVE", "SUSPENDED", "ENDED"] as const;

export const SUBSCRIPTION_TRANSITIONS: Record<string, readonly string[]> = {
  PENDING_ACTIVATION: ["ACTIVE"],
  ACTIVE: ["SUSPENDED", "ENDED"],
  SUSPENDED: ["ACTIVE", "ENDED"],
  ENDED: [],
};

export function isSubscriptionTransition(from: string, to: string): boolean {
  const allowed = SUBSCRIPTION_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

/** Cycle statuses that count as OPEN (covered by the 019 partial index). */
export function isOpenCycleStatus(status: string): boolean {
  return status === "PENDING" || status === "ACTIVE";
}

/**
 * Computed billing projection over an ACTIVE subscription. Anything other
 * than ACTIVE returns the stored status unchanged; RENEWAL_DUE / GRACE /
 * OVERDUE are derived from the current period end and NEVER persisted.
 */
export function computeProjectedState(input: {
  status: string;
  currentPeriodEnd: Date | null;
  at?: Date;
  renewalDueWithinDays?: number;
  graceDays?: number;
}): string {
  if (input.status !== "ACTIVE") {
    return input.status;
  }
  const end = input.currentPeriodEnd;
  if (end === null) {
    return "ACTIVE";
  }
  const at = input.at ?? new Date();
  const dueWindowMs = (input.renewalDueWithinDays ?? 7) * 86_400_000;
  const graceMs = (input.graceDays ?? 3) * 86_400_000;
  const remaining = end.getTime() - at.getTime();
  if (remaining > dueWindowMs) {
    return "ACTIVE";
  }
  if (remaining > 0) {
    return "RENEWAL_DUE";
  }
  if (at.getTime() - end.getTime() <= graceMs) {
    return "GRACE";
  }
  return "OVERDUE";
}

export interface SuspensionPolicy {
  allowed: boolean;
}

/**
 * Parse a merged `subscription.suspension` policy document. Safe default is
 * DENY: without an explicit published `{ allow: true }` no suspension may
 * proceed (in particular never from a late payment webhook alone).
 */
export function parseSuspensionPolicy(doc: Record<string, unknown> | null): SuspensionPolicy {
  if (doc === null) {
    return { allowed: false };
  }
  return { allowed: doc["allow"] === true };
}

export const SUSPENSION_POLICY_FAMILY = "subscription.suspension";

/**
 * Add a catalog billing interval to a date with calendar arithmetic
 * (MONTH/YEAR roll on the calendar; DAY/WEEK are exact multiples).
 */
export function addBillingInterval(start: Date, unit: string, count: number): Date {
  const next = new Date(start.getTime());
  switch (unit) {
    case "DAY":
      next.setUTCDate(next.getUTCDate() + count);
      return next;
    case "WEEK":
      next.setUTCDate(next.getUTCDate() + 7 * count);
      return next;
    case "MONTH":
      next.setUTCMonth(next.getUTCMonth() + count);
      return next;
    case "YEAR":
      next.setUTCFullYear(next.getUTCFullYear() + count);
      return next;
    default:
      throw new Error(`unsupported billing interval unit: ${unit}`);
  }
}
