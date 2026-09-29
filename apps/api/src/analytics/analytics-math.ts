/**
 * Wave 14 pure analytics math (no I/O).
 *
 * Canonical formulas are owned by `docs/08-data-analytics/metric-catalog.md`
 * and `../finance/finance-math.js` (FIN-01/FIN-04/ACQ-04 — imported, never
 * re-derived here). This module only adds the small bucket/ratio helpers
 * the projections and the unit tests share. Money stays integer minor
 * units (`bigint`); ratios are integer basis points (never floats).
 */

export function bucketDayUTC(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export function eachDayUTC(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  let cursor = bucketDayUTC(from).getTime();
  const end = bucketDayUTC(to).getTime();
  while (cursor <= end) {
    days.push(new Date(cursor));
    cursor += 86_400_000;
  }
  return days;
}

export function bucketKeyUTC(at: Date): string {
  return bucketDayUTC(at).toISOString();
}

/**
 * Integer ratio in basis points (×10_000, floor toward zero), or null when
 * the denominator is zero — callers surface "no eligible population"
 * instead of inventing a rate (denominator-bias guard, catalog §19).
 */
export function rateBps(numerator: bigint | number, denominator: bigint | number): bigint | null {
  const n = typeof numerator === "bigint" ? numerator : BigInt(numerator);
  const d = typeof denominator === "bigint" ? denominator : BigInt(denominator);
  if (d === 0n) {
    return null;
  }
  return (n * 10_000n) / d;
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

export interface TrialOutcomeRow {
  trialId: string;
  summaryOutcome: string;
}

/**
 * TRIAL-03 over fixture rows: PASSED / (PASSED + FAILED). INCONCLUSIVE,
 * INVALIDATED and provider-caused failures are reported separately and
 * never silently folded into FAIL.
 */
export function summarizeTrialTechnicalPass(rows: TrialOutcomeRow[]): {
  passed: number;
  failed: number;
  inconclusive: number;
  passRateBps: bigint | null;
} {
  let passed = 0;
  let failed = 0;
  let inconclusive = 0;
  for (const row of rows) {
    if (row.summaryOutcome === "PASSED") {
      passed += 1;
    } else if (row.summaryOutcome === "FAILED") {
      failed += 1;
    } else {
      inconclusive += 1;
    }
  }
  return { passed, failed, inconclusive, passRateBps: rateBps(passed, passed + failed) };
}

export interface ReferralStatusRow {
  referralId: string;
  status: string;
}

/**
 * REF-04 over fixture rows: confirmed / attributed-eligible. Only terminal
 * CONFIRMED counts as converted; EXPIRED/REVERSED stay in the denominator
 * when they were attributed (no denominator bias).
 */
export function summarizeReferralConversion(rows: ReferralStatusRow[]): {
  created: number;
  confirmed: number;
  conversionRateBps: bigint | null;
} {
  const created = rows.length;
  const confirmed = rows.filter((r) => r.status === "CONFIRMED").length;
  return { created, confirmed, conversionRateBps: rateBps(confirmed, created) };
}

export interface MoneyRow {
  amountMinor: string | number | bigint;
}

/** Exact minor-unit sum over fixture rows (SALES/FIN revenue slices). */
export function sumMinor(rows: MoneyRow[]): bigint {
  return rows.reduce((acc, r) => acc + toMinorStrict(r.amountMinor), 0n);
}

// Re-exported so unit tests exercise the staleness contract without HTTP.
export function stalenessHours(now: Date, computedAt: Date | null): number | null {
  if (computedAt === null) {
    return null;
  }
  return Math.max(0, (now.getTime() - computedAt.getTime()) / 3_600_000);
}
