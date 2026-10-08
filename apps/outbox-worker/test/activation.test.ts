import { describe, expect, it } from "vitest";
import { ActivationError, checkActivationGate } from "../src/activation.js";

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ActivationError) return err.code;
    throw err;
  }
  return "PASS";
}

describe("activation gate", () => {
  it("passes when quiesced, drain disabled, and nothing in flight", () => {
    expect(
      codeOf(() =>
        checkActivationGate({ legacyQuiesced: true, legacyDrainEnabled: false, legacyInFlight: 0 }),
      ),
    ).toBe("PASS");
  });

  it("refuses unknown drain state (fail-closed: API default is enabled)", () => {
    expect(
      codeOf(() =>
        checkActivationGate({ legacyQuiesced: true, legacyDrainEnabled: null, legacyInFlight: null }),
      ),
    ).toBe("LEGACY_DRAIN_STATE_UNKNOWN");
    expect(
      codeOf(() =>
        checkActivationGate({ legacyQuiesced: true, legacyDrainEnabled: false, legacyInFlight: null }),
      ),
    ).toBe("LEGACY_IN_FLIGHT_UNKNOWN");
  });

  it("refuses when quiescence was never asserted", () => {
    expect(
      codeOf(() =>
        checkActivationGate({ legacyQuiesced: false, legacyDrainEnabled: false, legacyInFlight: 0 }),
      ),
    ).toBe("LEGACY_QUIESCENCE_NOT_ASSERTED");
  });

  it("refuses when the legacy drain is still enabled", () => {
    expect(
      codeOf(() =>
        checkActivationGate({ legacyQuiesced: true, legacyDrainEnabled: true, legacyInFlight: 0 }),
      ),
    ).toBe("LEGACY_DRAIN_STILL_ENABLED");
  });

  it("refuses when legacy rows are still in flight", () => {
    expect(
      codeOf(() =>
        checkActivationGate({ legacyQuiesced: true, legacyDrainEnabled: false, legacyInFlight: 3 }),
      ),
    ).toBe("LEGACY_DRAIN_IN_FLIGHT");
  });

  it("checks quiescence first, then enabled, then in-flight", () => {
    expect(
      codeOf(() =>
        checkActivationGate({ legacyQuiesced: false, legacyDrainEnabled: true, legacyInFlight: 5 }),
      ),
    ).toBe("LEGACY_QUIESCENCE_NOT_ASSERTED");
    expect(
      codeOf(() =>
        checkActivationGate({ legacyQuiesced: true, legacyDrainEnabled: true, legacyInFlight: 5 }),
      ),
    ).toBe("LEGACY_DRAIN_STILL_ENABLED");
  });
});
