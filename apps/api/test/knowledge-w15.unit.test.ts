import { describe, expect, it } from "vitest";
import {
  FRESHNESS_DEGRADED_THRESHOLD,
  FRESHNESS_HALF_LIFE_DAYS,
  computeFreshnessScore,
  isDegradedScore,
} from "../src/knowledge/knowledge-policy.js";

describe("knowledge freshness (Wave 15)", () => {
  it("scores a brand-new item at 1", () => {
    expect(computeFreshnessScore({ ageDays: 0 })).toBe(1);
  });

  it("halves the score at one half-life", () => {
    expect(computeFreshnessScore({ ageDays: FRESHNESS_HALF_LIFE_DAYS })).toBeCloseTo(0.5, 4);
  });

  it("decays monotonically with age", () => {
    const fresh = computeFreshnessScore({ ageDays: 10 });
    const stale = computeFreshnessScore({ ageDays: 400 });
    expect(fresh).toBeGreaterThan(stale);
    expect(stale).toBeLessThan(FRESHNESS_DEGRADED_THRESHOLD);
  });

  it("boosts recently used items within the cap", () => {
    const plain = computeFreshnessScore({ ageDays: 100 });
    const used = computeFreshnessScore({ ageDays: 100, recentUseCount: 5 });
    expect(used).toBeGreaterThan(plain);
    expect(used - plain).toBeLessThanOrEqual(0.2 + 1e-9);
    const saturated = computeFreshnessScore({ ageDays: 100, recentUseCount: 10_000 });
    expect(saturated - plain).toBeLessThanOrEqual(0.2 + 1e-9);
  });

  it("never exceeds 1 and never goes negative", () => {
    expect(computeFreshnessScore({ ageDays: 0, recentUseCount: 100 })).toBe(1);
    expect(computeFreshnessScore({ ageDays: 10_000 })).toBeGreaterThanOrEqual(0);
    expect(computeFreshnessScore({ ageDays: -5 })).toBe(1);
  });

  it("flags degraded scores at or below the threshold", () => {
    expect(isDegradedScore(FRESHNESS_DEGRADED_THRESHOLD)).toBe(true);
    expect(isDegradedScore(0)).toBe(true);
    expect(isDegradedScore(FRESHNESS_DEGRADED_THRESHOLD + 0.0001)).toBe(false);
    expect(isDegradedScore(0.9)).toBe(false);
  });
});
