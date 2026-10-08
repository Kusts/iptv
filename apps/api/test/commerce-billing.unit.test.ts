import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { EchoAsaasAdapter, RealAsaasAdapter, isSyntheticProviderReference, provenExternalChargeId, resolveAsaasPort, type AsaasPort, type RefundRequest } from "../src/billing/asaas-port.js";
import { registerBillingCommands } from "../src/billing/billing.commands.js";
import type { CommandBus } from "../src/commands/command-bus.js";
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
    // Echo owns ONLY `echo-` charge bindings (MVP-ASAAS-05 chokepoint);
    // foreign refs refuse as UNKNOWN (covered in 05c).
    const applied = await port.executeRefund({ paymentId: "p", refundId: "r", providerChargeId: "echo-pay_ext", valueMinor: 10n, currency: "BRL" });
    expect(applied.effect).toBe("KNOWN_APPLIED");

    process.env["ASAAS_ECHO_REFUND"] = "not_applied";
    const rejected = await port.executeRefund({ paymentId: "p", refundId: "r", providerChargeId: "echo-pay_ext", valueMinor: 10n, currency: "BRL" });
    expect(rejected.effect).toBe("KNOWN_NOT_APPLIED");

    process.env["ASAAS_ECHO_REFUND"] = "unknown";
    const unknown = await port.executeRefund({ paymentId: "p", refundId: "r", providerChargeId: "echo-pay_ext", valueMinor: 10n, currency: "BRL" });
    expect(unknown.effect).toBe("UNKNOWN");
  });

  it("resolves through the default echo factory", () => {
    expect(resolveAsaasPort("echo").name).toBe("echo");
  });
});

describe("Wave 5 Real Asaas adapter (mocked fetch, no network)", () => {
  const API_KEY = "test-key-not-a-secret";
  const BASE_URL = "https://sandbox.test";

  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    process.env["ASAAS_API_KEY"] = API_KEY;
    process.env["ASAAS_BASE_URL"] = BASE_URL;
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env["ASAAS_API_KEY"];
    delete process.env["ASAAS_BASE_URL"];
    globalThis.fetch = originalFetch as typeof fetch;
    vi.restoreAllMocks();
  });

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body instanceof Error) {
          throw body;
        }
        return body;
      },
    } as Response;
  }

  it("reads a received charge as PAID with exact minor units", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "pay_123", status: "RECEIVED", value: "30.10" }));
    const port = new RealAsaasAdapter();
    const observed = await port.getCharge({ providerChargeId: "pay_123" });
    expect(observed.status).toBe("PAID");
    expect(observed.valueMinor).toBe(3010n);
    expect(observed.currency).toBe("BRL");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/payments/pay_123`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["access_token"]).toBe(API_KEY);
    expect(observed.detail).not.toContain(API_KEY);
  });

  it("maps confirmed/refunded to PAID and overdue to PENDING", async () => {
    const port = new RealAsaasAdapter();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "pay_c", status: "CONFIRMED", value: "19.90" }));
    const confirmed = await port.getCharge({ providerChargeId: "pay_c" });
    expect(confirmed.status).toBe("PAID");
    expect(confirmed.valueMinor).toBe(1990n);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "pay_o", status: "OVERDUE", value: "19.90" }));
    const overdue = await port.getCharge({ providerChargeId: "pay_o" });
    expect(overdue.status).toBe("PENDING");
    expect(overdue.valueMinor).toBe(1990n);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "pay_r", status: "REFUNDED", value: "19.90" }));
    const refunded = await port.getCharge({ providerChargeId: "pay_r" });
    expect(refunded.status).toBe("PAID");
  });

  it("maps a missing charge to FAILED and server errors to UNKNOWN", async () => {
    const port = new RealAsaasAdapter();
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { errors: [{ code: "not_found" }] }));
    const missing = await port.getCharge({ providerChargeId: "pay_missing" });
    expect(missing.status).toBe("FAILED");
    expect(missing.valueMinor).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));
    const broken = await port.getCharge({ providerChargeId: "pay_123" });
    expect(broken.status).toBe("UNKNOWN");
    expect(broken.valueMinor).toBeNull();
  });

  it("treats malformed charge bodies and transport errors as UNKNOWN", async () => {
    const port = new RealAsaasAdapter();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, null));
    const empty = await port.getCharge({ providerChargeId: "pay_123" });
    expect(empty.status).toBe("UNKNOWN");
    expect(empty.valueMinor).toBeNull();
    expect(empty.currency).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "pay_123", status: "RECEIVED", value: "not-a-number" }));
    const badValue = await port.getCharge({ providerChargeId: "pay_123" });
    expect(badValue.status).toBe("PAID");
    expect(badValue.valueMinor).toBeNull();

    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeout);
    const timedOut = await port.getCharge({ providerChargeId: "pay_123" });
    expect(timedOut.status).toBe("UNKNOWN");
    expect(timedOut.detail).toContain("timed out");
  });

  it("executes a refund against the external charge id (never the internal payment uuid)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "refund_1", status: "REFUNDED" }));
    const port = new RealAsaasAdapter();
    const result = await port.executeRefund({
      paymentId: "11111111-1111-4111-8111-111111111111",
      refundId: "refund-local-1",
      providerChargeId: "pay_123",
      valueMinor: 1990n,
      currency: "BRL",
    });
    expect(result.effect).toBe("KNOWN_APPLIED");
    expect(result.providerRefundId).toBe("refund_1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/payments/pay_123/refund`);
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("19.90");
    expect(result.detail).not.toContain(API_KEY);
  });

  it("maps refund rejection to KNOWN_NOT_APPLIED and server errors to UNKNOWN", async () => {
    const port = new RealAsaasAdapter();
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { errors: [{ code: "invalid" }] }));
    const rejected = await port.executeRefund({
      paymentId: "11111111-1111-4111-8111-111111111111",
      refundId: "refund-local-2",
      providerChargeId: "pay_123",
      valueMinor: 100n,
      currency: "BRL",
    });
    expect(rejected.effect).toBe("KNOWN_NOT_APPLIED");
    expect(rejected.providerRefundId).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse(502, { error: "bad gateway" }));
    const broken = await port.executeRefund({
      paymentId: "11111111-1111-4111-8111-111111111111",
      refundId: "refund-local-3",
      providerChargeId: "pay_123",
      valueMinor: 100n,
      currency: "BRL",
    });
    expect(broken.effect).toBe("UNKNOWN");
    expect(broken.providerRefundId).toBeNull();

    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    const transport = await port.executeRefund({
      paymentId: "11111111-1111-4111-8111-111111111111",
      refundId: "refund-local-4",
      providerChargeId: "pay_123",
      valueMinor: 100n,
      currency: "BRL",
    });
    expect(transport.effect).toBe("UNKNOWN");
    expect(transport.providerRefundId).toBeNull();
  });

  it("reconciles refunds: confirmed, pending and not-applied", async () => {
    const port = new RealAsaasAdapter();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "refund_1", status: "REFUNDED" }));
    const confirmed = await port.getRefund({ providerRefundId: "refund_1" });
    expect(confirmed.effect).toBe("KNOWN_APPLIED");
    expect(confirmed.providerRefundId).toBe("refund_1");

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "refund_2", status: "REFUND_REQUESTED" }));
    const pending = await port.getRefund({ providerRefundId: "refund_2" });
    expect(pending.effect).toBe("UNKNOWN");
    expect(pending.providerRefundId).toBe("refund_2");

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "pay_123", status: "RECEIVED", value: "19.90" }));
    const untouched = await port.getRefund({ providerRefundId: "pay_123" });
    expect(untouched.effect).toBe("KNOWN_NOT_APPLIED");

    fetchMock.mockResolvedValueOnce(jsonResponse(404, { errors: [{ code: "not_found" }] }));
    const missing = await port.getRefund({ providerRefundId: "refund_missing" });
    expect(missing.effect).toBe("KNOWN_NOT_APPLIED");
    expect(missing.providerRefundId).toBeNull();
  });

  it("throws a misconfiguration error without credentials and keeps echo as default", async () => {
    delete process.env["ASAAS_API_KEY"];
    delete process.env["ASAAS_BASE_URL"];
    const port = new RealAsaasAdapter();
    await expect(port.getCharge({ providerChargeId: "pay_123" })).rejects.toThrow(/not configured/);
    await expect(
      port.executeRefund({ paymentId: "pay_123", refundId: "r", providerChargeId: "pay_123", valueMinor: 1n, currency: "BRL" }),
    ).rejects.toThrow(/not configured/);
    await expect(port.getRefund({ providerRefundId: "refund_1" })).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.env["ASAAS_ADAPTER"] ?? "echo").not.toBe("real");
  });
});

