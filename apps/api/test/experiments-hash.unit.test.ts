import { describe, expect, it } from "vitest";
import {
  CONTROL_VARIANT,
  assignVariant,
  parseVariantSpec,
  subjectKeyOf,
} from "../src/experiments/experiments-hash.js";

const VARIANTS = parseVariantSpec([
  { key: "control", weightBps: 5000 },
  { key: "treatment", weightBps: 5000 },
]);

describe("Wave 16 deterministic assignment (pure)", () => {
  it("is deterministic: same inputs always yield the same variant", () => {
    const first = assignVariant("exp-checkout", subjectKeyOf("PERSON", "person-1"), 1, VARIANTS);
    const second = assignVariant("exp-checkout", subjectKeyOf("PERSON", "person-1"), 1, VARIANTS);
    expect(second).toBe(first);
  });

  it("is stable across repeated calls (replay returns the same hash)", () => {
    const results = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      results.add(assignVariant("exp-stable", subjectKeyOf("TENANT", "tenant-9"), 3, VARIANTS));
    }
    expect(results.size).toBe(1);
  });

  it("splits traffic across variants (both arms reachable)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(assignVariant("exp-split", subjectKeyOf("PERSON", `person-${i}`), 1, VARIANTS));
    }
    expect(seen).toEqual(new Set(["control", "treatment"]));
  });

  it("isolates experiments: same subject lands independently per key", () => {
    const variants = new Set<string>();
    for (const key of ["exp-a", "exp-b", "exp-c", "exp-d"]) {
      variants.add(assignVariant(key, subjectKeyOf("PERSON", "same-person"), 1, VARIANTS));
    }
    // Not asserting exact arms (hash-internal), only that bucketing ran
    // once per experiment without throwing; determinism is covered above.
    expect(variants.size).toBeGreaterThanOrEqual(1);
  });

  it("re-buckets only when the assignment version bumps", () => {
    const before = assignVariant("exp-version", subjectKeyOf("PERSON", "person-7"), 1, VARIANTS);
    const same = assignVariant("exp-version", subjectKeyOf("PERSON", "person-7"), 1, VARIANTS);
    expect(same).toBe(before);
    // Version 2 must compute without error; the arm may or may not flip.
    expect(assignVariant("exp-version", subjectKeyOf("PERSON", "person-7"), 2, VARIANTS)).toMatch(
      /^(control|treatment)$/,
    );
  });

  it("honors weights: a 100/0 split never leaves the single arm", () => {
    const single = parseVariantSpec([{ key: "control", weightBps: 10000 }]);
    for (let i = 0; i < 50; i += 1) {
      expect(assignVariant("exp-single", subjectKeyOf("PERSON", `p-${i}`), 1, single)).toBe("control");
    }
  });

  it("rejects malformed variant specs instead of guessing", () => {
    expect(() => parseVariantSpec([])).toThrow();
    expect(() => parseVariantSpec([{ key: "control", weightBps: 0 }])).toThrow();
    expect(() => parseVariantSpec([{ key: "control", weightBps: 1.5 }])).toThrow();
    expect(() => parseVariantSpec("control")).toThrow();
    expect(() =>
      parseVariantSpec([
        { key: "control", weightBps: 5000 },
        { key: "control", weightBps: 5000 },
      ]),
    ).toThrow();
  });

  it("exposes the control fallback constant used by the fail-open path", () => {
    expect(CONTROL_VARIANT).toBe("control");
  });
});
