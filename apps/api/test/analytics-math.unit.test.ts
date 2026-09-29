import { describe, expect, it } from "vitest";
import {
  bucketDayUTC,
  bucketKeyUTC,
  eachDayUTC,
  rateBps,
  stalenessHours,
  sumMinor,
  summarizeReferralConversion,
  summarizeTrialTechnicalPass,
} from "../src/analytics/analytics-math.js";
import { METRIC_DEFINITIONS, METRIC_FAMILIES, METRIC_KEYS } from "../src/analytics/analytics-catalog.js";

describe("Wave 14 analytics math (pure)", () => {
  it("buckets days in UTC and enumerates closed ranges", () => {
    expect(bucketKeyUTC(new Date("2026-09-29T23:59:59-03:00"))).toBe("2026-09-30T00:00:00.000Z");
    expect(bucketDayUTC(new Date("2026-09-29T10:00:00Z"))).toEqual(new Date("2026-09-29T00:00:00.000Z"));
    const days = eachDayUTC(new Date("2026-09-28T12:00:00Z"), new Date("2026-09-30T01:00:00Z"));
    expect(days.map((d) => d.toISOString())).toEqual([
      "2026-09-28T00:00:00.000Z",
      "2026-09-29T00:00:00.000Z",
      "2026-09-30T00:00:00.000Z",
    ]);
  });

  it("rates are integer basis points with null on empty denominators", () => {
    expect(rateBps(3, 4)).toBe(7500n);
    expect(rateBps(0, 5)).toBe(0n);
    expect(rateBps(1, 3)).toBe(3333n);
    expect(rateBps(0, 0)).toBeNull();
  });

  it("TRIAL-03 fixture: inconclusive never folds into fail", () => {
    const summary = summarizeTrialTechnicalPass([
      { trialId: "t1", summaryOutcome: "PASSED" },
      { trialId: "t2", summaryOutcome: "PASSED" },
      { trialId: "t3", summaryOutcome: "FAILED" },
      { trialId: "t4", summaryOutcome: "INCONCLUSIVE" },
      { trialId: "t5", summaryOutcome: "INVALIDATED" },
    ]);
    expect(summary).toEqual({ passed: 2, failed: 1, inconclusive: 2, passRateBps: 6666n });
  });

  it("TRIAL-03 fixture: empty conclusive population reports null, not zero", () => {
    const summary = summarizeTrialTechnicalPass([{ trialId: "t1", summaryOutcome: "INCONCLUSIVE" }]);
    expect(summary.passRateBps).toBeNull();
  });

  it("REF-04 fixture: confirmed over attributed-eligible", () => {
    const summary = summarizeReferralConversion([
      { referralId: "r1", status: "CONFIRMED" },
      { referralId: "r2", status: "ATTRIBUTED" },
      { referralId: "r3", status: "EXPIRED" },
      { referralId: "r4", status: "CONFIRMED" },
    ]);
    expect(summary).toEqual({ created: 4, confirmed: 2, conversionRateBps: 5000n });
  });

  it("money sums stay exact minor units", () => {
    expect(sumMinor([{ amountMinor: "6000" }, { amountMinor: 3000 }, { amountMinor: 150n }])).toBe(9150n);
  });

  it("staleness is null without telemetry, hours otherwise", () => {
    expect(stalenessHours(new Date(), null)).toBeNull();
    expect(
      stalenessHours(new Date("2026-09-29T12:00:00Z"), new Date("2026-09-29T06:00:00Z")),
    ).toBe(6);
  });

  it("catalog registry: keys unique, families known, refs point at the metric catalog", () => {
    expect(METRIC_DEFINITIONS.length).toBeGreaterThan(10);
    expect(new Set(METRIC_DEFINITIONS.map((d) => d.key)).size).toBe(METRIC_DEFINITIONS.length);
    for (const def of METRIC_DEFINITIONS) {
      expect(METRIC_KEYS.has(def.key)).toBe(true);
      expect(def.formulaRef.startsWith("metric-catalog.md")).toBe(true);
      expect(def.granularity).toBe("DAY");
    }
    for (const family of new Set(METRIC_DEFINITIONS.map((d) => d.family))) {
      expect((METRIC_FAMILIES as readonly string[])).toContain(family);
    }
  });
});
