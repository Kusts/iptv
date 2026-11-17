import { describe, expect, it } from "vitest";
import {
  APPROVED_CATALOG,
  applyEarlyRenewalDiscount,
  additionalScreenPriceFor,
  calculateTotal,
  describeApprovedCatalog,
  formatBRL,
  earlyRenewalDiscountMinor,
  EARLY_RENEWAL_DISCOUNT_MINOR,
  planDurationMonths,
  planPriceFor,
  type ApprovedPlanPeriod,
} from "../src/commerce/approved-catalog.js";

const periods: Array<{ period: ApprovedPlanPeriod; months: number; plan: number; addon: number }> = [
  { period: "P1M", months: 1, plan: 3000, addon: 2000 },
  { period: "P3M", months: 3, plan: 7500, addon: 6000 },
  { period: "P6M", months: 6, plan: 15000, addon: 10000 },
  { period: "P12M", months: 12, plan: 30000, addon: 15000 },
];

describe("approved commercial catalog", () => {
  it("exposes approved plan and addon prices for every period", () => {
    for (const { period, plan, addon } of periods) {
      expect(planPriceFor(period)).toBe(plan);
      expect(additionalScreenPriceFor(period)).toBe(addon);
      expect(APPROVED_CATALOG.plans[period]).toMatchObject({ amountMinor: plan, currency: "BRL" });
      expect(APPROVED_CATALOG.additionalScreen[period]).toMatchObject({ amountMinor: addon, currency: "BRL" });
    }
  });

  it("calculates totals for 0, 1, 2 and 5 additional screens at every period", () => {
    for (const { period, plan, addon } of periods) {
      for (const screens of [0, 1, 2, 5]) {
        expect(calculateTotal(period, screens)).toBe(plan + screens * addon);
      }
    }
    expect(calculateTotal("P3M", 2)).toBe(19500);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid additional screen count %s",
    (screens) => expect(() => calculateTotal("P1M", screens)).toThrow(RangeError),
  );

  it.each([[3000, "R$ 30,00"], [19500, "R$ 195,00"], [0, "R$ 0,00"]] as const)(
    "formats %i minor units as %s",
    (amount, formatted) => expect(formatBRL(amount)).toBe(formatted),
  );

  it("returns the duration in months", () => {
    for (const { period, months } of periods) expect(planDurationMonths(period)).toBe(months);
  });

  it("applies the fixed discount only to eligible early renewals", () => {
    expect(EARLY_RENEWAL_DISCOUNT_MINOR).toBe(500);
    expect(earlyRenewalDiscountMinor(true)).toBe(500);
    expect(earlyRenewalDiscountMinor(false)).toBe(0);
    expect(applyEarlyRenewalDiscount(3000 + 2000, true)).toBe(4500);
    expect(applyEarlyRenewalDiscount(7500 + 2 * 6000, true)).toBe(19000);
    expect(applyEarlyRenewalDiscount(3000, true)).toBe(2500);
    expect(applyEarlyRenewalDiscount(5000, false)).toBe(5000);
    expect(() => applyEarlyRenewalDiscount(499, true)).toThrow(RangeError);
    expect(applyEarlyRenewalDiscount(499, false)).toBe(499);
  });

  it("includes approval provenance and audit description", () => {
    expect(APPROVED_CATALOG.metadata).toMatchObject({
      approver: "Proprietário do StreamMax",
      approvedAt: "2026-11-17",
      version: "V1.0",
    });
    expect(describeApprovedCatalog()).toContain("Proprietário do StreamMax");
    expect(describeApprovedCatalog()).toContain("2026-11-17");
    expect(describeApprovedCatalog()).toContain("Regra B aprovada");
    expect(describeApprovedCatalog()).toContain("backend (early)");
  });
});
