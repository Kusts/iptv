import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRIAL_READBACK_MIN_FUTURE_MS,
  evaluateTrialProvisionPostconditions,
  isTrialPostconditionMismatch,
  normalizeTrialIsTrial,
  type TrialReadbackResult,
} from "../src/trial/trial-readback.js";

/**
 * Pure unit coverage for the §11 `is_trial` allowlist and the postcondition
 * evaluation that consumes it. No DB, no port: this file must stay runnable
 * without `TEST_DATABASE_URL` (the sibling `trial-readback.integration.test.ts`
 * is the DB-bound suite).
 *
 * FASE5-CINE-READBACK (cross-boundary contract): a REAL trial readback port
 * forwards the representation the browser worker observed. The worker's own
 * parser (`apps/browser-worker/src/providers/cinevision/schemas.ts`,
 * `normalizeIsTrial`) is the authority for that representation and accepts
 * EXACTLY `"true" | "false" | "YES" | "NO"`, fail-closed for everything else
 * (live evidence 2026-10-05: panel v3.94, customers `total = 18`, `is_trial`
 * distribution `YES: 7` / `NO: 11`). Before this fix the API normalizer
 * returned `null` for `"YES"`/`"NO"`, so the postcondition evaluated
 * `not_trial` and a real adapter would have fail-closed on a CORRECT trial.
 */

/** Exact allowlist of the browser-worker `normalizeIsTrial` (do not widen). */
const WORKER_ALLOWLIST: string[] = ["true", "false", "YES", "NO"];

/**
 * Values the worker rejects AND this normalizer must keep rejecting
 * (lowercase, whitespace-padded, other numbers/words, non-strings).
 */
const SHARED_REJECTIONS: unknown[] = [
  "yes",
  "no",
  "y",
  "n",
  " YES",
  "YES ",
  " NO",
  "NO ",
  "Yes",
  "2",
  "",
  "   ",
  "sim",
  null,
  undefined,
  2,
  {},
  [],
];

/**
 * Values the worker rejects but this normalizer still accepts: the §11
 * legacy/dev arm (trimmed, case-insensitive `"true"`/`"false"`/`"1"`/`"0"`)
 * plus booleans and numbers. Deliberate superset for non-provider fixtures;
 * pinned here so a future tightening is an explicit, reviewed decision.
 */
const API_ONLY_TOLERANCES: unknown[] = ["TRUE", "True", "true ", "1", "0", true, false, 1, 0];

function readback(isTrial: unknown): TrialReadbackResult {
  return {
    conclusive: true,
    customer: {
      exists: true,
      externalId: "cv-123456",
      isTrial,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    evidence: "test:conclusive",
  };
}

describe("FASE5-CINE-READBACK §11 is_trial canonical contract (exact provider representations)", () => {
  it.each([
    ["YES", true],
    ["NO", false],
  ])("accepts the live-evidenced exact representation %s", (raw, expected) => {
    expect(normalizeTrialIsTrial(raw)).toBe(expected);
  });

  it.each([
    ["true", true],
    ["false", false],
    ["1", true],
    ["0", false],
    [true, true],
    [false, false],
    [1, true],
    [0, false],
  ])("keeps the pre-existing accepted representation %s", (raw, expected) => {
    expect(normalizeTrialIsTrial(raw)).toBe(expected);
  });

  it.each([
    ["yes", "lowercase"],
    ["no", "lowercase"],
    ["y", "single letter"],
    [" YES", "leading whitespace"],
    ["YES ", "trailing whitespace"],
    [" YES ", "whitespace on both sides"],
    ["Yes", "mixed case"],
  ])("rejects %s (%s) — never case-folded nor trimmed", (raw) => {
    expect(normalizeTrialIsTrial(raw)).toBeNull();
  });

  it.each([
    ["2", "out-of-contract number string"],
    ["", "blank"],
    ["   ", "whitespace-only"],
    ["sim", "undocumented word"],
  ])("rejects %s (%s)", (raw) => {
    expect(normalizeTrialIsTrial(raw)).toBeNull();
  });

  it.each([[null], [undefined]])("rejects %s (absent)", (raw) => {
    expect(normalizeTrialIsTrial(raw)).toBeNull();
  });

  it("rejects objects and arrays without coercing", () => {
    expect(normalizeTrialIsTrial({})).toBeNull();
    expect(normalizeTrialIsTrial({ is_trial: "YES" })).toBeNull();
    expect(normalizeTrialIsTrial(["YES"])).toBeNull();
  });

  it("never turns a worker-accepted representation into null (no fail-closed on a correct trial)", () => {
    for (const accepted of WORKER_ALLOWLIST) {
      expect(normalizeTrialIsTrial(accepted)).not.toBeNull();
    }
  });

  it("rejects exactly what the worker parser rejects", () => {
    for (const rejected of SHARED_REJECTIONS) {
      expect(normalizeTrialIsTrial(rejected)).toBeNull();
    }
  });

  it("keeps the documented §11 legacy/dev arm (deliberate superset over the worker)", () => {
    for (const tolerated of API_ONLY_TOLERANCES) {
      expect(normalizeTrialIsTrial(tolerated)).not.toBeNull();
    }
  });
});

describe("FASE5-CINE-READBACK postcondition (b) consumes the canonical is_trial", () => {
  it('"YES" (live-evidenced representation) SATISFIES postcondition (b) instead of not_trial', () => {
    const verdict = evaluateTrialProvisionPostconditions(readback("YES"), {
      now: new Date(),
      minFutureMs: DEFAULT_TRIAL_READBACK_MIN_FUTURE_MS,
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("expected a satisfied verdict");
    expect(verdict.normalized.externalId).toBe("cv-123456");
    expect(isTrialPostconditionMismatch("not_trial")).toBe(true);
  });

  it('"NO" is a conclusive non-trial → not_trial (never a silent success)', () => {
    expect(evaluateTrialProvisionPostconditions(readback("NO"))).toEqual({ ok: false, reason: "not_trial" });
  });

  it('lowercase "yes" and padded " YES" stay rejected → not_trial (strictness preserved)', () => {
    expect(evaluateTrialProvisionPostconditions(readback("yes"))).toEqual({ ok: false, reason: "not_trial" });
    expect(evaluateTrialProvisionPostconditions(readback(" YES"))).toEqual({ ok: false, reason: "not_trial" });
  });

  it("an absent/inconclusive readback still fails closed as uncertain (unchanged)", () => {
    expect(evaluateTrialProvisionPostconditions(null)).toEqual({ ok: false, reason: "readback_absent" });
    expect(
      evaluateTrialProvisionPostconditions({ conclusive: false, customer: null, evidence: "test:inconclusive" }),
    ).toEqual({ ok: false, reason: "readback_inconclusive" });
    expect(isTrialPostconditionMismatch("readback_absent")).toBe(false);
    expect(isTrialPostconditionMismatch("readback_inconclusive")).toBe(false);
  });
});