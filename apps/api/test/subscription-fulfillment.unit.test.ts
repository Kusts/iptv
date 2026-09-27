import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_TRANSITIONS,
  addBillingInterval,
  computeProjectedState,
  isOpenCycleStatus,
  isSubscriptionTransition,
  parseSuspensionPolicy,
} from "../src/subscription/subscription-policy.js";

describe("Wave 6 subscription policy (pure)", () => {
  it("state set matches the migration-006 CHECK exactly", () => {
    expect([...SUBSCRIPTION_STATUSES].sort()).toEqual(
      ["ACTIVE", "ENDED", "PENDING_ACTIVATION", "SUSPENDED"].sort(),
    );
  });

  it("transition map is exhaustive over the 4-state set and has no CANCELLED", () => {
    expect(Object.keys(SUBSCRIPTION_TRANSITIONS).sort()).toEqual([...SUBSCRIPTION_STATUSES].sort());
    const targets = new Set(Object.values(SUBSCRIPTION_TRANSITIONS).flat());
    expect(targets.has("CANCELLED")).toBe(false);
    for (const target of targets) {
      expect(SUBSCRIPTION_STATUSES).toContain(target);
    }
    // Normal cancel is cancel_at_period_end, never an immediate transition.
    expect(isSubscriptionTransition("ACTIVE", "CANCELLED")).toBe(false);
    expect(isSubscriptionTransition("PENDING_ACTIVATION", "ACTIVE")).toBe(true);
    expect(isSubscriptionTransition("ACTIVE", "SUSPENDED")).toBe(true);
    expect(isSubscriptionTransition("SUSPENDED", "ACTIVE")).toBe(true);
    expect(isSubscriptionTransition("ACTIVE", "ENDED")).toBe(true);
    expect(isSubscriptionTransition("SUSPENDED", "ENDED")).toBe(true);
    expect(isSubscriptionTransition("ENDED", "ACTIVE")).toBe(false);
    expect(isSubscriptionTransition("PENDING_ACTIVATION", "ENDED")).toBe(false);
    expect(isSubscriptionTransition("PENDING_ACTIVATION", "SUSPENDED")).toBe(false);
  });

  it("projection is computed, never a stored lifecycle move", () => {
    const end = new Date("2026-10-01T00:00:00Z");
    expect(
      computeProjectedState({ status: "ACTIVE", currentPeriodEnd: end, at: new Date("2026-09-01T00:00:00Z") }),
    ).toBe("ACTIVE");
    expect(
      computeProjectedState({ status: "ACTIVE", currentPeriodEnd: end, at: new Date("2026-09-27T00:00:00Z") }),
    ).toBe("RENEWAL_DUE");
    expect(
      computeProjectedState({ status: "ACTIVE", currentPeriodEnd: end, at: new Date("2026-10-02T00:00:00Z") }),
    ).toBe("GRACE");
    expect(
      computeProjectedState({ status: "ACTIVE", currentPeriodEnd: end, at: new Date("2026-10-20T00:00:00Z") }),
    ).toBe("OVERDUE");
    // Non-ACTIVE rows pass through untouched; null end stays ACTIVE.
    expect(computeProjectedState({ status: "SUSPENDED", currentPeriodEnd: end })).toBe("SUSPENDED");
    expect(computeProjectedState({ status: "PENDING_ACTIVATION", currentPeriodEnd: null })).toBe(
      "PENDING_ACTIVATION",
    );
    expect(computeProjectedState({ status: "ACTIVE", currentPeriodEnd: null })).toBe("ACTIVE");
  });

  it("open-cycle predicate matches the 019 partial index", () => {
    expect(isOpenCycleStatus("PENDING")).toBe(true);
    expect(isOpenCycleStatus("ACTIVE")).toBe(true);
    expect(isOpenCycleStatus("COMPLETED")).toBe(false);
    expect(isOpenCycleStatus("FAILED")).toBe(false);
    expect(isOpenCycleStatus("CANCELLED")).toBe(false);
  });

  it("suspension policy defaults to DENY without an explicit allow", () => {
    expect(parseSuspensionPolicy(null).allowed).toBe(false);
    expect(parseSuspensionPolicy({}).allowed).toBe(false);
    expect(parseSuspensionPolicy({ allow: false }).allowed).toBe(false);
    expect(parseSuspensionPolicy({ allow: "yes" }).allowed).toBe(false);
    expect(parseSuspensionPolicy({ allow: true }).allowed).toBe(true);
  });

  it("billing interval math follows the catalog units", () => {
    const start = new Date("2026-01-15T10:00:00Z");
    expect(addBillingInterval(start, "DAY", 3).toISOString()).toBe("2026-01-18T10:00:00.000Z");
    expect(addBillingInterval(start, "WEEK", 2).toISOString()).toBe("2026-01-29T10:00:00.000Z");
    expect(addBillingInterval(start, "MONTH", 1).toISOString()).toBe("2026-02-15T10:00:00.000Z");
    expect(addBillingInterval(start, "YEAR", 1).toISOString()).toBe("2027-01-15T10:00:00.000Z");
    expect(() => addBillingInterval(start, "FORTNIGHT", 1)).toThrow();
  });
});
