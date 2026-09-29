import { describe, expect, it } from "vitest";
import {
  ACADEMY_TOPIC_KEYS,
  canActivate,
  canOrder,
  computeAvailableCredit,
  nextStatusOnTopicStart,
  nextStatusOnTopicsComplete,
  parsePositiveMinor,
} from "../src/partners/partners.store.js";

describe("Wave 13 partners store (pure)", () => {
  it("academy catalog covers the 10 canonical topics", () => {
    expect(ACADEMY_TOPIC_KEYS.length).toBe(10);
    expect(new Set(ACADEMY_TOPIC_KEYS).size).toBe(10);
    expect(ACADEMY_TOPIC_KEYS[0]).toBe("academy-01-product-service");
    expect(ACADEMY_TOPIC_KEYS[9]).toBe("academy-10-saas-pathway");
  });

  it("lifecycle gates: onboarding starts training, ready on all topics, explicit activation", () => {
    expect(nextStatusOnTopicStart("ONBOARDING")).toBe("TRAINING");
    expect(nextStatusOnTopicStart("TRAINING")).toBe("TRAINING");
    expect(nextStatusOnTopicStart("ACTIVE")).toBe("ACTIVE");
    expect(nextStatusOnTopicsComplete("TRAINING", 10, 10)).toBe("READY");
    expect(nextStatusOnTopicsComplete("TRAINING", 9, 10)).toBe("TRAINING");
    expect(nextStatusOnTopicsComplete("ACTIVE", 10, 10)).toBe("ACTIVE");
    expect(canActivate("READY")).toBe(true);
    expect(canActivate("TRAINING")).toBe(false);
    expect(canActivate("ONBOARDING")).toBe(false);
    expect(canOrder("ACTIVE")).toBe(true);
    expect(canOrder("READY")).toBe(false);
  });

  it("available credit is ledger minus holds (exact strings)", () => {
    expect(computeAvailableCredit("10000", "0")).toBe("10000");
    expect(computeAvailableCredit("10000", "3000")).toBe("7000");
    expect(computeAvailableCredit("0", "0")).toBe("0");
    expect(() => computeAvailableCredit("10.5", "0")).toThrow();
  });

  it("amounts are strictly positive minor-unit integers", () => {
    expect(parsePositiveMinor("3000")).toBe(3000n);
    expect(() => parsePositiveMinor("0")).toThrow();
    expect(() => parsePositiveMinor("-5")).toThrow();
    expect(() => parsePositiveMinor("10.5")).toThrow();
  });
});
