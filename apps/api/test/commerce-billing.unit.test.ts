import { afterEach, describe, expect, it } from "vitest";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import type { Database } from "@iptv/database";
import { buildSucceededRefundsQuery } from "../src/billing/settlement.js";
import {
  assertLedgerBalanced,
  evaluateCoverage,
  isChargeTransition,
  isOrderTransition,
  lineGross,
  paymentStatusAfterRefund,
  remainingRefundable,
  sumMinors,
  toMinor,
  webhookAmountMatchesCharge,
} from "../src/commerce/money-math.js";
import { normalizeAsaasPayload } from "../src/billing/asaas-normalizer.js";
import { EchoAsaasAdapter, resolveAsaasPort } from "../src/billing/asaas-port.js";
import {
  chargebackReversalEntries,
  confirmationEntries,
  refundReversalEntries,
  settlementEntries,
} from "../src/billing/ledger.js";

afterEach(() => {
  delete process.env["ASAAS_ECHO_CREATE"];
  delete process.env["ASAAS_ECHO_RECONCILE"];
  delete process.env["ASAAS_ECHO_REFUND"];
  delete process.env["ASAAS_ECHO_REFUND_RECONCILE"];
});

describe("Wave 5 money math (exact minor units, no floats)", () => {
  it("converts exact boundary values and rejects non-integers", () => {
    expect(toMinor("1990")).toBe(1990n);
    expect(toMinor(1990)).toBe(1990n);
    expect(toMinor(1990n)).toBe(1990n);
    expect(() => toMinor("19.90")).toThrow();
    expect(() => toMinor(19.9)).toThrow();
    expect(() => toMinor("abc")).toThrow();
  });

  it("multiplies line gross exactly (unit × integer qty)", () => {
    expect(lineGross(1990n, 3)).toBe(5970n);
    expect(lineGross(333n, 3)).toBe(999n);
    expect(() => lineGross(100n, 0)).toThrow();
    expect(() => lineGross(100n, 1.5)).toThrow();
  });

  it("sums minor units without float drift", () => {
    // 0.1 + 0.2 in float is 0.30000000000000004; in minor units it is exact.
    expect(sumMinors([10n, 20n])).toBe(30n);
    expect(sumMinors([])).toBe(0n);
  });

  it("settles exactly at the threshold and caps settled_amount at net", () => {
    const atThreshold = evaluateCoverage({
      orderNetMinor: 5970n,
      payments: [{ status: "CONFIRMED", amountMinor: 5970n }],
      succeededRefundsMinor: 0n,
    });
    expect(atThreshold.settled).toBe(true);
    expect(atThreshold.settledAmountMinor).toBe(5970n);

    const oneShort = evaluateCoverage({
      orderNetMinor: 5970n,
      payments: [{ status: "CONFIRMED", amountMinor: 5969n }],
      succeededRefundsMinor: 0n,
    });
    expect(oneShort.settled).toBe(false);
    expect(oneShort.settledAmountMinor).toBe(0n);

    const overpaid = evaluateCoverage({
      orderNetMinor: 5970n,
      payments: [
        { status: "CONFIRMED", amountMinor: 5970n },
        { status: "CONFIRMED", amountMinor: 1000n },
      ],
      succeededRefundsMinor: 0n,
    });
    expect(overpaid.settled).toBe(true);
    expect(overpaid.settledAmountMinor).toBe(5970n);
  });

  it("ignores non-covering payments and subtracts succeeded refunds", () => {
    const result = evaluateCoverage({
      orderNetMinor: 5000n,
      payments: [
        { status: "CONFIRMED", amountMinor: 5000n },
        { status: "CHARGEBACK", amountMinor: 5000n },
      ],
      succeededRefundsMinor: 1000n,
    });
    expect(result.coveredMinor).toBe(4000n);
    expect(result.settled).toBe(false);
  });

  it("computes remaining refundable and clamps at zero", () => {
    expect(remainingRefundable({ paidMinor: 5000n, consumedMinor: 2000n })).toBe(3000n);
    expect(remainingRefundable({ paidMinor: 5000n, consumedMinor: 5000n })).toBe(0n);
    expect(remainingRefundable({ paidMinor: 5000n, consumedMinor: 6000n })).toBe(0n);
  });

  it("derives the payment status after an applied refund", () => {
    expect(paymentStatusAfterRefund(1n)).toBe("PARTIALLY_REFUNDED");
    expect(paymentStatusAfterRefund(0n)).toBe("REFUNDED");
  });
});

