import { describe, expect, it } from "vitest";
import {
  computeAvailablePool,
  nextReservationStatus,
  parsePositiveMinor,
} from "../src/inventory/supplier-credit.store.js";

describe("Wave 7 supplier credit math and reservation transitions (pure)", () => {
  it("computes the available pool with exact minor-unit math", () => {
    expect(computeAvailablePool("100000", "0")).toBe("100000");
    expect(computeAvailablePool("100000", "40000")).toBe("60000");
    expect(computeAvailablePool("2000", "2000")).toBe("0");
  });

  it("floors an over-reserved pool at zero instead of going negative", () => {
    expect(computeAvailablePool("1000", "99999")).toBe("0");
  });

  it("rejects malformed pool inputs without floating-point math", () => {
    expect(() => computeAvailablePool("10.5", "0")).toThrow(/minor-unit/);
    expect(() => computeAvailablePool("-1", "0")).toThrow(/minor-unit/);
    expect(() => computeAvailablePool("100", "abc")).toThrow(/minor-unit/);
  });

  it("parses strictly positive amounts and rejects zero/negative/fractional", () => {
    expect(parsePositiveMinor("2000")).toBe(2000n);
    expect(parsePositiveMinor(null)).toBeNull();
    expect(() => parsePositiveMinor("0")).toThrow();
    expect(() => parsePositiveMinor("-5")).toThrow();
    expect(() => parsePositiveMinor("10.5")).toThrow();
  });

  it("walks ACTIVE -> CONSUMED/RELEASED/EXPIRED and only from ACTIVE", () => {
    expect(nextReservationStatus("ACTIVE", "CONSUME")).toBe("CONSUMED");
    expect(nextReservationStatus("ACTIVE", "RELEASE")).toBe("RELEASED");
    expect(nextReservationStatus("ACTIVE", "EXPIRE")).toBe("EXPIRED");
    for (const terminal of ["CONSUMED", "RELEASED", "EXPIRED"] as const) {
      for (const transition of ["CONSUME", "RELEASE", "EXPIRE"] as const) {
        expect(() => nextReservationStatus(terminal, transition)).toThrow("invalid credit reservation transition");
      }
    }
  });

  it("never revives a terminal reservation back to ACTIVE", () => {
    expect(() => nextReservationStatus("CONSUMED", "CONSUME")).toThrow();
    expect(() => nextReservationStatus("RELEASED", "RELEASE")).toThrow();
  });
});
