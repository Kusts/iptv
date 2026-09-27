import { describe, expect, it } from "vitest";
import { computeProjectedState } from "../src/subscription/subscription-policy.js";
import {
  DEFAULT_RENEWAL_POLICY,
  DEFAULT_SUBSCRIPTION_TRUST_POLICY,
  RENEWAL_POLICY_FAMILY,
  SUBSCRIPTION_TRUST_RENEWAL_FAMILY,
  capExtensionDays,
  decideRenewalQuote,
  decideSubscriptionTrustRenewal,
  parseRenewalPolicy,
  parseSubscriptionTrustPolicy,
  renewalReminderKey,
} from "../src/renewal/renewal-policy.js";

describe("Wave 9 renewal policy (pure)", () => {
  it("family names match the canonical policy families", () => {
    expect(RENEWAL_POLICY_FAMILY).toBe("subscription.renewal");
    expect(SUBSCRIPTION_TRUST_RENEWAL_FAMILY).toBe("subscription.trust_renewal");
  });

  it("renewal policy defaults are safe (7d window, no early, 3d grace)", () => {
    expect(DEFAULT_RENEWAL_POLICY).toEqual({ windowDays: 7, earlyAllowed: false, graceDays: 3 });
    expect(parseRenewalPolicy(null)).toEqual(DEFAULT_RENEWAL_POLICY);
    expect(parseRenewalPolicy({})).toEqual(DEFAULT_RENEWAL_POLICY);
    expect(parseRenewalPolicy({ window_days: -2, early_allowed: "yes", grace_days: 0 })).toEqual(
      DEFAULT_RENEWAL_POLICY,
    );
    expect(parseRenewalPolicy({ window_days: 14, early_allowed: true, grace_days: 5 })).toEqual({
      windowDays: 14,
      earlyAllowed: true,
      graceDays: 5,
    });
  });

  it("quote window is boundary-exact: [end - window, end]", () => {
    const policy = { ...DEFAULT_RENEWAL_POLICY };
    const end = new Date("2026-10-01T00:00:00Z");
    // Far before → early denied by default.
    expect(
      decideRenewalQuote(policy, { cycleEnd: end, at: new Date("2026-09-01T00:00:00Z") }),
    ).toEqual({
      allowed: false,
      reason: expect.stringContaining("early renewal is not allowed"),
    });
    // One ms outside the window → denied; exactly on the edge → allowed.
    expect(
      decideRenewalQuote(policy, { cycleEnd: end, at: new Date("2026-09-23T23:59:59.999Z") }).allowed,
    ).toBe(false);
    const edge = decideRenewalQuote(policy, { cycleEnd: end, at: new Date("2026-09-24T00:00:00Z") });
    expect(edge).toEqual({ allowed: true, early: false });
    // Mid-window → allowed, not early.
    expect(decideRenewalQuote(policy, { cycleEnd: end, at: new Date("2026-09-27T00:00:00Z") })).toEqual({
      allowed: true,
      early: false,
    });
    // Exactly at end → still allowed (zero remaining is inside the window).
    expect(decideRenewalQuote(policy, { cycleEnd: end, at: end })).toEqual({ allowed: true, early: false });
    // One ms past end → closed, never a renewal (trust/expiry own that path).
    expect(decideRenewalQuote(policy, { cycleEnd: end, at: new Date("2026-10-01T00:00:00.001Z") })).toEqual({
      allowed: false,
      reason: expect.stringContaining("window closed"),
    });
  });

  it("early quoting opens only when the policy allows it", () => {
    const early = { ...DEFAULT_RENEWAL_POLICY, earlyAllowed: true };
    const end = new Date("2026-10-01T00:00:00Z");
    expect(
      decideRenewalQuote(early, { cycleEnd: end, at: new Date("2026-09-01T00:00:00Z") }),
    ).toEqual({ allowed: true, early: true });
  });

  it("quoting agrees with the computed RENEWAL_DUE projection under default policy", () => {
    const policy = { ...DEFAULT_RENEWAL_POLICY };
    const end = new Date("2026-10-01T00:00:00Z");
    const cases: Array<{ at: string; projected: string; quotable: boolean }> = [
      { at: "2026-09-01T00:00:00Z", projected: "ACTIVE", quotable: false },
      { at: "2026-09-24T00:00:00Z", projected: "RENEWAL_DUE", quotable: true },
      { at: "2026-09-30T12:00:00Z", projected: "RENEWAL_DUE", quotable: true },
      { at: "2026-10-02T00:00:00Z", projected: "GRACE", quotable: false },
      { at: "2026-10-20T00:00:00Z", projected: "OVERDUE", quotable: false },
    ];
    for (const c of cases) {
      const at = new Date(c.at);
      expect(computeProjectedState({ status: "ACTIVE", currentPeriodEnd: end, at })).toBe(c.projected);
      expect(decideRenewalQuote(policy, { cycleEnd: end, at }).allowed).toBe(c.quotable);
    }
    // Non-ACTIVE rows are never quotable and never projected as due.
    expect(computeProjectedState({ status: "SUSPENDED", currentPeriodEnd: end })).toBe("SUSPENDED");
    expect(
      decideSubscriptionTrustRenewal(DEFAULT_SUBSCRIPTION_TRUST_POLICY, {
        status: "SUSPENDED",
        cycleEnd: end,
        at: new Date("2026-09-30T00:00:00Z"),
      }),
    ).toEqual({ allowed: false, reason: expect.stringContaining("SUSPENDED") });
  });

  it("trust renewal defaults mirror the documented trial rule (+3d, remaining<=3, reviewed)", () => {
    expect(DEFAULT_SUBSCRIPTION_TRUST_POLICY).toEqual({
      allow: true,
      maxExtensionDays: 3,
      maxRemainingDays: 3,
      requireReview: true,
    });
    expect(parseSubscriptionTrustPolicy(null)).toEqual(DEFAULT_SUBSCRIPTION_TRUST_POLICY);
    expect(parseSubscriptionTrustPolicy({ allow: false })).toEqual({
      ...DEFAULT_SUBSCRIPTION_TRUST_POLICY,
      allow: false,
    });
    expect(
      parseSubscriptionTrustPolicy({ max_extension_days: 10, max_remaining_days: 5, require_review: false }),
    ).toEqual({ allow: true, maxExtensionDays: 10, maxRemainingDays: 5, requireReview: false });
  });

  it("trust gate is boundary-exact and ACTIVE-only", () => {
    const policy = { ...DEFAULT_SUBSCRIPTION_TRUST_POLICY };
    const end = new Date("2026-10-01T00:00:00Z");
    // 4 days remaining → denied; exactly 3 days → allowed.
    expect(
      decideSubscriptionTrustRenewal(policy, { status: "ACTIVE", cycleEnd: end, at: new Date("2026-09-27T00:00:00Z") }),
    ).toEqual({ allowed: false, reason: expect.stringContaining("threshold") });
    expect(
      decideSubscriptionTrustRenewal(policy, { status: "ACTIVE", cycleEnd: end, at: new Date("2026-09-28T00:00:00Z") }),
    ).toEqual({ allowed: true, extensionDays: 3, remainingMs: 3 * 86_400_000 });
    // GRACE (past end) stays eligible — no lower bound.
    const grace = decideSubscriptionTrustRenewal(policy, {
      status: "ACTIVE",
      cycleEnd: end,
      at: new Date("2026-10-02T00:00:00Z"),
    });
    expect(grace).toEqual({ allowed: true, extensionDays: 3, remainingMs: -86_400_000 });
    // Disabled policy and non-ACTIVE are forbidden.
    expect(
      decideSubscriptionTrustRenewal({ ...policy, allow: false }, { status: "ACTIVE", cycleEnd: end, at: end }),
    ).toEqual({ allowed: false, reason: expect.stringContaining("disabled") });
    expect(
      decideSubscriptionTrustRenewal(policy, { status: "ENDED", cycleEnd: end, at: end }).allowed,
    ).toBe(false);
    expect(
      decideSubscriptionTrustRenewal(policy, { status: "ACTIVE", cycleEnd: null, at: end }).allowed,
    ).toBe(false);
  });

  it("extension days default to the policy max and are capped", () => {
    expect(capExtensionDays(undefined, 3)).toBe(3);
    expect(capExtensionDays(1, 3)).toBe(1);
    expect(capExtensionDays(10, 3)).toBe(3);
    expect(() => capExtensionDays(0, 3)).toThrow();
    expect(() => capExtensionDays(-1, 3)).toThrow();
    expect(() => capExtensionDays(1.5, 3)).toThrow();
  });

  it("reminder key is unique per subscription cycle", () => {
    const key = renewalReminderKey("sub-1", "cycle-1");
    expect(key).toBe("renewal-reminder:sub-1:cycle-1");
    expect(renewalReminderKey("sub-1", "cycle-2")).not.toBe(key);
    expect(renewalReminderKey("sub-2", "cycle-1")).not.toBe(key);
  });
});
