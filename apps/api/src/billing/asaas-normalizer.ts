import { moneyFromDecimal } from "@iptv/domain";

/**
 * Asaas webhook payload normalizer (Wave 5).
 *
 * Assumed provider shape (documented, validated defensively):
 * ```json
 * { "event": "PAYMENT_RECEIVED", "payment": { "id": "pay_...", "value": 30.00 } }
 * ```
 * `value` is decimal MAJOR units and is parsed WITHOUT float arithmetic
 * (`moneyFromDecimal`). The parsed amount is UNTRUSTED evidence: the
 * confirm command validates it against the internal charge row and refuses
 * to confirm on any mismatch.
 */

export type AsaasNormalized =
  | {
      kind: "paid";
      externalChargeId: string;
      externalEventId: string;
      reportedAmountMinor: string | null;
      reportedCurrency: string | null;
    }
  | {
      kind: "chargeback";
      externalChargeId: string;
      externalEventId: string;
      reportedAmountMinor: string | null;
    }
  | { kind: "unknown" };

const PAID_EVENTS = ["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED", "PAYMENTRECEIVED"];
const CHARGEBACK_EVENTS = ["PAYMENT_CHARGEBACK", "PAYMENT_REFUND_REQUESTED", "PAYMENTCHARGEBACK"];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function eventIdOf(body: Record<string, unknown>, fallback: string): string {
  const direct = body["id"];
  if (typeof direct === "string" && direct.trim().length > 0) {
    return `asaas:${direct.trim()}`;
  }
  return fallback;
}

/** Parse a decimal major-unit value to exact minor-unit text (BRL=2dp default). */
function minorTextOf(value: unknown, currency: string): string | null {
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  try {
    return moneyFromDecimal(String(value), currency).amountMinor.toString();
  } catch {
    return null;
  }
}

export function normalizeAsaasPayload(body: unknown, rawBody: unknown): AsaasNormalized {
  const root = asRecord(body);
  if (root === null) {
    return { kind: "unknown" };
  }
  const event = typeof root["event"] === "string" ? root["event"].trim().toUpperCase() : "";
  const payment = asRecord(root["payment"]);
  const externalChargeId =
    typeof payment?.["id"] === "string" && (payment["id"] as string).trim().length > 0
      ? (payment["id"] as string).trim()
      : null;
  if (externalChargeId === null) {
    return { kind: "unknown" };
  }
  const fallback = `asaas:${event}:${externalChargeId}`;
  const externalEventId = eventIdOf(root, fallback);
  void rawBody;
  if (PAID_EVENTS.includes(event)) {
    const currencyRaw = typeof payment?.["currency"] === "string" ? (payment["currency"] as string).trim().toUpperCase() : "BRL";
    const currency = /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : "BRL";
    return {
      kind: "paid",
      externalChargeId,
      externalEventId,
      reportedAmountMinor: minorTextOf(payment?.["value"], currency),
      reportedCurrency: currency,
    };
  }
  if (CHARGEBACK_EVENTS.includes(event)) {
    return {
      kind: "chargeback",
      externalChargeId,
      externalEventId,
      reportedAmountMinor: minorTextOf(payment?.["value"], "BRL"),
    };
  }
  return { kind: "unknown" };
}
