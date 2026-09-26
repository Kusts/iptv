import { describe, expect, it } from "vitest";
import {
  POLICY_CLASS_ORDER,
  baseAutonomyOf,
  clampAutonomyToMax,
  downgradeAutonomy,
  maxAutonomyOf,
  mergePolicyLayers,
  notConfigured,
  scopeMatchesClass,
  scopeOfClass,
} from "../src/policy.js";

describe("autonomy downgrade-only semantics", () => {
  it("downgrades AUTO to the bound but never upgrades", () => {
    expect(downgradeAutonomy("AUTO", "APPROVAL")).toBe("APPROVAL");
    expect(downgradeAutonomy("AUTO", "MANUAL")).toBe("MANUAL");
    expect(downgradeAutonomy("AUTO", "DENY")).toBe("DENY");
    expect(downgradeAutonomy("AUTO", "AUTO")).toBe("AUTO");
  });

  it("keeps the lower level when the request is already below the bound", () => {
    expect(downgradeAutonomy("MANUAL", "AUTO")).toBe("MANUAL");
    expect(downgradeAutonomy("APPROVAL", "AUTO")).toBe("APPROVAL");
    expect(downgradeAutonomy("DENY", "AUTO")).toBe("DENY");
  });

  it("clamps to a platform max without silent upgrade", () => {
    expect(clampAutonomyToMax("AUTO", "MANUAL")).toBe("MANUAL");
    expect(clampAutonomyToMax("MANUAL", "AUTO")).toBe("MANUAL");
    expect(clampAutonomyToMax("APPROVAL", "APPROVAL")).toBe("APPROVAL");
  });
});

describe("policy class precedence", () => {
  it("orders PLATFORM_INVARIANT above PARTNER_POLICY", () => {
    expect(POLICY_CLASS_ORDER["PLATFORM_INVARIANT"]).toBeLessThan(
      POLICY_CLASS_ORDER["PLATFORM_POLICY"],
    );
    expect(POLICY_CLASS_ORDER["PLATFORM_POLICY"]).toBeLessThan(POLICY_CLASS_ORDER["TENANT_POLICY"]);
    expect(POLICY_CLASS_ORDER["TENANT_POLICY"]).toBeLessThan(POLICY_CLASS_ORDER["PARTNER_POLICY"]);
  });

  it("merges so lower layers only fill keys not set by higher layers", () => {
    const higher = { allow: true, autonomy: "APPROVAL", max_autonomy: "MANUAL" };
    const lower = { autonomy: "AUTO", extra: "tenant-value", allow: false };
    expect(mergePolicyLayers([higher, lower])).toEqual({
      allow: true,
      autonomy: "APPROVAL",
      max_autonomy: "MANUAL",
      extra: "tenant-value",
    });
  });

  it("validates scope/class coherence", () => {
    expect(scopeMatchesClass("PLATFORM", "PLATFORM_INVARIANT")).toBe(true);
    expect(scopeMatchesClass("PLATFORM", "PLATFORM_POLICY")).toBe(true);
    expect(scopeMatchesClass("TENANT", "TENANT_POLICY")).toBe(true);
    expect(scopeMatchesClass("PARTNER", "PARTNER_POLICY")).toBe(true);
    expect(scopeMatchesClass("TENANT", "PLATFORM_POLICY")).toBe(false);
    expect(scopeMatchesClass("PLATFORM", "TENANT_POLICY")).toBe(false);
    expect(scopeMatchesClass("NOPE", "TENANT_POLICY")).toBe(false);
    expect(scopeOfClass("PARTNER_POLICY")).toBe("PARTNER");
  });
});

describe("generic document interpretation", () => {
  it("derives base autonomy from allow/autonomy/require_approval", () => {
    expect(baseAutonomyOf({ allow: false, autonomy: "AUTO" })).toBe("DENY");
    expect(baseAutonomyOf({ autonomy: "MANUAL" })).toBe("MANUAL");
    expect(baseAutonomyOf({ require_approval: true })).toBe("APPROVAL");
    expect(baseAutonomyOf({})).toBe("AUTO");
    expect(baseAutonomyOf({ autonomy: "NOPE" })).toBe("AUTO");
  });

  it("reads the platform max only from a valid max_autonomy key", () => {
    expect(maxAutonomyOf({ max_autonomy: "MANUAL" })).toBe("MANUAL");
    expect(maxAutonomyOf({})).toBeNull();
    expect(maxAutonomyOf({ max_autonomy: "NOPE" })).toBeNull();
  });

  it("returns a typed not-configured result for missing families", () => {
    expect(notConfigured()).toEqual({ configured: false, value: {}, provenance: [] });
  });
});
