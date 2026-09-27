/**
 * Wave 5 pure money/transition math (no I/O, no floats).
 *
 * Every amount here is an integer count of minor units (`bigint`). There is
 * deliberately NO `number` arithmetic on money: callers convert at the
 * boundary with `toMinor`, which accepts the exact decimal strings node-pg
 * returns for `bigint`/`numeric` columns.
 */

/** Owning-context order transitions (subset of the migration-004 CHECK set). */
export const ORDER_TRANSITIONS: Record<string, readonly string[]> = {
  DRAFT: ["AWAITING_PAYMENT", "CANCELLED", "EXPIRED"],
  AWAITING_PAYMENT: ["SETTLED", "CANCELLED", "EXPIRED"],
  SETTLED: [],
  CANCELLED: [],
  EXPIRED: [],
};

/** Owning-context charge transitions (subset of the migration-005 CHECK set). */
export const CHARGE_TRANSITIONS: Record<string, readonly string[]> = {
  PENDING: ["PROCESSING", "CANCELLED", "EXPIRED"],
  PROCESSING: ["PAID", "FAILED", "CANCELLED", "EXPIRED"],
  PAID: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

/** Payment statuses that still count as settled economic coverage. */
const COVERING_PAYMENT_STATUSES = ["CONFIRMED", "PARTIALLY_REFUNDED", "REFUNDED"] as const;

/** Refund rows that consume the refundable remainder. */
const CONSUMING_REFUND_STATUSES = ["PROCESSING", "RECONCILING", "SUCCEEDED"] as const;

export function isOrderTransition(from: string, to: string): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isChargeTransition(from: string, to: string): boolean {
  return CHARGE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Boundary conversion: exact decimal text (or int) → minor-unit bigint. */
export function toMinor(value: string | number | bigint): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`money must be integer minor units, got non-integer number ${value}`);
    }
    return BigInt(value);
  }
  const text = value.trim();
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`money must be integer minor units, got ${JSON.stringify(value)}`);
  }
  return BigInt(text);
}

export function sumMinors(values: readonly bigint[]): bigint {
  let total = 0n;
  for (const v of values) {
    total += v;
  }
  return total;
}

/** Gross for one order line: unit price × integer quantity (exact). */
export function lineGross(unitMinor: bigint, quantity: number): bigint {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`quantity must be a positive integer, got ${quantity}`);
  }
  return unitMinor * BigInt(quantity);
}

export function isCoveringPaymentStatus(status: string): boolean {
  return (COVERING_PAYMENT_STATUSES as readonly string[]).includes(status);
}

export function isConsumingRefundStatus(status: string): boolean {
  return (CONSUMING_REFUND_STATUSES as readonly string[]).includes(status);
}

export interface CoverageInput {
  orderNetMinor: bigint;
  payments: ReadonlyArray<{ status: string; amountMinor: bigint }>;
  succeededRefundsMinor: bigint;
}

/**
 * Settlement evaluation (pure): covered = Σ covering payments − succeeded
 * refunds; the order settles when covered >= net. Over-payment never
 * inflates `settled_amount`: it is capped at net (mirrors the
 * `orders_settled_not_over_net` CHECK).
 */
export function evaluateCoverage(input: CoverageInput): { coveredMinor: bigint; settled: boolean; settledAmountMinor: bigint } {
  const paid = sumMinors(
    input.payments.filter((p) => isCoveringPaymentStatus(p.status)).map((p) => p.amountMinor),
  );
  const covered = paid - input.succeededRefundsMinor;
  const settled = covered >= input.orderNetMinor;
  return {
    coveredMinor: covered,
    settled,
    settledAmountMinor: settled ? input.orderNetMinor : 0n,
  };
}

export interface RefundableInput {
  paidMinor: bigint;
  consumedMinor: bigint;
}

/** Remaining refundable = paid − consumed (succeeded + reserved). Never negative. */
export function remainingRefundable(input: RefundableInput): bigint {
  const remaining = input.paidMinor - input.consumedMinor;
  return remaining < 0n ? 0n : remaining;
}

/** Payment status after a KNOWN_APPLIED refund given the remainder left. */
export function paymentStatusAfterRefund(remainingAfterMinor: bigint): "PARTIALLY_REFUNDED" | "REFUNDED" {
  return remainingAfterMinor <= 0n ? "REFUNDED" : "PARTIALLY_REFUNDED";
}

export interface LedgerEntryInput {
  accountCode: string;
  currency: string;
  direction: "DEBIT" | "CREDIT";
  amountMinor: bigint;
}

/**
 * Double-entry balance check (pure): per currency, Σ debits must equal
 * Σ credits and every amount must be strictly positive (mirrors the
 * `financial_ledger_amount_positive` CHECK plus the deferred
 * `financial_ledger_balanced_at_commit` trigger).
 */
export function assertLedgerBalanced(entries: readonly LedgerEntryInput[]): void {
  if (entries.length < 2) {
    throw new Error(`ledger transaction must contain at least two entries, got ${entries.length}`);
  }
  const netByCurrency = new Map<string, bigint>();
  for (const entry of entries) {
    if (entry.amountMinor <= 0n) {
      throw new Error(`ledger entry for ${entry.accountCode} must be positive, got ${entry.amountMinor}`);
    }
    const signed = entry.direction === "DEBIT" ? entry.amountMinor : -entry.amountMinor;
    netByCurrency.set(entry.currency, (netByCurrency.get(entry.currency) ?? 0n) + signed);
  }
  for (const [currency, net] of netByCurrency) {
    if (net !== 0n) {
      throw new Error(`ledger transaction is not balanced for ${currency}: net ${net}`);
    }
  }
}

/**
 * Webhook amount validation (pure): NEVER trust provider amounts — the
 * reported value/currency must equal the internal charge row exactly, or the
 * delivery becomes an exception (never a confirmation).
 */
export function webhookAmountMatchesCharge(input: {
  reportedAmountMinor: bigint | null;
  reportedCurrency: string | null;
  chargeAmountMinor: bigint;
  chargeCurrency: string;
}): boolean {
  if (input.reportedAmountMinor === null || input.reportedCurrency === null) {
    return false;
  }
  return input.reportedAmountMinor === input.chargeAmountMinor && input.reportedCurrency === input.chargeCurrency;
}