describe("P3 Real Asaas adapter customer binding (mocked fetch, no network)", () => {
  const API_KEY = "test-key-not-a-secret";
  const BASE_URL = "https://sandbox.test";

  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    process.env["ASAAS_API_KEY"] = API_KEY;
    process.env["ASAAS_BASE_URL"] = BASE_URL;
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env["ASAAS_API_KEY"];
    delete process.env["ASAAS_BASE_URL"];
    globalThis.fetch = originalFetch as typeof fetch;
    vi.restoreAllMocks();
  });

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }

  function lastPostBody(): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it("includes the bound customer in the /payments payload and applies on 2xx-with-id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "pay_live_1", pixQrCode: "qr" }));
    const port = new RealAsaasAdapter();
    const created = await port.createPixCharge({
      chargeId: "charge-p3-1",
      valueMinor: 1990n,
      currency: "BRL",
      payer: { personId: "person-1" },
      providerCustomerId: "cus_sandbox_disposable_1",
      dueDate: "2026-10-09",
    });
    expect(created.effect).toBe("KNOWN_APPLIED");
    expect(created.providerChargeId).toBe("pay_live_1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/payments`);
    expect(init.method).toBe("POST");
    expect(lastPostBody()).toMatchObject({
      billingType: "PIX",
      value: "19.90",
      customer: "cus_sandbox_disposable_1",
      dueDate: "2026-10-09",
      externalReference: "charge-p3-1",
    });
    expect(created.detail).not.toContain(API_KEY);
  });

  it("omits customer when no binding exists (provider rejects, never invented)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { errors: [{ code: "invalid_customer" }] }));
    const port = new RealAsaasAdapter();
    const created = await port.createPixCharge({
      chargeId: "charge-p3-2",
      valueMinor: 100n,
      currency: "BRL",
      payer: { personId: "person-1" },
    });
    expect(created.effect).toBe("KNOWN_NOT_APPLIED");
    expect(created.providerChargeId).toBe("rejected-charge-p3-2");
    const body = lastPostBody();
    expect(body).not.toHaveProperty("customer");
    expect(body["dueDate"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("maps 2xx-with-customer but without a provider id to UNKNOWN", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { customer: "cus_x", value: "1.00" }));
    const port = new RealAsaasAdapter();
    const created = await port.createPixCharge({
      chargeId: "charge-p3-3",
      valueMinor: 100n,
      currency: "BRL",
      payer: { personId: "person-1" },
      providerCustomerId: "cus_x",
    });
    expect(created.effect).toBe("UNKNOWN");
    expect(created.providerChargeId).toBe("unknown-charge-p3-3");
    expect(lastPostBody()["customer"]).toBe("cus_x");
  });

  it("maps transport errors with a customer binding to UNKNOWN", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeout);
    const port = new RealAsaasAdapter();
    const created = await port.createPixCharge({
      chargeId: "charge-p3-4",
      valueMinor: 100n,
      currency: "BRL",
      payer: { personId: "person-1" },
      providerCustomerId: "cus_x",
    });
    expect(created.effect).toBe("UNKNOWN");
    expect(created.providerChargeId).toBe("unknown-charge-p3-4");
  });
});

