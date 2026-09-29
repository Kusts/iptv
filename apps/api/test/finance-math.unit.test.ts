import { describe, expect, it } from "vitest";
import {
  bpsToPercentString,
  cohortMonthKey,
  computeContribution,
  normalizeMrrMinor,
  toMinorStrict,
} from "../src/finance/finance-math.js";
import { __test__ } from "../src/finance/finance.controller.js";

describe("finance-math FIN-04 contribution", () => {
  it("subtracts COGS, variable costs, refunds and chargebacks from revenue", () => {
    const result = computeContribution({
      revenueMinor: 6000n,
      cogsMinor: 2000n,
      variableMinor: 500n,
      refundsMinor: 1000n,
      chargebacksMinor: 0n,
    });
    expect(result.contributionMinor).toBe(2500n);
    // 2500/6000 = 41.66% → 4166bps (integer floor).
    expect(result.marginBps).toBe(4166n);
    expect(bpsToPercentString(result.marginBps as bigint)).toBe("41.66");
  });

  it("reports null margin when revenue is zero (no invented ratio)", () => {
    const result = computeContribution({
      revenueMinor: 0n,
      cogsMinor: 0n,
      variableMinor: 0n,
      refundsMinor: 0n,
      chargebacksMinor: 0n,
    });
    expect(result.contributionMinor).toBe(0n);
    expect(result.marginBps).toBeNull();
  });

  it("goes negative when costs exceed revenue", () => {
    const result = computeContribution({
      revenueMinor: 1000n,
      cogsMinor: 1500n,
      variableMinor: 0n,
      refundsMinor: 0n,
      chargebacksMinor: 0n,
    });
    expect(result.contributionMinor).toBe(-500n);
    expect(result.marginBps).toBe(-5000n);
    expect(bpsToPercentString(result.marginBps as bigint)).toBe("-50.00");
  });
});

describe("finance-math FIN-01 MRR normalization", () => {
  it("normalizes the canonical annual example (R$225 → R$18,75)", () => {
    expect(normalizeMrrMinor(22500n, "YEAR", 1)).toBe(1875n);
  });

  it("handles monthly plans with counts", () => {
    expect(normalizeMrrMinor(3000n, "MONTH", 1)).toBe(3000n);
    expect(normalizeMrrMinor(9000n, "MONTH", 3)).toBe(3000n);
  });

  it("returns null for unknown intervals instead of guessing", () => {
    expect(normalizeMrrMinor(3000n, "LIFETIME", 1)).toBeNull();
    expect(normalizeMrrMinor(3000n, "MONTH", 0)).toBeNull();
  });
});

describe("finance-math helpers", () => {
  it("parses exact minor strings and rejects decimals", () => {
    expect(toMinorStrict("6000")).toBe(6000n);
    expect(() => toMinorStrict("10.5")).toThrow();
  });

  it("keys cohorts by UTC month", () => {
    expect(cohortMonthKey(new Date("2026-09-15T10:00:00Z"))).toBe("2026-09");
    expect(cohortMonthKey(new Date("2026-01-31T23:59:59Z"))).toBe("2026-01");
  });
});

describe("finance degraded-shape contract (F14)", () => {
  it("degraded contribution carries zeros plus quality flag", () => {
    const degraded = __test__.degradedContribution("00000000-0000-4000-8000-000000000001");
    expect(degraded.contributionMinor).toBe("0");
    expect(degraded.dataQuality).toBe("DEGRADED");
    expect(degraded.aiCostStatus).toBe("BASELINE_UNAVAILABLE");
  });

  it("degraded overview carries zeros plus quality flag", () => {
    const degraded = __test__.degradedOverview();
    expect(degraded.mrrMinor).toBe("0");
    expect(degraded.dataQuality).toBe("DEGRADED");
  });
});