describe("Wave 5 transition legality", () => {
  it("allows the canonical order path and forbids skips", () => {
    expect(isOrderTransition("DRAFT", "AWAITING_PAYMENT")).toBe(true);
    expect(isOrderTransition("AWAITING_PAYMENT", "SETTLED")).toBe(true);
    expect(isOrderTransition("DRAFT", "SETTLED")).toBe(false);
    expect(isOrderTransition("SETTLED", "CANCELLED")).toBe(false);
    expect(isOrderTransition("AWAITING_PAYMENT", "EXPIRED")).toBe(true);
  });

  it("allows the canonical charge path and forbids confirmation skips", () => {
    expect(isChargeTransition("PENDING", "PROCESSING")).toBe(true);
    expect(isChargeTransition("PROCESSING", "PAID")).toBe(true);
    expect(isChargeTransition("PENDING", "PAID")).toBe(false);
    expect(isChargeTransition("PAID", "FAILED")).toBe(false);
  });
});

describe("Wave 5 ledger balance", () => {
  it("accepts balanced confirmation/settlement/refund/chargeback postings", () => {
    expect(() => assertLedgerBalanced(confirmationEntries(5970n, "BRL"))).not.toThrow();
    expect(() => assertLedgerBalanced(settlementEntries(5970n, "BRL"))).not.toThrow();
    expect(() => assertLedgerBalanced(refundReversalEntries(2000n, "BRL"))).not.toThrow();
    expect(() => assertLedgerBalanced(chargebackReversalEntries(5970n, "BRL"))).not.toThrow();
  });

  it("rejects unbalanced, single-entry, and non-positive postings", () => {
    expect(() =>
      assertLedgerBalanced([
        { accountCode: "A", currency: "BRL", direction: "DEBIT", amountMinor: 100n },
        { accountCode: "B", currency: "BRL", direction: "CREDIT", amountMinor: 99n },
      ]),
    ).toThrow(/not balanced/);
    expect(() =>
      assertLedgerBalanced([{ accountCode: "A", currency: "BRL", direction: "DEBIT", amountMinor: 100n }]),
    ).toThrow(/at least two/);
    expect(() =>
      assertLedgerBalanced([
        { accountCode: "A", currency: "BRL", direction: "DEBIT", amountMinor: 0n },
        { accountCode: "B", currency: "BRL", direction: "CREDIT", amountMinor: 0n },
      ]),
    ).toThrow(/positive/);
  });

  it("balances per currency independently", () => {
    expect(() =>
      assertLedgerBalanced([
        { accountCode: "A", currency: "BRL", direction: "DEBIT", amountMinor: 100n },
        { accountCode: "B", currency: "BRL", direction: "CREDIT", amountMinor: 100n },
        { accountCode: "A", currency: "USD", direction: "DEBIT", amountMinor: 50n },
        { accountCode: "B", currency: "USD", direction: "CREDIT", amountMinor: 49n },
      ]),
    ).toThrow(/USD/);
  });
});

describe("Wave 5 webhook amount validation", () => {
  it("confirms only exact amount+currency matches", () => {
    const base = { chargeAmountMinor: 5970n, chargeCurrency: "BRL" };
    expect(webhookAmountMatchesCharge({ ...base, reportedAmountMinor: 5970n, reportedCurrency: "BRL" })).toBe(true);
    expect(webhookAmountMatchesCharge({ ...base, reportedAmountMinor: 5969n, reportedCurrency: "BRL" })).toBe(false);
    expect(webhookAmountMatchesCharge({ ...base, reportedAmountMinor: 5970n, reportedCurrency: "USD" })).toBe(false);
    expect(webhookAmountMatchesCharge({ ...base, reportedAmountMinor: null, reportedCurrency: "BRL" })).toBe(false);
    expect(webhookAmountMatchesCharge({ ...base, reportedAmountMinor: 5970n, reportedCurrency: null })).toBe(false);
  });
});