describe("MVP-ASAAS-02 review findings: adapter guards (mocked fetch, no network)", () => {
  const API_KEY = "test-key-not-a-secret";
  const BASE_URL = "https://sandbox.test";
  const INTERNAL_UUID = "11111111-1111-4111-8111-111111111111";

  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    process.env["ASAAS_API_KEY"] = API_KEY;
    process.env["ASAAS_BASE_URL"] = BASE_URL;
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env["ASAAS_API_KEY"];
    delete process.env["ASAAS_BASE_URL"];
    globalThis.fetch = originalFetch as typeof fetch;
    vi.restoreAllMocks();
  });

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body instanceof Error) {
          throw body;
        }
        return body;
      },
    } as Response;
  }

  function refundInput(providerChargeId: string | null): RefundRequest {
    return {
      paymentId: INTERNAL_UUID,
      refundId: "refund-local-1",
      providerChargeId,
      valueMinor: 100n,
      currency: "BRL",
    };
  }

  it("finding 6: rejects non-BRL currency at the adapter boundary without network", async () => {
    const port = new RealAsaasAdapter();
    await expect(
      port.createPixCharge({ chargeId: "c", valueMinor: 100n, currency: "USD", payer: { personId: "p" } }),
    ).rejects.toThrow(/only BRL/);
    await expect(port.executeRefund({ ...refundInput("pay_1"), currency: "JPY" })).rejects.toThrow(/only BRL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finding 1: local UUID / synthetic charge ids never reach the provider", async () => {
    const port = new RealAsaasAdapter();
    for (const bad of [INTERNAL_UUID, "unknown-charge-1", "rejected-charge-1", "asaas-charge-1", "echo-charge-1"]) {
      const result = await port.executeRefund(refundInput(bad));
      expect(result.effect).toBe("UNKNOWN");
      expect(result.providerRefundId).toBeNull();
    }
    const missing = await port.executeRefund(refundInput(null));
    expect(missing.effect).toBe("UNKNOWN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finding 3: malformed 2xx refund bodies stay UNKNOWN (never finalize nor post reversals)", async () => {
    const port = new RealAsaasAdapter();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, null));
    const empty = await port.executeRefund(refundInput("pay_1"));
    expect(empty.effect).toBe("UNKNOWN");
    expect(empty.providerRefundId).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const noShape = await port.executeRefund(refundInput("pay_1"));
    expect(noShape.effect).toBe("UNKNOWN");
    expect(noShape.providerRefundId).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "refund_9", status: "PENDING" }));
    const pending = await port.executeRefund(refundInput("pay_1"));
    expect(pending.effect).toBe("UNKNOWN");
    expect(pending.providerRefundId).toBe("refund_9");

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: "REFUNDED" }));
    const appliedWithoutId = await port.executeRefund(refundInput("pay_1"));
    expect(appliedWithoutId.effect).toBe("UNKNOWN");
    expect(appliedWithoutId.providerRefundId).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "refund_10", status: "REFUNDED" }));
    const applied = await port.executeRefund(refundInput("pay_1"));
    expect(applied.effect).toBe("KNOWN_APPLIED");
    expect(applied.providerRefundId).toBe("refund_10");
  });

  it("finding 3b: create 2xx without a provider id stays UNKNOWN", async () => {
    const port = new RealAsaasAdapter();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { pixQrCode: "qr" }));
    const created = await port.createPixCharge({
      chargeId: "charge-9",
      valueMinor: 100n,
      currency: "BRL",
      payer: { personId: "person-1" },
    });
    expect(created.effect).toBe("UNKNOWN");
    expect(created.providerChargeId).toBe("unknown-charge-9");
  });

  it("finding 2: timeout refund followed by local-id readback holds the reservation (UNKNOWN, no release)", async () => {
    const port = new RealAsaasAdapter();
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeout);
    const attempted = await port.executeRefund(refundInput("pay_1"));
    expect(attempted.effect).toBe("UNKNOWN");
    expect(attempted.providerRefundId).toBeNull();

    // The reconcile path queries with the internal refund UUID when execute
    // left no external id: that readback must stay UNKNOWN (a 404 there can
    // never prove non-execution) and must not touch the network.
    const reconciled = await port.getRefund({ providerRefundId: "22222222-2222-4222-8222-222222222222" });
    expect(reconciled.effect).toBe("UNKNOWN");
    const synthetic = await port.getRefund({ providerRefundId: "asaas-refund-x" });
    expect(synthetic.effect).toBe("UNKNOWN");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("finding 5: synthetic charge readback stays UNKNOWN even on provider 404", async () => {
    const port = new RealAsaasAdapter();
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { errors: [{ code: "not_found" }] }));
    const observed = await port.getCharge({ providerChargeId: "unknown-charge-1" });
    expect(observed.status).toBe("UNKNOWN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies synthetic vs proven provider references", () => {
    expect(isSyntheticProviderReference(null)).toBe(true);
    expect(isSyntheticProviderReference(undefined)).toBe(true);
    expect(isSyntheticProviderReference("")).toBe(true);
    expect(isSyntheticProviderReference(INTERNAL_UUID)).toBe(true);
    expect(isSyntheticProviderReference("unknown-c1")).toBe(true);
    expect(isSyntheticProviderReference("rejected-c1")).toBe(true);
    expect(isSyntheticProviderReference("asaas-c1")).toBe(true);
    expect(isSyntheticProviderReference("pay_123")).toBe(false);
    expect(provenExternalChargeId("real", "pay_123")).toBe("pay_123");
    expect(provenExternalChargeId("real", INTERNAL_UUID)).toBeNull();
    expect(provenExternalChargeId("real", "unknown-c1")).toBeNull();
    expect(provenExternalChargeId("real", null)).toBeNull();
    expect(provenExternalChargeId("echo", "echo-c1")).toBe("echo-c1");
  });
});

