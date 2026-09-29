import { describe, expect, it } from "vitest";
import {
  nextAppTrialStatus,
  type AppTrialStatus,
  type AppTrialTransition,
} from "../src/inventory/app-trial.store.js";

describe("Wave 7 AppTrial lifecycle transitions (pure)", () => {
  it("walks the happy path REQUESTED -> VALIDATED", () => {
    expect(nextAppTrialStatus("REQUESTED", "VALIDATE")).toBe("VALIDATED");
    expect(nextAppTrialStatus("ACTIVE", "VALIDATE")).toBe("VALIDATED");
  });

  it("supports activation, rejection and expiry from open states", () => {
    expect(nextAppTrialStatus("REQUESTED", "ACTIVATE")).toBe("ACTIVE");
    expect(nextAppTrialStatus("REQUESTED", "INVALIDATE")).toBe("INVALIDATED");
    expect(nextAppTrialStatus("REQUESTED", "EXPIRE")).toBe("EXPIRED");
    expect(nextAppTrialStatus("ACTIVE", "INVALIDATE")).toBe("INVALIDATED");
    expect(nextAppTrialStatus("ACTIVE", "EXPIRE")).toBe("EXPIRED");
  });

  it("rejects every transition out of a terminal state", () => {
    const terminal: AppTrialStatus[] = ["VALIDATED", "EXPIRED", "INVALIDATED"];
    const transitions: AppTrialTransition[] = ["ACTIVATE", "VALIDATE", "INVALIDATE", "EXPIRE"];
    for (const status of terminal) {
      for (const transition of transitions) {
        expect(() => nextAppTrialStatus(status, transition)).toThrow(
          `invalid app trial transition ${transition} from ${status}`,
        );
      }
    }
  });

  it("rejects re-activation and double validation of an open trial", () => {
    expect(() => nextAppTrialStatus("ACTIVE", "ACTIVATE")).toThrow("invalid app trial transition");
    expect(() => nextAppTrialStatus("VALIDATED", "VALIDATE")).toThrow("invalid app trial transition");
    expect(() => nextAppTrialStatus("REQUESTED", "VALIDATE")).not.toThrow();
  });
});