describe("Wave 5 Asaas normalizer", () => {
  it("parses PAYMENT_RECEIVED with exact minor units (no float)", () => {
    const normalized = normalizeAsaasPayload(
      { event: "PAYMENT_RECEIVED", payment: { id: "pay_123", value: 30.1 } },
      null,
    );
    expect(normalized.kind).toBe("paid");
    if (normalized.kind !== "paid") {
      throw new Error("expected paid");
    }
    expect(normalized.externalChargeId).toBe("pay_123");
    // 30.10 BRL == 3010 minor units exactly (float 30.1 never touches money).
    expect(normalized.reportedAmountMinor).toBe("3010");
    expect(normalized.reportedCurrency).toBe("BRL");
  });

  it("parses chargeback events on the distinct path", () => {
    const normalized = normalizeAsaasPayload(
      { event: "PAYMENT_CHARGEBACK", payment: { id: "pay_9", value: "30.00" } },
      null,
    );
    expect(normalized.kind).toBe("chargeback");
  });

  it("marks unknown shapes without domain mutation", () => {
    expect(normalizeAsaasPayload({ event: "SOMETHING_ELSE", payment: { id: "pay_1" } }, null)).toEqual({
      kind: "unknown",
    });
    expect(normalizeAsaasPayload({ event: "PAYMENT_RECEIVED" }, null)).toEqual({ kind: "unknown" });
    expect(normalizeAsaasPayload(null, null)).toEqual({ kind: "unknown" });
  });
});

describe("Wave 5 Echo Asaas adapter", () => {
  it("creates PIX charges deterministically", async () => {
    const port = new EchoAsaasAdapter();
    const created = await port.createPixCharge({
      chargeId: "charge-1",
      valueMinor: 5970n,
      currency: "BRL",
      payer: { personId: "person-1" },
    });
    expect(created.effect).toBe("KNOWN_APPLIED");
    expect(created.providerChargeId).toBe("echo-charge-1");
    expect(created.qrCode).toBe("echo-qr-charge-1");
  });

  it("reports unknown create effects for the reconcile path", async () => {
    process.env["ASAAS_ECHO_CREATE"] = "unknown";
    const port = new EchoAsaasAdapter();
    const created = await port.createPixCharge({
      chargeId: "charge-2",
      valueMinor: 100n,
      currency: "BRL",
      payer: { personId: "person-1" },
    });
    expect(created.effect).toBe("UNKNOWN");
  });

  it("answers refunds from env (applied/not_applied/unknown)", async () => {
    const port = new EchoAsaasAdapter();
    const applied = await port.executeRefund({ paymentId: "p", refundId: "r", valueMinor: 10n, currency: "BRL" });
    expect(applied.effect).toBe("KNOWN_APPLIED");

    process.env["ASAAS_ECHO_REFUND"] = "not_applied";
    const rejected = await port.executeRefund({ paymentId: "p", refundId: "r", valueMinor: 10n, currency: "BRL" });
    expect(rejected.effect).toBe("KNOWN_NOT_APPLIED");

    process.env["ASAAS_ECHO_REFUND"] = "unknown";
    const unknown = await port.executeRefund({ paymentId: "p", refundId: "r", valueMinor: 10n, currency: "BRL" });
    expect(unknown.effect).toBe("UNKNOWN");
  });

  it("resolves through the default echo factory", () => {
    expect(resolveAsaasPort("echo").name).toBe("echo");
  });
});

describe("Wave 5 settlement query shape (FIX-WAVE5-LIVE #2)", () => {
  const TENANT = "11111111-1111-4111-8111-111111111111";
  const ORDER = "22222222-2222-4222-8222-222222222222";

  function offlineDb(): Kysely<Database> {
    return new Kysely<Database>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
  }

  it("joins refunds to payments on column references, never string-literal uuid params", async () => {
    const compiled = buildSucceededRefundsQuery(offlineDb(), TENANT, ORDER).compile();
    // Regression: `.on(lhs, "=", "billing.refunds.tenant_id")` used to bind
    // the literal column-name string as a uuid parameter → Postgres
    // `invalid input syntax for type uuid: "billing.refunds.tenant_id"`.
    expect(compiled.parameters).not.toContain("billing.refunds.tenant_id");
    expect(compiled.parameters).not.toContain("billing.payments.tenant_id");
    expect(compiled.sql).toContain(
      '"billing"."payments"."tenant_id" = "billing"."refunds"."tenant_id"',
    );
    expect(compiled.sql).toContain('"billing"."payments"."id" = "billing"."refunds"."payment_id"');
    await offlineDb().destroy().catch(() => undefined);
  });
});