describe("MVP-ASAAS-02 command → adapter wiring (stub transaction, no DB)", () => {
  const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PAYMENT_ID = "11111111-1111-4111-8111-111111111111";
  const CHARGE_ID = "33333333-3333-4333-8333-333333333333";
  const REFUND_REQUEST_ID = "44444444-4444-4444-8444-444444444444";
  const REFUND_ID = "55555555-5555-4555-8555-555555555555";

  interface QueryCall {
    table: string;
    op: "select" | "insert" | "update";
    values?: unknown;
    set?: unknown;
  }

  interface StubHooks {
    onTakeFirst?: (call: QueryCall, n: number) => unknown;
    onExecute?: (call: QueryCall, n: number) => unknown;
  }

  class StubTrx {
    readonly inserts: QueryCall[] = [];
    readonly updates: QueryCall[] = [];
    private readonly counts = new Map<string, number>();
    constructor(private readonly hooks: StubHooks) {}
    private next(key: string): number {
      const n = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, n);
      return n;
    }
    selectFrom(table: string): StubQueryBuilder {
      return new StubQueryBuilder(this, { table, op: "select" });
    }
    insertInto(table: string): StubQueryBuilder {
      const call: QueryCall = { table, op: "insert" };
      this.inserts.push(call);
      return new StubQueryBuilder(this, call);
    }
    updateTable(table: string): StubQueryBuilder {
      const call: QueryCall = { table, op: "update" };
      this.updates.push(call);
      return new StubQueryBuilder(this, call);
    }
    takeFirst(call: QueryCall): Promise<unknown> {
      return Promise.resolve(this.hooks.onTakeFirst?.(call, this.next(`first:${call.table}`)));
    }
    exec(call: QueryCall): Promise<unknown> {
      return Promise.resolve(this.hooks.onExecute?.(call, this.next(`exec:${call.table}`)));
    }
    executeQuery(): Promise<{ rows: unknown[] }> {
      return Promise.resolve({ rows: [] });
    }
    // Kysely `sql` raw-builder path (`advisoryLockPayment`): RawBuilder
    // calls `getExecutor()` then `executeQuery`/`transformQuery` on it.
    getExecutor(): unknown {
      return {
        executeQuery: (): Promise<{ rows: unknown[] }> => Promise.resolve({ rows: [] }),
        transformQuery: (node: unknown): unknown => node,
        compileQuery: (): unknown => ({ sql: "select 1", parameters: [] }),
      };
    }
  }

  class StubQueryBuilder {
    constructor(
      private readonly trx: StubTrx,
      private readonly call: QueryCall,
    ) {}
    select(...args: unknown[]): this {
      void args;
      return this;
    }
    where(...args: unknown[]): this {
      void args;
      return this;
    }
    forUpdate(): this {
      return this;
    }
    orderBy(...args: unknown[]): this {
      void args;
      return this;
    }
    limit(...args: unknown[]): this {
      void args;
      return this;
    }
    values(v: unknown): this {
      this.call.values = v;
      return this;
    }
    set(v: unknown): this {
      this.call.set = v;
      return this;
    }
    onConflict(fn: (oc: { columns: (cols: string[]) => { doNothing: () => void } }) => unknown): this {
      fn({ columns: () => ({ doNothing: () => undefined }) });
      return this;
    }
    returning(...args: unknown[]): this {
      void args;
      return this;
    }
    executeTakeFirst(): Promise<unknown> {
      return this.trx.takeFirst(this.call);
    }
    executeTakeFirstOrThrow(): Promise<unknown> {
      return this.trx.takeFirst(this.call).then((row) => {
        if (row === undefined) {
          throw new Error(`stub: no row for ${this.call.table}`);
        }
        return row;
      });
    }
    execute(): Promise<unknown> {
      return this.trx.exec(this.call);
    }
  }

  function stubCtx(trx: StubTrx): unknown {
    return {
      actor: {
        userId: "user-1",
        isPlatformAdmin: false,
        tenantId: TENANT,
        roleKeys: ["tenant_owner"],
        permissions: ["billing.refund.execute", "billing.charge.write"],
        actorType: "human",
      },
      tenantId: TENANT,
      commandId: "66666666-6666-4666-8666-666666666666",
      correlationId: "77777777-7777-4777-8777-777777777777",
      causationId: null,
      tx: {
        innerDb: () => trx,
        getReviewRequest: () => Promise.resolve({ status: "RESOLVED" }),
        nextAggregateVersion: () => Promise.resolve(1),
        emitDomainEvent: () => Promise.resolve({ domainEventId: "88888888-8888-4888-8888-888888888888" }),
        enqueueOutbox: () => Promise.resolve(undefined),
      },
    };
  }

  function handlersFor(port: AsaasPort): Map<string, (ctx: unknown, input: unknown) => Promise<unknown>> {
    const defs = new Map<string, (ctx: unknown, input: unknown) => Promise<unknown>>();
    const bus = {
      register: (def: { name: string; handler: (ctx: unknown, input: unknown) => Promise<unknown> }) => {
        defs.set(def.name, def.handler);
      },
    };
    registerBillingCommands(bus as unknown as CommandBus, { asaasPort: port });
    return defs;
  }

  function throwingPort(name: "real" | "echo"): AsaasPort {
    const boom = () => {
      throw new Error("stub port must not be called on this path");
    };
    return { name, createPixCharge: boom, getCharge: boom, executeRefund: boom, getRefund: boom };
  }

  function approvedRefundRequest(): unknown {
    return {
      id: REFUND_REQUEST_ID,
      payment_id: PAYMENT_ID,
      status: "APPROVED",
      amount_minor: "2000",
      currency: "BRL",
      requested_by_id: "requester-1",
      human_review_request_id: "rev-1",
      decided_at: null,
    };
  }

  function confirmedPayment(): unknown {
    return {
      id: PAYMENT_ID,
      order_id: "order-1",
      status: "CONFIRMED",
      amount_minor: "6000",
      currency: "BRL",
    };
  }

  it("finding 1: refund.execute_approved refunds the bound EXTERNAL charge id, not the internal payment uuid", async () => {
    const sent: RefundRequest[] = [];
    const port: AsaasPort = {
      ...throwingPort("real"),
      executeRefund: (input: RefundRequest) => {
        sent.push(input);
        return Promise.resolve({ effect: "KNOWN_NOT_APPLIED", providerRefundId: null, detail: "stub: rejected" });
      },
    };
    const paymentSelects: unknown[] = [confirmedPayment(), { charge_id: CHARGE_ID }];
    const trx = new StubTrx({
      onTakeFirst: (call, n) => {
        void n;
        if (call.table === "billing.refund_requests") {
          return approvedRefundRequest();
        }
        if (call.table === "billing.payments") {
          return paymentSelects.shift();
        }
        if (call.table === "billing.charge_provider_bindings") {
          return { external_charge_id: "pay_ext_123" };
        }
        if (call.table === "billing.refunds") {
          return { id: REFUND_ID };
        }
        return undefined;
      },
      onExecute: (call) => {
        if (call.table === "agent.human_review_actions") {
          return [{ action_type: "APPROVE", actor_user_id: "approver-9" }];
        }
        if (call.table === "billing.refunds") {
          return [];
        }
        return {};
      },
    });
    const handlers = handlersFor(port);
    const execute = handlers.get("refund.execute_approved");
    if (execute === undefined) {
      throw new Error("refund.execute_approved not registered");
    }
    const result = await execute(stubCtx(trx), { refundRequestId: REFUND_REQUEST_ID });
    expect(result).toMatchObject({ ok: true, data: { effectCertainty: "KNOWN_NOT_APPLIED", status: "FAILED" } });
    expect(sent).toHaveLength(1);
    // Lineage keeps the internal payment uuid, but the provider call targets
    // the proven external charge id from the binding.
    expect(sent[0]?.paymentId).toBe(PAYMENT_ID);
    expect(sent[0]?.providerChargeId).toBe("pay_ext_123");
  });

  it("finding 1b: without a proven external charge the refund is NOT attempted (reservation held)", async () => {
    const sent: RefundRequest[] = [];
    const port: AsaasPort = {
      ...throwingPort("real"),
      executeRefund: (input: RefundRequest) => {
        sent.push(input);
        return Promise.resolve({ effect: "KNOWN_APPLIED", providerRefundId: "refund_x", detail: "stub" });
      },
    };
    const paymentSelects: unknown[] = [confirmedPayment(), { charge_id: CHARGE_ID }];
    const trx = new StubTrx({
      onTakeFirst: (call, n) => {
        void n;
        if (call.table === "billing.refund_requests") {
          return approvedRefundRequest();
        }
        if (call.table === "billing.payments") {
          return paymentSelects.shift();
        }
        if (call.table === "billing.charge_provider_bindings") {
          return { external_charge_id: `unknown-${CHARGE_ID}` };
        }
        if (call.table === "billing.refunds") {
          return { id: REFUND_ID };
        }
        return undefined;
      },
      onExecute: (call) => {
        if (call.table === "agent.human_review_actions") {
          return [{ action_type: "APPROVE", actor_user_id: "approver-9" }];
        }
        if (call.table === "billing.refunds") {
          return [];
        }
        return {};
      },
    });
    const handlers = handlersFor(port);
    const execute = handlers.get("refund.execute_approved");
    if (execute === undefined) {
      throw new Error("refund.execute_approved not registered");
    }
    const result = await execute(stubCtx(trx), { refundRequestId: REFUND_REQUEST_ID });
    expect(result).toMatchObject({ ok: true, data: { status: "RECONCILING", effectCertainty: "UNKNOWN" } });
    expect(sent).toHaveLength(0);
    const held = trx.updates.filter(
      (u) => u.table === "billing.refunds" && (u.set as { status?: string } | undefined)?.status === "RECONCILING",
    );
    expect(held).toHaveLength(1);
  });

  it("finding 2: refund.reconcile without a proven external id holds the reservation (never releases it)", async () => {
    const port = throwingPort("real");
    const trx = new StubTrx({
      onTakeFirst: (call) => {
        if (call.table === "billing.refunds") {
          return {
            id: REFUND_ID,
            refund_request_id: REFUND_REQUEST_ID,
            payment_id: PAYMENT_ID,
            status: "RECONCILING",
            effect_certainty: "UNKNOWN",
            amount_minor: "400",
            currency: "BRL",
            provider_external_id: null,
          };
        }
        if (call.table === "billing.exceptions") {
          return undefined;
        }
        return undefined;
      },
    });
    const handlers = handlersFor(port);
    const reconcile = handlers.get("refund.reconcile");
    if (reconcile === undefined) {
      throw new Error("refund.reconcile not registered");
    }
    // The throwing stub proves the provider is never consulted for a local
    // reference; only the failed assertion below would surface a call.
    const result = await reconcile(stubCtx(trx), { refundId: REFUND_ID });
    expect(result).toMatchObject({ ok: true, data: { refundId: REFUND_ID, status: "RECONCILING", effectCertainty: "UNKNOWN" } });
    const released = trx.updates.filter(
      (u) => u.table === "billing.refunds" && (u.set as { status?: string } | undefined)?.status === "FAILED",
    );
    expect(released).toHaveLength(0);
    const kept = trx.inserts.filter(
      (i) => i.table === "billing.exceptions" && (i.values as { kind?: string } | undefined)?.kind === "REFUND_UNKNOWN_EFFECT",
    );
    expect(kept).toHaveLength(1);
  });

  it("finding 4: charge.reconcile refuses confirmation on amount/currency divergence (exception, stays PROCESSING)", async () => {
    const port: AsaasPort = {
      ...throwingPort("real"),
      getCharge: () => Promise.resolve({ status: "PAID", valueMinor: 999n, currency: "BRL", detail: "stub" }),
    };
    const trx = new StubTrx({
      onTakeFirst: (call) => {
        if (call.table === "billing.charges") {
          return { id: CHARGE_ID, order_id: "order-1", status: "PROCESSING", amount_minor: "6000", currency: "BRL" };
        }
        if (call.table === "billing.charge_provider_bindings") {
          return { external_charge_id: "pay_x" };
        }
        return undefined;
      },
    });
    const handlers = handlersFor(port);
    const reconcile = handlers.get("charge.reconcile");
    if (reconcile === undefined) {
      throw new Error("charge.reconcile not registered");
    }
    const result = await reconcile(stubCtx(trx), { chargeId: CHARGE_ID });
    expect(result).toMatchObject({ ok: true, data: { id: CHARGE_ID, status: "PROCESSING", outcome: "exception" } });
    const mismatches = trx.inserts.filter(
      (i) => i.table === "billing.exceptions" && (i.values as { kind?: string } | undefined)?.kind === "AMOUNT_MISMATCH",
    );
    expect(mismatches).toHaveLength(1);
    const paid = trx.updates.filter(
      (u) => u.table === "billing.charges" && (u.set as { status?: string } | undefined)?.status === "PAID",
    );
    expect(paid).toHaveLength(0);
  });

  it("MVP-ASAAS-03a: currency divergence opens AMOUNT_MISMATCH and posts no ledger", async () => {
    const port: AsaasPort = {
      ...throwingPort("real"),
      getCharge: () => Promise.resolve({ status: "PAID", valueMinor: 6000n, currency: "USD", detail: "stub" }),
    };
    const trx = new StubTrx({
      onTakeFirst: (call) => {
        if (call.table === "billing.charges") {
          return { id: CHARGE_ID, order_id: "order-1", status: "PROCESSING", amount_minor: "6000", currency: "BRL" };
        }
        if (call.table === "billing.charge_provider_bindings") {
          return { external_charge_id: "pay_x" };
        }
        return undefined;
      },
    });
    const handlers = handlersFor(port);
    const reconcile = handlers.get("charge.reconcile");
    if (reconcile === undefined) {
      throw new Error("charge.reconcile not registered");
    }
    const result = await reconcile(stubCtx(trx), { chargeId: CHARGE_ID });
    expect(result).toMatchObject({ ok: true, data: { id: CHARGE_ID, status: "PROCESSING", outcome: "exception" } });
    const mismatches = trx.inserts.filter(
      (i) => i.table === "billing.exceptions" && (i.values as { kind?: string } | undefined)?.kind === "AMOUNT_MISMATCH",
    );
    expect(mismatches).toHaveLength(1);
    expect(trx.inserts.filter((i) => i.table === "finance.financial_transactions")).toHaveLength(0);
    expect(
      trx.updates.filter(
        (u) => u.table === "billing.charges" && (u.set as { status?: string } | undefined)?.status === "PAID",
      ),
    ).toHaveLength(0);
  });

  it("MVP-ASAAS-03b: matching PAID readback confirms and posts the confirmation ledger", async () => {
    const port: AsaasPort = {
      ...throwingPort("real"),
      getCharge: () => Promise.resolve({ status: "PAID", valueMinor: 6000n, currency: "BRL", detail: "stub" }),
    };
    const trx = new StubTrx({
      onTakeFirst: (call) => {
        if (call.table === "billing.charges") {
          return { id: CHARGE_ID, order_id: "order-1", status: "PROCESSING", amount_minor: "6000", currency: "BRL" };
        }
        if (call.table === "billing.charge_provider_bindings") {
          return { external_charge_id: "pay_x" };
        }
        if (call.table === "billing.payments") {
          return call.op === "insert" ? { id: PAYMENT_ID } : undefined;
        }
        if (call.table === "commerce.orders") {
          return undefined;
        }
        if (call.table === "finance.financial_transactions") {
          return call.op === "insert" ? { id: "fin-tx-1" } : undefined;
        }
        if (call.table === "finance.financial_accounts") {
          return { id: "acct-1" };
        }
        return undefined;
      },
    });
    const handlers = handlersFor(port);
    const reconcile = handlers.get("charge.reconcile");
    if (reconcile === undefined) {
      throw new Error("charge.reconcile not registered");
    }
    const result = await reconcile(stubCtx(trx), { chargeId: CHARGE_ID });
    expect(result).toMatchObject({ ok: true, data: { id: CHARGE_ID, status: "PAID", outcome: "confirmed" } });
    expect(
      trx.updates.filter(
        (u) => u.table === "billing.charges" && (u.set as { status?: string } | undefined)?.status === "PAID",
      ),
    ).toHaveLength(1);
    expect(trx.inserts.filter((i) => i.table === "finance.financial_transactions")).toHaveLength(1);
    expect(
      trx.inserts.filter(
        (i) => i.table === "billing.exceptions" && (i.values as { kind?: string } | undefined)?.kind === "AMOUNT_MISMATCH",
      ),
    ).toHaveLength(0);
  });

  it("MVP-ASAAS-03c: echo charge.reconcile confirms by configured outcome (no amount evidence)", async () => {
    process.env["ASAAS_ECHO_RECONCILE"] = "paid";
    const port = new EchoAsaasAdapter();
    const trx = new StubTrx({
      onTakeFirst: (call) => {
        if (call.table === "billing.charges") {
          return { id: CHARGE_ID, order_id: "order-1", status: "PROCESSING", amount_minor: "6000", currency: "BRL" };
        }
        if (call.table === "billing.charge_provider_bindings") {
          return { external_charge_id: `echo-${CHARGE_ID}` };
        }
        if (call.table === "billing.payments") {
          return call.op === "insert" ? { id: PAYMENT_ID } : undefined;
        }
        if (call.table === "commerce.orders") {
          return undefined;
        }
        if (call.table === "finance.financial_transactions") {
          return call.op === "insert" ? { id: "fin-tx-1" } : undefined;
        }
        if (call.table === "finance.financial_accounts") {
          return { id: "acct-1" };
        }
        return undefined;
      },
    });
    const handlers = handlersFor(port);
    const reconcile = handlers.get("charge.reconcile");
    if (reconcile === undefined) {
      throw new Error("charge.reconcile not registered");
    }
    const result = await reconcile(stubCtx(trx), { chargeId: CHARGE_ID });
    expect(result).toMatchObject({ ok: true, data: { id: CHARGE_ID, status: "PAID", outcome: "confirmed" } });
    expect(
      trx.inserts.filter(
        (i) => i.table === "billing.exceptions" && (i.values as { kind?: string } | undefined)?.kind === "AMOUNT_MISMATCH",
      ),
    ).toHaveLength(0);
    expect(trx.inserts.filter((i) => i.table === "finance.financial_transactions")).toHaveLength(1);
  });

  it("MVP-ASAAS-03d: echo refund.reconcile resolves applied through the echo adapter", async () => {
    process.env["ASAAS_ECHO_REFUND_RECONCILE"] = "applied";
    const port = new EchoAsaasAdapter();
    const trx = new StubTrx({
      onTakeFirst: (call) => {
        if (call.table === "billing.refunds") {
          return {
            id: REFUND_ID,
            refund_request_id: REFUND_REQUEST_ID,
            payment_id: PAYMENT_ID,
            status: "RECONCILING",
            effect_certainty: "UNKNOWN",
            amount_minor: "2000",
            currency: "BRL",
            provider_external_id: `echo-refund-${REFUND_ID}`,
          };
        }
        if (call.table === "billing.payments") {
          return { id: PAYMENT_ID, order_id: "order-1", status: "CONFIRMED", amount_minor: "6000", currency: "BRL" };
        }
        if (call.table === "finance.financial_transactions") {
          return call.op === "insert" ? { id: "fin-tx-2" } : undefined;
        }
        if (call.table === "finance.financial_accounts") {
          return { id: "acct-1" };
        }
        return undefined;
      },
      onExecute: (call) => {
        if (call.table === "billing.refunds") {
          return [];
        }
        return {};
      },
    });
    const handlers = handlersFor(port);
    const reconcile = handlers.get("refund.reconcile");
    if (reconcile === undefined) {
      throw new Error("refund.reconcile not registered");
    }
    const result = await reconcile(stubCtx(trx), { refundId: REFUND_ID });
    expect(result).toMatchObject({ ok: true, data: { refundId: REFUND_ID, effectCertainty: "KNOWN_APPLIED" } });
    expect(
      trx.updates.filter(
        (u) => u.table === "billing.refunds" && (u.set as { status?: string } | undefined)?.status === "SUCCEEDED",
      ),
    ).toHaveLength(1);
    expect(trx.inserts.filter((i) => i.table === "finance.financial_transactions").length).toBeGreaterThan(0);
  });

  it("MVP-ASAAS-03e: echo refund.reconcile resolves not_applied without a reversal posting", async () => {
    process.env["ASAAS_ECHO_REFUND_RECONCILE"] = "not_applied";
    const port = new EchoAsaasAdapter();
    const trx = new StubTrx({
      onTakeFirst: (call) => {
        if (call.table === "billing.refunds") {
          return {
            id: REFUND_ID,
            refund_request_id: REFUND_REQUEST_ID,
            payment_id: PAYMENT_ID,
            status: "RECONCILING",
            effect_certainty: "UNKNOWN",
            amount_minor: "2000",
            currency: "BRL",
            provider_external_id: `echo-refund-${REFUND_ID}`,
          };
        }
        return undefined;
      },
    });
    const handlers = handlersFor(port);
    const reconcile = handlers.get("refund.reconcile");
    if (reconcile === undefined) {
      throw new Error("refund.reconcile not registered");
    }
    const result = await reconcile(stubCtx(trx), { refundId: REFUND_ID });
    expect(result).toMatchObject({ ok: true, data: { refundId: REFUND_ID, status: "FAILED", effectCertainty: "KNOWN_NOT_APPLIED" } });
    expect(
      trx.updates.filter(
        (u) => u.table === "billing.refunds" && (u.set as { status?: string } | undefined)?.status === "FAILED",
      ),
    ).toHaveLength(1);
    expect(trx.inserts.filter((i) => i.table === "finance.financial_transactions")).toHaveLength(0);
  });

  it("MVP-ASAAS-04a: real charge ref reconciled under echo NEVER confirms (PROCESSING + exception, zero ledger)", async () => {
    process.env["ASAAS_ECHO_RECONCILE"] = "paid";
    // Instrumented (MVP-ASAAS-05): the adapter must NEVER be consulted for a
    // foreign binding — any call fails the test.
    const calls: string[] = [];
    const fail = (op: string) => (): never => {
      calls.push(op);
      throw new Error(`spy: ${op} must not be called for a foreign binding`);
    };
    const port: AsaasPort = {
      name: "echo",
      createPixCharge: fail("createPixCharge"),
      getCharge: fail("getCharge"),
      executeRefund: fail("executeRefund"),
      getRefund: fail("getRefund"),
    };
    const trx = new StubTrx({
      onTakeFirst: (call) => {
        if (call.table === "billing.charges") {
          return { id: CHARGE_ID, order_id: "order-1", status: "PROCESSING", amount_minor: "6000", currency: "BRL" };
        }
        if (call.table === "billing.charge_provider_bindings") {
          return { external_charge_id: "pay_real_123" };
        }
        return undefined;
      },
    });
    const handlers = handlersFor(port);
    const reconcile = handlers.get("charge.reconcile");
    if (reconcile === undefined) {
      throw new Error("charge.reconcile not registered");
    }
    const result = await reconcile(stubCtx(trx), { chargeId: CHARGE_ID });
    expect(result).toMatchObject({ ok: true, data: { id: CHARGE_ID, status: "PROCESSING", outcome: "exception" } });
    expect(calls).toHaveLength(0);
    expect(
      trx.updates.filter(
        (u) => u.table === "billing.charges" && (u.set as { status?: string } | undefined)?.status === "PAID",
      ),
    ).toHaveLength(0);
    expect(trx.inserts.filter((i) => i.table === "finance.financial_transactions")).toHaveLength(0);
    expect(trx.inserts.filter((i) => i.table === "billing.exceptions")).toHaveLength(1);
  });

  it("MVP-ASAAS-04b: real refund ref reconciled under echo NEVER resolves (RECONCILING + exception, reservation retained)", async () => {
    process.env["ASAAS_ECHO_REFUND_RECONCILE"] = "applied";
    // Instrumented (MVP-ASAAS-05): the adapter must NEVER be consulted for a
    // foreign refund ref — any call fails the test.
    const calls: string[] = [];
    const fail = (op: string) => (): never => {
      calls.push(op);
      throw new Error(`spy: ${op} must not be called for a foreign refund ref`);
    };
    const port: AsaasPort = {
      name: "echo",
      createPixCharge: fail("createPixCharge"),
      getCharge: fail("getCharge"),
      executeRefund: fail("executeRefund"),
      getRefund: fail("getRefund"),
    };
    const trx = new StubTrx({
      onTakeFirst: (call) => {
        if (call.table === "billing.refunds") {
          return {
            id: REFUND_ID,
            refund_request_id: REFUND_REQUEST_ID,
            payment_id: PAYMENT_ID,
            status: "RECONCILING",
            effect_certainty: "UNKNOWN",
            amount_minor: "2000",
            currency: "BRL",
            provider_external_id: "refund_real_1",
          };
        }
        if (call.table === "billing.exceptions") {
          return undefined;
        }
        return undefined;
      },
    });
    const handlers = handlersFor(port);
    const reconcile = handlers.get("refund.reconcile");
    if (reconcile === undefined) {
      throw new Error("refund.reconcile not registered");
    }
    const result = await reconcile(stubCtx(trx), { refundId: REFUND_ID });
    expect(result).toMatchObject({ ok: true, data: { refundId: REFUND_ID, status: "RECONCILING", effectCertainty: "UNKNOWN" } });
    expect(calls).toHaveLength(0);
    expect(
      trx.updates.filter(
        (u) => u.table === "billing.refunds" && (u.set as { status?: string } | undefined)?.status === "SUCCEEDED",
      ),
    ).toHaveLength(0);
    expect(trx.inserts.filter((i) => i.table === "finance.financial_transactions")).toHaveLength(0);
    const held = trx.inserts.filter(
      (i) => i.table === "billing.exceptions" && (i.values as { kind?: string } | undefined)?.kind === "REFUND_UNKNOWN_EFFECT",
    );
    expect(held).toHaveLength(1);
  });

  it("MVP-ASAAS-05a: refund.execute_approved with a REAL binding under echo NEVER calls the adapter (RECONCILING + exception, zero ledger)", async () => {
    process.env["ASAAS_ECHO_REFUND"] = "applied";
    const calls: string[] = [];
    const fail = (op: string) => (): never => {
      calls.push(op);
      throw new Error(`spy: ${op} must not be called for a real binding under echo`);
    };
    const port: AsaasPort = {
      name: "echo",
      createPixCharge: fail("createPixCharge"),
      getCharge: fail("getCharge"),
      executeRefund: fail("executeRefund"),
      getRefund: fail("getRefund"),
    };
    const paymentSelects: unknown[] = [confirmedPayment(), { charge_id: CHARGE_ID }];
    const trx = new StubTrx({
      onTakeFirst: (call, n) => {
        void n;
        if (call.table === "billing.refund_requests") {
          return approvedRefundRequest();
        }
        if (call.table === "billing.payments") {
          return paymentSelects.shift();
        }
        if (call.table === "billing.charge_provider_bindings") {
          return { external_charge_id: "pay_real_123" };
        }
        if (call.table === "billing.refunds") {
          return { id: REFUND_ID };
        }
        return undefined;
      },
      onExecute: (call) => {
        if (call.table === "agent.human_review_actions") {
          return [{ action_type: "APPROVE", actor_user_id: "approver-9" }];
        }
        if (call.table === "billing.refunds") {
          return [];
        }
        return {};
      },
    });
    const handlers = handlersFor(port);
    const execute = handlers.get("refund.execute_approved");
    if (execute === undefined) {
      throw new Error("refund.execute_approved not registered");
    }
    const result = await execute(stubCtx(trx), { refundRequestId: REFUND_REQUEST_ID });
    expect(result).toMatchObject({ ok: true, data: { status: "RECONCILING", effectCertainty: "UNKNOWN" } });
    expect(calls).toHaveLength(0);
    const heldReserve = trx.updates.filter(
      (u) => u.table === "billing.refunds" && (u.set as { status?: string } | undefined)?.status === "RECONCILING",
    );
    expect(heldReserve).toHaveLength(1);
    expect(
      trx.updates.filter(
        (u) => u.table === "billing.refunds" && (u.set as { status?: string } | undefined)?.status === "SUCCEEDED",
      ),
    ).toHaveLength(0);
    expect(trx.inserts.filter((i) => i.table === "finance.financial_transactions")).toHaveLength(0);
    const held = trx.inserts.filter(
      (i) => i.table === "billing.exceptions" && (i.values as { kind?: string } | undefined)?.kind === "REFUND_UNKNOWN_EFFECT",
    );
    expect(held).toHaveLength(1);
  });

  it("MVP-ASAAS-05b: refund.execute_approved with an ECHO binding under real NEVER calls the adapter (RECONCILING + exception, zero ledger)", async () => {
    const calls: string[] = [];
    const fail = (op: string) => (): never => {
      calls.push(op);
      throw new Error(`spy: ${op} must not be called for an echo binding under real`);
    };
    const port: AsaasPort = {
      name: "real",
      createPixCharge: fail("createPixCharge"),
      getCharge: fail("getCharge"),
      executeRefund: fail("executeRefund"),
      getRefund: fail("getRefund"),
    };
    const paymentSelects: unknown[] = [confirmedPayment(), { charge_id: CHARGE_ID }];
    const trx = new StubTrx({
      onTakeFirst: (call, n) => {
        void n;
        if (call.table === "billing.refund_requests") {
          return approvedRefundRequest();
        }
        if (call.table === "billing.payments") {
          return paymentSelects.shift();
        }
        if (call.table === "billing.charge_provider_bindings") {
          return { external_charge_id: `echo-${CHARGE_ID}` };
        }
        if (call.table === "billing.refunds") {
          return { id: REFUND_ID };
        }
        return undefined;
      },
      onExecute: (call) => {
        if (call.table === "agent.human_review_actions") {
          return [{ action_type: "APPROVE", actor_user_id: "approver-9" }];
        }
        if (call.table === "billing.refunds") {
          return [];
        }
        return {};
      },
    });
    const handlers = handlersFor(port);
    const execute = handlers.get("refund.execute_approved");
    if (execute === undefined) {
      throw new Error("refund.execute_approved not registered");
    }
    const result = await execute(stubCtx(trx), { refundRequestId: REFUND_REQUEST_ID });
    expect(result).toMatchObject({ ok: true, data: { status: "RECONCILING", effectCertainty: "UNKNOWN" } });
    expect(calls).toHaveLength(0);
    const heldReserve = trx.updates.filter(
      (u) => u.table === "billing.refunds" && (u.set as { status?: string } | undefined)?.status === "RECONCILING",
    );
    expect(heldReserve).toHaveLength(1);
    expect(
      trx.updates.filter(
        (u) => u.table === "billing.refunds" && (u.set as { status?: string } | undefined)?.status === "SUCCEEDED",
      ),
    ).toHaveLength(0);
    expect(trx.inserts.filter((i) => i.table === "finance.financial_transactions")).toHaveLength(0);
    const held = trx.inserts.filter(
      (i) => i.table === "billing.exceptions" && (i.values as { kind?: string } | undefined)?.kind === "REFUND_UNKNOWN_EFFECT",
    );
    expect(held).toHaveLength(1);
  });

  it("MVP-ASAAS-05c: echo adapter chokepoint refuses foreign refs (UNKNOWN, never KNOWN_APPLIED, zero I/O)", async () => {
    process.env["ASAAS_ECHO_RECONCILE"] = "paid";
    process.env["ASAAS_ECHO_REFUND"] = "applied";
    process.env["ASAAS_ECHO_REFUND_RECONCILE"] = "applied";
    const port = new EchoAsaasAdapter();
    const charge = await port.getCharge({ providerChargeId: "pay_real_123" });
    expect(charge.status).toBe("UNKNOWN");
    const exec = await port.executeRefund({
      paymentId: "11111111-1111-4111-8111-111111111111",
      refundId: "55555555-5555-4555-8555-555555555555",
      providerChargeId: "pay_real_123",
      valueMinor: 2000n,
      currency: "BRL",
    });
    expect(exec.effect).toBe("UNKNOWN");
    expect(exec.providerRefundId).toBeNull();
    const execNull = await port.executeRefund({
      paymentId: "11111111-1111-4111-8111-111111111111",
      refundId: "55555555-5555-4555-8555-555555555555",
      providerChargeId: null,
      valueMinor: 2000n,
      currency: "BRL",
    });
    expect(execNull.effect).toBe("UNKNOWN");
    expect(execNull.providerRefundId).toBeNull();
    const refund = await port.getRefund({ providerRefundId: "refund_real_1" });
    expect(refund.effect).toBe("UNKNOWN");
    // Own namespace still works.
    const ownCharge = await port.getCharge({ providerChargeId: "echo-abc" });
    expect(ownCharge.status).toBe("PAID");
    const ownExec = await port.executeRefund({
      paymentId: "11111111-1111-4111-8111-111111111111",
      refundId: "55555555-5555-4555-8555-555555555555",
      providerChargeId: "echo-abc",
      valueMinor: 2000n,
      currency: "BRL",
    });
    expect(ownExec.effect).toBe("KNOWN_APPLIED");
  });

  it("MVP-ASAAS-05d: provenExternalChargeId is namespace-strict (echo owns echo- only; echo- is synthetic for real)", async () => {
    expect(provenExternalChargeId("echo", "echo-abc")).toBe("echo-abc");
    expect(provenExternalChargeId("echo", "pay_real_123")).toBeNull();
    expect(provenExternalChargeId("echo", null)).toBeNull();
    expect(provenExternalChargeId("echo", "  ")).toBeNull();
    expect(provenExternalChargeId("real", "echo-abc")).toBeNull();
    expect(provenExternalChargeId("real", "pay_real_123")).toBe("pay_real_123");
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
