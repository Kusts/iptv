/**
 * Exact money representation: integer minor units + ISO 4217 currency code.
 * Never use binary floating point for money.
 */
export interface MinorMoney {
  readonly amountMinor: bigint;
  readonly currency: string;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * ISO 4217 minor-unit table for commonly used currencies (code → fractionDigits).
 * Codes not listed here are rejected as unknown.
 */
const CURRENCY_FRACTION_DIGITS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  BRL: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  CHF: 2,
  CNY: 2,
  INR: 2,
  MXN: 2,
  ARS: 2,
  PEN: 2,
  COP: 2,
  HKD: 2,
  SGD: 2,
  NZD: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  PLN: 2,
  CZK: 2,
  ILS: 2,
  ZAR: 2,
  AED: 2,
  SAR: 2,
  EGP: 2,
  NGN: 2,
  PHP: 2,
  THB: 2,
  MYR: 2,
  IDR: 2,
  TWD: 2,
  JPY: 0,
  KRW: 0,
  CLP: 0,
  VND: 0,
  BHD: 3,
  KWD: 3,
  JOD: 3,
  OMR: 3,
  TND: 3,
};

/** Fraction digits for a known currency; throws for unknown codes. */
function fractionDigitsFor(currency: string): number {
  const digits = CURRENCY_FRACTION_DIGITS[currency];
  if (digits === undefined) {
    throw new Error(
      `invalid currency code: ${JSON.stringify(currency)} (unknown ISO 4217 code; supported: ${Object.keys(CURRENCY_FRACTION_DIGITS).sort().join(", ")})`,
    );
  }
  return digits;
}

function assertCurrency(currency: string): void {
  if (!CURRENCY_RE.test(currency)) {
    throw new Error(`invalid currency code: ${JSON.stringify(currency)} (expected ISO 4217, e.g. "BRL")`);
  }
  fractionDigitsFor(currency);
}

function assertIntegerMinor(amountMinor: bigint): void {
  if (typeof amountMinor !== "bigint") {
    throw new Error("amountMinor must be a bigint of integer minor units");
  }
}

function assertSameCurrency(a: MinorMoney, b: MinorMoney): void {
  if (a.currency !== b.currency) {
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

/** Construct exact money from integer minor units (e.g. centavos). */
export function moneyFromMinor(amountMinor: bigint, currency: string): MinorMoney {
  assertIntegerMinor(amountMinor);
  assertCurrency(currency);
  return { amountMinor, currency };
}

/** Construct exact money from a decimal string like "30.00" (no float parsing). */
export function moneyFromDecimal(decimal: string, currency: string, fractionDigits?: number): MinorMoney {
  assertCurrency(currency);
  const digits = fractionDigits ?? fractionDigitsFor(currency);
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!m) throw new Error(`invalid decimal money: ${JSON.stringify(decimal)}`);
  const [, sign, intPart, fracPartRaw = ""] = m;
  if (fracPartRaw.length > digits) {
    throw new Error(`too many fraction digits: ${JSON.stringify(decimal)}`);
  }
  const fracPart = fracPartRaw.padEnd(digits, "0");
  const minor = BigInt(`${sign}${intPart}${fracPart}`);
  return { amountMinor: minor, currency };
}

/** Compare two same-currency amounts: -1 | 0 | 1. */
export function compareMoney(a: MinorMoney, b: MinorMoney): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

/** Add two same-currency amounts. */
export function addMoney(a: MinorMoney, b: MinorMoney): MinorMoney {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

/** Subtract two same-currency amounts. */
export function subtractMoney(a: MinorMoney, b: MinorMoney): MinorMoney {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

/** Format as decimal string; defaults to the currency's ISO 4217 fraction digits. */
export function formatMoney(m: MinorMoney, fractionDigits?: number): string {
  const digits = fractionDigits ?? CURRENCY_FRACTION_DIGITS[m.currency] ?? 2;
  const negative = m.amountMinor < 0n;
  const abs = negative ? -m.amountMinor : m.amountMinor;
  const base = 10n ** BigInt(digits);
  const intPart = abs / base;
  if (digits === 0) {
    return `${negative ? "-" : ""}${intPart.toString()} ${m.currency}`;
  }
  const fracPart = (abs % base).toString().padStart(digits, "0");
  return `${negative ? "-" : ""}${intPart.toString()}.${fracPart} ${m.currency}`;
}
