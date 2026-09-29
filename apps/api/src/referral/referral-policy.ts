/**
 * Wave 12 Referral + Rewards policy helpers (pure, unit-tested).
 *
 * Canonical rules (SPEC 08-referral-core + migration 011 DDL):
 * - Referral confirms ONLY on a valid economic conversion
 *   (`order.settled.v1` for the referred person) + anti-abuse policy —
 *   never on invite/click/Trial alone (CA-01).
 * - Evident self-referral is DENY; ambiguity prefers REVIEW over an
 *   irreversible block (SPEC §7).
 * - First-touch is preserved: one active referral per (program, person);
 *   a late referral never overwrites the original attribution (CA-07).
 * - Reward is not a mutable balance: every economic effect is an
 *   append-only `reward_ledger_entries` row (CA-10); reversal is a
 *   compensating entry, never a mutation (CA-06).
 * - Zero-value redemption orders reach SETTLED with NO Payment row
 *   (CA-04, SPEC §10).
 * - Money is exact: integer minor units as `bigint` in code, exact decimal
 *   strings at the boundary. No float/number money arithmetic.
 */

export const REFERRAL_POLICY_FAMILY = "referral.qualification";
export const REWARD_POLICY_FAMILY = "referral.reward";

/** Default qualification window: conversion must settle within 30d of attribution. */
export const DEFAULT_QUALIFICATION_WINDOW_DAYS = 30;
/** Default reward cap: the advocate credit never exceeds the converted net. */
export const DEFAULT_MAX_REWARD_RATIO_NUMERATOR = 1n;
export const DEFAULT_MAX_REWARD_RATIO_DENOMINATOR = 1n;

const DAY_MS = 86_400_000;

/** Owning-context referral transitions (subset of the migration-011 CHECK set). */
export const REFERRAL_TRANSITIONS: Record<string, readonly string[]> = {
  CREATED: ["ATTRIBUTED", "EXPIRED"],
  ATTRIBUTED: ["ENGAGED", "QUALIFYING", "EXPIRED"],
  ENGAGED: ["QUALIFYING", "EXPIRED"],
  QUALIFYING: ["CONFIRMED", "REJECTED", "EXPIRED"],
  CONFIRMED: ["REVERSED"],
  REJECTED: [],
  EXPIRED: [],
  REVERSED: [],
};

/** Owning-context reward transitions (subset of the migration-011 CHECK set). */
export const REWARD_TRANSITIONS: Record<string, readonly string[]> = {
  PENDING: ["APPROVED", "FAILED"],
  APPROVED: ["ISSUED", "REVOKED", "FAILED"],
  ISSUED: ["AVAILABLE", "REVOKED", "FAILED"],
  AVAILABLE: ["REDEEMED", "EXPIRED", "REVOKED"],
  REDEEMED: [],
  EXPIRED: [],
  REVOKED: [],
  FAILED: [],
};

/** Owning-context gift-pass transitions (subset of the migration-011 CHECK set). */
export const GIFT_PASS_TRANSITIONS: Record<string, readonly string[]> = {
  AVAILABLE: ["REDEEMED", "EXPIRED", "REVOKED"],
  REDEEMED: [],
  EXPIRED: [],
  REVOKED: [],
};

