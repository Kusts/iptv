import { describe, expect, it } from "vitest";
import { isBefore, nowIso, parseInstant, toIso } from "../src/time.js";

describe("time", () => {
  it("produces UTC ISO instants", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("round-trips instants and compares ordering", () => {
    const iso = "2026-09-26T12:00:00.000Z";
    expect(toIso(parseInstant(iso))).toBe(iso);
    expect(isBefore("2026-09-26T11:00:00.000Z", iso)).toBe(true);
    expect(isBefore(iso, iso)).toBe(false);
  });

  it("rejects invalid instants", () => {
    expect(() => parseInstant("not-a-date")).toThrow(/invalid instant/);
    expect(() => toIso(new Date("invalid"))).toThrow(/invalid Date/);
  });
});
