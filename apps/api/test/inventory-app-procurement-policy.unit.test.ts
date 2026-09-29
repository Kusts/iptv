import { describe, expect, it } from "vitest";
import {
  evaluateAppProcurementReadiness,
  type AppProcurementPolicyInput,
} from "../src/inventory/app-procurement-policy.js";

function input(overrides: Partial<AppProcurementPolicyInput> = {}): AppProcurementPolicyInput {
  return {
    catalogItemExists: true,
    trialValidated: true,
    orderStatus: "SETTLED",
    appCostMinor: "2000",
    appCurrency: "BRL",
    supplierBalanceMinor: "5000",
    supplierCurrency: "BRL",
    ...overrides,
  };
}

describe("Wave 7 app procurement readiness gate (pure)", () => {
  it("is ready when every precondition passes", () => {
    expect(evaluateAppProcurementReadiness(input())).toEqual({
      status: "READY_FOR_RESERVATION",
      reasonCodes: ["PRECONDITIONS_MET"],
    });
  });

  it("treats exact balance as sufficient (equality is enough)", () => {
    expect(
      evaluateAppProcurementReadiness(input({ appCostMinor: "2000", supplierBalanceMinor: "2000" })),
    ).toEqual({ status: "READY_FOR_RESERVATION", reasonCodes: ["PRECONDITIONS_MET"] });
  });

  it("accepts string, number and bigint minor-unit money equivalently", () => {
    expect(evaluateAppProcurementReadiness(input({ appCostMinor: 2000, supplierBalanceMinor: 2000 }))).toEqual({
      status: "READY_FOR_RESERVATION",
      reasonCodes: ["PRECONDITIONS_MET"],
    });
    expect(
      evaluateAppProcurementReadiness(input({ appCostMinor: 2000n, supplierBalanceMinor: 2000n })),
    ).toEqual({ status: "READY_FOR_RESERVATION", reasonCodes: ["PRECONDITIONS_MET"] });
  });

  it("blocks when the catalog item is missing", () => {
    for (const catalogItemExists of [false, null, undefined] as const) {
      expect(evaluateAppProcurementReadiness(input({ catalogItemExists }))).toEqual({
        status: "BLOCKED",
        reasonCodes: ["CATALOG_ITEM_MISSING"],
      });
    }
  });

  it("blocks unless the trial is explicitly validated", () => {
    for (const trialValidated of [false, "unknown", null, undefined] as const) {
      expect(evaluateAppProcurementReadiness(input({ trialValidated }))).toEqual({
        status: "BLOCKED",
        reasonCodes: ["TRIAL_NOT_VALIDATED"],
      });
    }
  });

  it("blocks unless the Order is exactly SETTLED", () => {
    for (const orderStatus of ["DRAFT", "AWAITING_PAYMENT", "CANCELLED", "EXPIRED", "settled", null, undefined] as const) {
      expect(evaluateAppProcurementReadiness(input({ orderStatus }))).toEqual({
        status: "BLOCKED",
        reasonCodes: ["ORDER_NOT_SETTLED"],
      });
    }
  });

  it("blocks when the app cost is unknown", () => {
    for (const appCostMinor of [null, undefined] as const) {
      expect(evaluateAppProcurementReadiness(input({ appCostMinor }))).toEqual({
        status: "BLOCKED",
        reasonCodes: ["APP_COST_UNKNOWN"],
      });
    }
  });

  it("rejects zero, negative, fractional and malformed app costs", () => {
    for (const appCostMinor of ["0", 0, 0n, "-5", -5, "19.90", 19.5, "abc", "", "1e3"] as const) {
      expect(evaluateAppProcurementReadiness(input({ appCostMinor }))).toEqual({
        status: "BLOCKED",
        reasonCodes: ["INVALID_APP_COST"],
      });
    }
  });

  it("rejects app costs above PostgreSQL BIGINT max", () => {
    expect(
      evaluateAppProcurementReadiness(input({ appCostMinor: "9223372036854775808" })),
    ).toEqual({ status: "BLOCKED", reasonCodes: ["INVALID_APP_COST"] });
  });

  it("blocks when the supplier balance is unknown", () => {
    for (const supplierBalanceMinor of [null, undefined] as const) {
      expect(evaluateAppProcurementReadiness(input({ supplierBalanceMinor }))).toEqual({
        status: "BLOCKED",
        reasonCodes: ["SUPPLIER_BALANCE_UNKNOWN"],
      });
    }
  });

  it("rejects negative, fractional and malformed supplier balances", () => {
    for (const supplierBalanceMinor of ["-5", -5, "19.90", 19.5, "abc", ""] as const) {
      expect(evaluateAppProcurementReadiness(input({ supplierBalanceMinor }))).toEqual({
        status: "BLOCKED",
        reasonCodes: ["INVALID_SUPPLIER_BALANCE"],
      });
    }
  });

  it("blocks when either currency is missing or malformed", () => {
    expect(evaluateAppProcurementReadiness(input({ appCurrency: null }))).toEqual({
      status: "BLOCKED",
      reasonCodes: ["INVALID_CURRENCY"],
    });
    expect(evaluateAppProcurementReadiness(input({ supplierCurrency: undefined }))).toEqual({
      status: "BLOCKED",
      reasonCodes: ["INVALID_CURRENCY"],
    });
    expect(evaluateAppProcurementReadiness(input({ appCurrency: "brl" }))).toEqual({
      status: "BLOCKED",
      reasonCodes: ["INVALID_CURRENCY"],
    });
    expect(evaluateAppProcurementReadiness(input({ appCurrency: "BRL " }))).toEqual({
      status: "BLOCKED",
      reasonCodes: ["INVALID_CURRENCY"],
    });
  });

  it("blocks on currency mismatch even when the balance covers the cost", () => {
    expect(
      evaluateAppProcurementReadiness(input({ appCurrency: "BRL", supplierCurrency: "USD" })),
    ).toEqual({ status: "BLOCKED", reasonCodes: ["CURRENCY_MISMATCH"] });
  });

  it("pauses on insufficient balance with the stable F15 signal (one cent short)", () => {
    expect(
      evaluateAppProcurementReadiness(input({ appCostMinor: "2000", supplierBalanceMinor: "1999" })),
    ).toEqual({ status: "BLOCKED", reasonCodes: ["INSUFFICIENT_SUPPLIER_BALANCE"] });
  });

  it("pauses on zero balance against a positive cost", () => {
    expect(evaluateAppProcurementReadiness(input({ supplierBalanceMinor: "0" }))).toEqual({
      status: "BLOCKED",
      reasonCodes: ["INSUFFICIENT_SUPPLIER_BALANCE"],
    });
  });

  it("is deterministic: the first failing gate in procurement order decides", () => {
    expect(
      evaluateAppProcurementReadiness(
        input({ catalogItemExists: false, trialValidated: false, orderStatus: "DRAFT" }),
      ),
    ).toEqual({ status: "BLOCKED", reasonCodes: ["CATALOG_ITEM_MISSING"] });
    expect(
      evaluateAppProcurementReadiness(input({ trialValidated: false, orderStatus: "DRAFT" })),
    ).toEqual({ status: "BLOCKED", reasonCodes: ["TRIAL_NOT_VALIDATED"] });
  });
});