export function isReferralTransition(from: string, to: string): boolean {
  return REFERRAL_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isRewardTransition(from: string, to: string): boolean {
  return REWARD_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isGiftPassTransition(from: string, to: string): boolean {
  return GIFT_PASS_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface QualificationEvidence {
  /** The candidate conversion order settled (Wave 5 settlement fact). */
  orderSettled: boolean;
  /** Order net in minor units (exact). */
  orderNetMinor: bigint;
  /** Covering CONFIRMED payments minus succeeded refunds cover the net. */
  paymentCovered: boolean;
  /** Advocate person and referred person are the same identity. */
  isSelfReferral: boolean;
  /** The conversion order belongs to a different person than the referred one. */
  conversionPersonMismatch: boolean;
  /** Order settled within the qualification window of attribution. */
  withinWindow: boolean;
  /** A full refund/chargeback consumed the conversion during the window. */
  conversionReversed: boolean;
  /** Another active referral already covers this (program, person). */
  isDuplicate: boolean;
  /** Deterministic abuse signal (e.g. gift self-redemption pattern). */
  hasRiskSignal: boolean;
  /**
   * The candidate conversion carries no economic counterpart: a zero-value
   * ADJUSTMENT order minted by reward redemption (SPEC §10) or any other
   * non-positive-net settlement. Redemptions must never qualify.
   */
  isNonEconomicConversion: boolean;
}

export type QualificationDecision = "ALLOW" | "REVIEW" | "DENY";

export interface QualificationVerdict {
  decision: QualificationDecision;
  reasonCodes: string[];
}

/**
 * Pure qualification decision (SPEC §6 + §7). Order of checks is
 * deliberate: hard integrity failures (self, no conversion, reversed)
 * deny first; ambiguity (duplicate, risk) reviews; only a clean,
 * covered, in-window conversion allows.
 */
export function decideQualification(evidence: QualificationEvidence): QualificationVerdict {
  if (evidence.isSelfReferral) {
    return { decision: "DENY", reasonCodes: ["SELF_REFERRAL"] };
  }
  if (evidence.isNonEconomicConversion) {
    return { decision: "DENY", reasonCodes: ["NON_ECONOMIC_CONVERSION"] };
  }
  if (!evidence.orderSettled) {
    return { decision: "DENY", reasonCodes: ["NO_SETTLED_CONVERSION"] };
  }
  if (evidence.conversionPersonMismatch) {
    return { decision: "DENY", reasonCodes: ["CONVERSION_PERSON_MISMATCH"] };
  }
  if (evidence.orderNetMinor > 0n && !evidence.paymentCovered) {
    return { decision: "DENY", reasonCodes: ["PAYMENT_UNCONFIRMED"] };
  }
  if (evidence.conversionReversed) {
    return { decision: "DENY", reasonCodes: ["CONVERSION_REVERSED"] };
  }
  if (!evidence.withinWindow) {
    return { decision: "DENY", reasonCodes: ["WINDOW_EXPIRED"] };
  }
  if (evidence.isDuplicate) {
    return { decision: "REVIEW", reasonCodes: ["DUPLICATE_SIGNAL"] };
  }
  if (evidence.hasRiskSignal) {
    return { decision: "REVIEW", reasonCodes: ["RISK_REVIEW"] };
  }
  return { decision: "ALLOW", reasonCodes: [] };
}

/** Qualification window check: settled_at within windowDays of attribution. */
export function isWithinQualificationWindow(
  attributedAt: Date,
  settledAt: Date,
  windowDays: number = DEFAULT_QUALIFICATION_WINDOW_DAYS,
): boolean {
  const elapsed = settledAt.getTime() - attributedAt.getTime();
  return elapsed >= 0 && elapsed <= windowDays * DAY_MS;
}

/** Parse the merged `referral.qualification` document; unknown shapes fall back safely. */
export function parseQualificationPolicy(doc: Record<string, unknown> | null): {
  windowDays: number;
} {
  const fallback = { windowDays: DEFAULT_QUALIFICATION_WINDOW_DAYS };
  if (doc === null) {
    return { ...fallback };
  }
  const raw = doc["window_days"];
  const windowDays =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback.windowDays;
  return { windowDays };
}

/**
 * Advocate credit sizing (SPEC §9): the economic value never exceeds the
 * converted net (capped ratio, default 1:1). Exact bigint math.
 */
export function sizeAdvocateCredit(
  orderNetMinor: bigint,
  opts?: { ratioNumerator?: bigint; ratioDenominator?: bigint },
): bigint {
  const num = opts?.ratioNumerator ?? DEFAULT_MAX_REWARD_RATIO_NUMERATOR;
  const den = opts?.ratioDenominator ?? DEFAULT_MAX_REWARD_RATIO_DENOMINATOR;
  if (den <= 0n || num < 0n) {
    throw new Error("invalid reward ratio");
  }
  if (orderNetMinor <= 0n) {
    return 0n;
  }
  const sized = (orderNetMinor * num) / den;
  return sized > orderNetMinor ? orderNetMinor : sized;
}

/**
 * Reversal check (SPEC §6 window + CA-06): a CONFIRMED referral whose
 * conversion was fully refunded/charged back must reverse via a
 * compensating ledger entry — never by mutating history.
 */
export function shouldReverseReferral(input: {
  referralStatus: string;
  conversionReversed: boolean;
}): { reverse: boolean; reasonCode: string | null } {
  if (input.referralStatus !== "CONFIRMED") {
    return { reverse: false, reasonCode: null };
  }
  if (input.conversionReversed) {
    return { reverse: true, reasonCode: "CONVERSION_REVERSED" };
  }
  return { reverse: false, reasonCode: null };
}

/**
 * Reward ledger reconciliation (CA-10): per reward, Σ signed amounts
 * (EARNED positive, REDEEMED/EXPIRED/REVOKED negative, REVERSAL
 * compensating) plus Σ points must net to the outstanding balance.
 * Zero-value (points-only) rewards reconcile on points alone.
 */
export function outstandingRewardBalance(
  entries: ReadonlyArray<{ amountMinor: bigint | null; pointsDelta: bigint | null }>,
): { amountMinor: bigint; points: bigint } {
  let amountMinor = 0n;
  let points = 0n;
  for (const entry of entries) {
    amountMinor += entry.amountMinor ?? 0n;
    points += entry.pointsDelta ?? 0n;
  }
  return { amountMinor, points };
}
