import { describe, expect, it } from "vitest";
import {
  GIFT_PASS_TRANSITIONS,
  REFERRAL_TRANSITIONS,
  REWARD_TRANSITIONS,
  decideQualification,
  isGiftPassTransition,
  isReferralTransition,
  isRewardTransition,
  isWithinQualificationWindow,
  outstandingRewardBalance,
  parseQualificationPolicy,
  shouldReverseReferral,
  sizeAdvocateCredit,
  type QualificationEvidence,
} from "../src/referral/referral-policy.js";

const CLEAN: QualificationEvidence = {
  orderSettled: true,
  orderNetMinor: 3000n,
  paymentCovered: true,
  isSelfReferral: false,
  conversionPersonMismatch: false,
  withinWindow: true,
  conversionReversed: false,
  isDuplicate: false,
  hasRiskSignal: false,
  isNonEconomicConversion: false,
};

describe("Wave 12 referral policy (pure)", () => {
  it("referral transitions follow the lifecycle (no invite-only confirm)", () => {
    expect(isReferralTransition("CREATED", "ATTRIBUTED")).toBe(true);
    expect(isReferralTransition("ATTRIBUTED", "QUALIFYING")).toBe(true);
    expect(isReferralTransition("QUALIFYING", "CONFIRMED")).toBe(true);
    expect(isReferralTransition("QUALIFYING", "REJECTED")).toBe(true);
    expect(isReferralTransition("CONFIRMED", "REVERSED")).toBe(true);
    // CA-01: confirmation never skips qualification.
    expect(isReferralTransition("CREATED", "CONFIRMED")).toBe(false);
    expect(isReferralTransition("ATTRIBUTED", "CONFIRMED")).toBe(false);
    expect(isReferralTransition("CONFIRMED", "REJECTED")).toBe(false);
    expect(REFERRAL_TRANSITIONS["REVERSED"]).toEqual([]);
  });

  it("reward transitions move forward only (no resurrection)", () => {
    expect(isRewardTransition("PENDING", "APPROVED")).toBe(true);
    expect(isRewardTransition("APPROVED", "ISSUED")).toBe(true);
    expect(isRewardTransition("ISSUED", "AVAILABLE")).toBe(true);
    expect(isRewardTransition("AVAILABLE", "REDEEMED")).toBe(true);
    expect(isRewardTransition("AVAILABLE", "EXPIRED")).toBe(true);
    expect(isRewardTransition("AVAILABLE", "REVOKED")).toBe(true);
    expect(isRewardTransition("REDEEMED", "AVAILABLE")).toBe(false);
    expect(isRewardTransition("PENDING", "REDEEMED")).toBe(false);
    expect(REWARD_TRANSITIONS["REVOKED"]).toEqual([]);
  });

  it("gift-pass transitions are terminal on redeem/expire/revoke", () => {
    expect(isGiftPassTransition("AVAILABLE", "REDEEMED")).toBe(true);
    expect(isGiftPassTransition("AVAILABLE", "EXPIRED")).toBe(true);
    expect(isGiftPassTransition("REDEEMED", "AVAILABLE")).toBe(false);
    expect(GIFT_PASS_TRANSITIONS["EXPIRED"]).toEqual([]);
  });

  it("clean conversion allows", () => {
    expect(decideQualification(CLEAN)).toEqual({ decision: "ALLOW", reasonCodes: [] });
  });

  it("self-referral denies first (CA-02)", () => {
    expect(decideQualification({ ...CLEAN, isSelfReferral: true })).toEqual({
      decision: "DENY",
      reasonCodes: ["SELF_REFERRAL"],
    });
  });

  it("no settled conversion denies (CA-01)", () => {
    expect(decideQualification({ ...CLEAN, orderSettled: false })).toEqual({
      decision: "DENY",
      reasonCodes: ["NO_SETTLED_CONVERSION"],
    });
  });

  it("conversion for another person denies", () => {
    expect(decideQualification({ ...CLEAN, conversionPersonMismatch: true })).toEqual({
      decision: "DENY",
      reasonCodes: ["CONVERSION_PERSON_MISMATCH"],
    });
  });

  it("unconfirmed payment denies when net > 0, passes for zero-value", () => {
    expect(decideQualification({ ...CLEAN, paymentCovered: false })).toEqual({
      decision: "DENY",
      reasonCodes: ["PAYMENT_UNCONFIRMED"],
    });
    expect(
      decideQualification({ ...CLEAN, orderNetMinor: 0n, paymentCovered: false }).decision,
    ).toBe("ALLOW");
  });

  it("refunded conversion and stale window deny", () => {
    expect(decideQualification({ ...CLEAN, conversionReversed: true })).toEqual({
      decision: "DENY",
      reasonCodes: ["CONVERSION_REVERSED"],
    });
    expect(decideQualification({ ...CLEAN, withinWindow: false })).toEqual({
      decision: "DENY",
      reasonCodes: ["WINDOW_EXPIRED"],
    });
  });

  it("non-economic conversion (redemption / zero-value) never qualifies", () => {
    expect(decideQualification({ ...CLEAN, isNonEconomicConversion: true })).toEqual({
      decision: "DENY",
      reasonCodes: ["NON_ECONOMIC_CONVERSION"],
    });
    // Precedence: self-referral still wins, redemption beats no-conversion.
    expect(
      decideQualification({ ...CLEAN, isSelfReferral: true, isNonEconomicConversion: true }),
    ).toEqual({ decision: "DENY", reasonCodes: ["SELF_REFERRAL"] });
    expect(
      decideQualification({ ...CLEAN, orderSettled: false, isNonEconomicConversion: true }),
    ).toEqual({ decision: "DENY", reasonCodes: ["NON_ECONOMIC_CONVERSION"] });
  });

  it("ambiguity reviews instead of blocking (SPEC §7)", () => {
    expect(decideQualification({ ...CLEAN, isDuplicate: true })).toEqual({
      decision: "REVIEW",
      reasonCodes: ["DUPLICATE_SIGNAL"],
    });
    expect(decideQualification({ ...CLEAN, hasRiskSignal: true })).toEqual({
      decision: "REVIEW",
      reasonCodes: ["RISK_REVIEW"],
    });
  });

  it("qualification window is boundary-exact", () => {
    const attributed = new Date("2026-09-01T00:00:00Z");
    expect(isWithinQualificationWindow(attributed, attributed, 30)).toBe(true);
    expect(
      isWithinQualificationWindow(attributed, new Date("2026-10-01T00:00:00Z"), 30),
    ).toBe(true);
    expect(
      isWithinQualificationWindow(attributed, new Date("2026-10-01T00:00:00.001Z"), 30),
    ).toBe(false);
    expect(
      isWithinQualificationWindow(attributed, new Date("2026-08-31T23:59:59.999Z"), 30),
    ).toBe(false);
  });

  it("policy parsing falls back safely", () => {
    expect(parseQualificationPolicy(null)).toEqual({ windowDays: 30 });
    expect(parseQualificationPolicy({})).toEqual({ windowDays: 30 });
    expect(parseQualificationPolicy({ window_days: -5 })).toEqual({ windowDays: 30 });
    expect(parseQualificationPolicy({ window_days: 7 })).toEqual({ windowDays: 7 });
  });

  it("advocate credit never exceeds the converted net (SPEC §9)", () => {
    expect(sizeAdvocateCredit(3000n)).toBe(3000n);
    expect(sizeAdvocateCredit(0n)).toBe(0n);
    expect(sizeAdvocateCredit(3000n, { ratioNumerator: 1n, ratioDenominator: 2n })).toBe(1500n);
    expect(sizeAdvocateCredit(3000n, { ratioNumerator: 3n, ratioDenominator: 1n })).toBe(3000n);
    expect(() => sizeAdvocateCredit(3000n, { ratioDenominator: 0n })).toThrow();
  });

  it("reversal only fires for confirmed referrals with a reversed conversion", () => {
    expect(shouldReverseReferral({ referralStatus: "CONFIRMED", conversionReversed: true })).toEqual({
      reverse: true,
      reasonCode: "CONVERSION_REVERSED",
    });
    expect(shouldReverseReferral({ referralStatus: "CONFIRMED", conversionReversed: false })).toEqual({
      reverse: false,
      reasonCode: null,
    });
    expect(shouldReverseReferral({ referralStatus: "QUALIFYING", conversionReversed: true })).toEqual({
      reverse: false,
      reasonCode: null,
    });
  });

  it("reward ledger reconciles per reward (CA-10)", () => {
    // Earn 3000, redeem 3000 → outstanding zero.
    expect(
      outstandingRewardBalance([
        { amountMinor: 3000n, pointsDelta: null },
        { amountMinor: -3000n, pointsDelta: null },
      ]),
    ).toEqual({ amountMinor: 0n, points: 0n });
    // Points-only (zero-value) rewards reconcile on points alone.
    expect(outstandingRewardBalance([{ amountMinor: null, pointsDelta: 1n }])).toEqual({
      amountMinor: 0n,
      points: 1n,
    });
  });
});
