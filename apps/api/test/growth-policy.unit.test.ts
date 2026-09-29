import { describe, expect, it } from "vitest";
import {
  gateContact,
  hourInZone,
  isQuietHour,
  nextAllowedSlot,
  parseMinor,
} from "../src/growth/growth-policy.js";

describe("growth-policy quiet hours (America/Sao_Paulo)", () => {
  const tz = "America/Sao_Paulo";

  it("defers 22:30 local but not 10:00 local", () => {
    expect(isQuietHour(new Date("2026-09-30T22:30:00-03:00"), tz)).toBe(true);
    expect(isQuietHour(new Date("2026-09-30T10:00:00-03:00"), tz)).toBe(false);
  });

  it("treats the 21:00–08:00 window as [inclusive, exclusive)", () => {
    expect(isQuietHour(new Date("2026-09-30T21:00:00-03:00"), tz)).toBe(true);
    expect(isQuietHour(new Date("2026-09-30T07:59:00-03:00"), tz)).toBe(true);
    expect(isQuietHour(new Date("2026-09-30T08:00:00-03:00"), tz)).toBe(false);
    expect(hourInZone(new Date("2026-09-30T22:30:00-03:00"), tz)).toBe(22);
  });

  it("releases deferred contacts at the next allowed slot", () => {
    // Outside the window: unchanged.
    const day = new Date("2026-09-30T10:00:00-03:00");
    expect(nextAllowedSlot(day, tz).getTime()).toBe(day.getTime());
    // Inside the window: strictly later and outside the window.
    const night = new Date("2026-09-30T22:30:00-03:00");
    const release = nextAllowedSlot(night, tz);
    expect(release.getTime()).toBeGreaterThan(night.getTime());
    expect(isQuietHour(release, tz)).toBe(false);
    expect(hourInZone(release, tz)).toBe(8);
  });
});

describe("growth-policy contact gate", () => {
  it("suppression and opt-out beat budget and quiet", () => {
    expect(
      gateContact({ suppressed: true, optedOut: false, overBudget: true, quiet: true }),
    ).toEqual({ verdict: "BLOCKED", reason: "SUPPRESSED" });
    expect(
      gateContact({ suppressed: false, optedOut: true, overBudget: false, quiet: false }),
    ).toEqual({ verdict: "BLOCKED", reason: "OPTED_OUT" });
  });

  it("budget blocks before quiet defers", () => {
    expect(
      gateContact({ suppressed: false, optedOut: false, overBudget: true, quiet: true }),
    ).toEqual({ verdict: "BLOCKED", reason: "BUDGET_EXCEEDED" });
    expect(
      gateContact({ suppressed: false, optedOut: false, overBudget: false, quiet: true }),
    ).toEqual({ verdict: "DEFERRED" });
    expect(
      gateContact({ suppressed: false, optedOut: false, overBudget: false, quiet: false }),
    ).toEqual({ verdict: "SCHEDULED" });
  });
});

describe("growth-policy money parsing", () => {
  it("parses exact minor strings and rejects floats", () => {
    expect(parseMinor("1000", "cap")).toBe(1000n);
    expect(() => parseMinor("10.5", "cap")).toThrow();
    expect(() => parseMinor("-1", "cap")).toThrow();
  });
});
