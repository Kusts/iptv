/**
 * Wave 10 pure unit-economics math (no I/O, no floats on money).
 *
 * Canonical formulas (docs/08-data-analytics/metric-catalog.md):
 * - FIN-03: Gross Profit = Revenue − COGS; Gross Margin = Gross Profit / Revenue.
 * - FIN-04: Contribution Profit = Revenue − COGS − Variable/Incremental
 *   Operating Costs; Contribution Margin = Contribution Profit / Revenue.
 * - FIN-01: MRR = recurring components normalized to a monthly equivalent
 *   (annual R$225 → R$18,75 MRR). MRR is NOT cash received.
 * - ACQ-04: CAC = Acquisition Cost / New Paying Customers (Paid vs Blended;
 *   referral reward belongs to Referral CAC, never Paid CAC — REF-06).
 * - RET-04: cohort retention over 30/60/90/180/365-day marks.
 *
 * Every amount is integer minor units (`bigint`). Ratios are integer basis
 * points (×10_000) rendered as decimal strings — never IEEE floats.
 */

export const COGS_COST_TYPES = ["SUPPLIER_COGS", "PROVIDER_COGS"] as const;

/** Variable/incremental operating costs in FIN-04 scope for this slice. */
export const VARIABLE_COST_TYPES = ["MESSAGING_COST", "ACQUISITION_TOUCH", "REFERRAL_REWARD"] as const;

export interface ContributionInput {
  revenueMinor: bigint;
  cogsMinor: bigint;
  variableMinor: bigint;
  refundsMinor: bigint;
  chargebacksMinor: bigint;
}

export interface ContributionResult {
  contributionMinor: bigint;
  /** Integer basis points (×10000) or null when revenue is zero. */
  marginBps: bigint | null;
}

/**
 * FIN-04: Contribution Profit = Revenue − COGS − Variable − Refunds −
 * Chargebacks. Refunds/chargebacks reduce realized revenue (contra-revenue
 * semantics matching the REFUNDS_CONTRA / CHARGEBACK_LOSS ledger postings).
 */
export function computeContribution(input: ContributionInput): ContributionResult {
  const contribution =
    input.revenueMinor -
    input.cogsMinor -
    input.variableMinor -
    input.refundsMinor -
    input.chargebacksMinor;
  const marginBps = input.revenueMinor === 0n ? null : (contribution * 10_000n) / input.revenueMinor;
  return { contributionMinor: contribution, marginBps };
}

/** Render integer basis points as a `"12.34"` percent string. */
export function bpsToPercentString(bps: bigint): string {
  const sign = bps < 0n ? "-" : "";
  const abs = bps < 0n ? -bps : bps;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${sign}${whole.toString()}.${frac}`;
}

/**
 * FIN-01: normalize one recurring component to its monthly equivalent
 * (integer division, floor). Returns null when the interval is not a known
 * calendar unit — callers surface BASELINE_UNAVAILABLE instead of guessing.
 */
export function normalizeMrrMinor(
  baseMinor: bigint,
  intervalUnit: string,
  intervalCount: number,
): bigint | null {
  if (!Number.isInteger(intervalCount) || intervalCount <= 0) {
    return null;
  }
  const count = BigInt(intervalCount);
  switch (intervalUnit) {
    case "MONTH":
      return baseMinor / count;
    case "YEAR":
      return baseMinor / (12n * count);
    case "WEEK":
      // 52 weeks/year → monthly equivalent = base × 12 / (52 × count).
      return (baseMinor * 12n) / (52n * count);
    case "DAY":
      // 30-day commercial month.
      return (baseMinor * 30n) / count;
    default:
      return null;
  }
}

/** Parse an exact minor-unit decimal string (node-pg bigint/numeric text). */
export function toMinorStrict(value: string | number | bigint): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`money must be integer minor units, got non-integer number ${value}`);
    }
    return BigInt(value);
  }
  const text = value.trim();
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`money must be integer minor units, got ${JSON.stringify(value)}`);
  }
  return BigInt(text);
}

/** Cohort month key (`YYYY-MM`) in UTC for a customer_since instant. */
export function cohortMonthKey(at: Date): string {
  const year = at.getUTCFullYear();
  const month = (at.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${year}-${month}`;
}
