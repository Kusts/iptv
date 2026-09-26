import { describe, expect, it } from "vitest";
import {
  addMoney,
  compareMoney,
  formatMoney,
  moneyFromDecimal,
  moneyFromMinor,
  subtractMoney,
} from "../src/money.js";

describe("money", () => {
  it("constructs exact minor-unit money without floats", () => {
    const m = moneyFromMinor(3000n, "BRL");
    expect(m.amountMinor).toBe(3000n);
    expect(formatMoney(m)).toBe("30.00 BRL");
  });

  it("parses decimal strings exactly (no float parsing)", () => {
    expect(moneyFromDecimal("30.00", "BRL").amountMinor).toBe(3000n);
    expect(moneyFromDecimal("0.1", "BRL").amountMinor).toBe(10n);
    expect(moneyFromDecimal("-2.5", "BRL").amountMinor).toBe(-250n);
  });

  it("adds / subtracts / compares same-currency amounts", () => {
    const a = moneyFromMinor(3000n, "BRL");
    const b = moneyFromMinor(1500n, "BRL");
    expect(addMoney(a, b).amountMinor).toBe(4500n);
    expect(subtractMoney(a, b).amountMinor).toBe(1500n);
    expect(compareMoney(a, b)).toBe(1);
    expect(compareMoney(b, b)).toBe(0);
    expect(compareMoney(b, a)).toBe(-1);
  });

  it("guards against mixed currencies", () => {
    const brl = moneyFromMinor(100n, "BRL");
    const usd = moneyFromMinor(100n, "USD");
    expect(() => addMoney(brl, usd)).toThrow(/currency mismatch/);
    expect(() => subtractMoney(brl, usd)).toThrow(/currency mismatch/);
    expect(() => compareMoney(brl, usd)).toThrow(/currency mismatch/);
  });

  it("rejects invalid currency codes and over-precise decimals", () => {
    expect(() => moneyFromMinor(1n, "brl")).toThrow(/invalid currency/);
    expect(() => moneyFromMinor(1n, "BRLL")).toThrow(/invalid currency/);
    expect(() => moneyFromMinor(1n, "XXX")).toThrow(/invalid currency/);
    expect(() => moneyFromDecimal("1.001", "BRL")).toThrow(/fraction digits/);
    expect(() => moneyFromDecimal("nope", "BRL")).toThrow(/invalid decimal/);
  });

  it("formats zero-fraction currencies without a decimal point", () => {
    expect(formatMoney(moneyFromMinor(1n, "JPY"))).toBe("1 JPY");
    expect(formatMoney(moneyFromMinor(1500n, "JPY"))).toBe("1500 JPY");
    expect(formatMoney(moneyFromMinor(-5n, "KRW"))).toBe("-5 KRW");
    expect(formatMoney(moneyFromMinor(100n, "BRL"), 0)).toBe("100 BRL");
  });

  it("uses the currency's ISO 4217 fraction digits by default", () => {
    expect(moneyFromDecimal("1", "JPY").amountMinor).toBe(1n);
    expect(() => moneyFromDecimal("1.5", "JPY")).toThrow(/fraction digits/);
    expect(moneyFromDecimal("1.500", "BHD").amountMinor).toBe(1500n);
    expect(formatMoney(moneyFromMinor(1500n, "BHD"))).toBe("1.500 BHD");
  });
});
