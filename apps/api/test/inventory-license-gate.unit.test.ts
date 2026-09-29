import { describe, expect, it } from "vitest";
import {
  APP_PROCUREMENT_REASON_CODES,
  evaluateAppProcurementReadiness,
} from "../src/inventory/app-procurement-policy.js";
import { GATE_MESSAGE } from "../src/inventory/license.commands.js";

describe("Wave 7 license purchase gate mapping (pure)", () => {
  it("explains every gate reason with a stable message", () => {
    expect(Object.keys(GATE_MESSAGE).sort()).toEqual([...APP_PROCUREMENT_REASON_CODES].sort());
    for (const code of APP_PROCUREMENT_REASON_CODES) {
      expect(GATE_MESSAGE[code].length).toBeGreaterThan(0);
    }
  });

  it("blocks without a validated trial", () => {
    expect(
      evaluateAppProcurementReadiness({
        catalogItemExists: true,
        trialValidated: false,
        orderStatus: "SETTLED",
        appCostMinor: "2000",
        appCurrency: "BRL",
        supplierBalanceMinor: "5000",
        supplierCurrency: "BRL",
      }),
    ).toEqual({ status: "BLOCKED", reasonCodes: ["TRIAL_NOT_VALIDATED"] });
  });

  it("blocks without a settled order", () => {
    expect(
      evaluateAppProcurementReadiness({
        catalogItemExists: true,
        trialValidated: true,
        orderStatus: "AWAITING_PAYMENT",
        appCostMinor: "2000",
        appCurrency: "BRL",
        supplierBalanceMinor: "5000",
        supplierCurrency: "BRL",
      }),
    ).toEqual({ status: "BLOCKED", reasonCodes: ["ORDER_NOT_SETTLED"] });
  });

  it("blocks when the hold cannot cover the cost", () => {
    const gated = evaluateAppProcurementReadiness({
      catalogItemExists: true,
      trialValidated: true,
      orderStatus: "SETTLED",
      appCostMinor: "9000",
      appCurrency: "BRL",
      supplierBalanceMinor: "5000",
      supplierCurrency: "BRL",
    });
    expect(gated).toEqual({ status: "BLOCKED", reasonCodes: ["INSUFFICIENT_SUPPLIER_BALANCE"] });
    expect(`BLOCKED ${gated.reasonCodes[0]}: ${GATE_MESSAGE[gated.reasonCodes[0]]}`).toMatch(
      /BLOCKED INSUFFICIENT_SUPPLIER_BALANCE/,
    );
  });
});
