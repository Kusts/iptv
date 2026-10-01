import { describe, expect, it } from "vitest";
import { decideLicenseChargeBranch, resolveLicenseDispatchStatus } from "../src/inventory/license.commands.js";
import { selectDispatchApplier } from "../src/provider/provider-dispatcher.service.js";
import { isSecretRequiredProvenance } from "../src/provider/provider-dispatcher.service.js";

describe("CV-DSP-02 license charge branch decision (pure)", () => {
  it("routes proven outcomes to their finalizers", () => {
    expect(decideLicenseChargeBranch("SUCCEEDED")).toBe("charged");
    expect(decideLicenseChargeBranch("FAILED")).toBe("not_applied");
  });

  it("parks everything else uncertain (never a blind retry)", () => {
    expect(decideLicenseChargeBranch("UNKNOWN")).toBe("uncertain");
    expect(decideLicenseChargeBranch("MANUAL")).toBe("uncertain");
    expect(decideLicenseChargeBranch("")).toBe("uncertain");
    expect(decideLicenseChargeBranch("SOMETHING_ELSE")).toBe("uncertain");
  });
});

describe("CV-DSP-02 closed action→applier registry (pure)", () => {
  it("routes each domain action to its own applier", () => {
    expect(selectDispatchApplier("trial.provision")).toBe("trial");
    expect(selectDispatchApplier("subscription.provision")).toBe("subscription");
    expect(selectDispatchApplier("app_license.purchase")).toBe("license");
  });

  it("keeps unknown actions on the provider applier (owning context)", () => {
    expect(selectDispatchApplier("provider.anything")).toBe("provider");
    expect(selectDispatchApplier("")).toBe("provider");
    expect(selectDispatchApplier("Trial.Provision")).toBe("provider");
  });
});

describe("CV-DSP-02-FIX F4 honest license dispatch status (pure)", () => {
  it("reports the branch status when the domain finalizer succeeds", () => {
    expect(resolveLicenseDispatchStatus({ branch: "charged", finalizerOk: true, rawOutcome: "SUCCEEDED" })).toEqual({
      status: "SUCCEEDED",
      effectCertainty: "KNOWN_APPLIED",
    });
    expect(resolveLicenseDispatchStatus({ branch: "not_applied", finalizerOk: true, rawOutcome: "FAILED" })).toEqual({
      status: "FAILED",
      effectCertainty: "KNOWN_NOT_APPLIED",
    });
    expect(resolveLicenseDispatchStatus({ branch: "uncertain", finalizerOk: true, rawOutcome: "UNKNOWN" })).toEqual({
      status: "VERIFYING",
      effectCertainty: "UNKNOWN",
    });
    expect(resolveLicenseDispatchStatus({ branch: "uncertain", finalizerOk: true, rawOutcome: "MANUAL" })).toEqual({
      status: "HUMAN_REQUIRED",
      effectCertainty: "UNKNOWN",
    });
  });

  it("never masks a failed domain finalization as its branch status", () => {
    // The distinction: a SUCCEEDED port call whose hold/procurement
    // finalization failed surfaces as HUMAN_REQUIRED, never SUCCEEDED.
    expect(resolveLicenseDispatchStatus({ branch: "charged", finalizerOk: false, rawOutcome: "SUCCEEDED" })).toEqual({
      status: "HUMAN_REQUIRED",
      effectCertainty: "UNKNOWN",
    });
    expect(resolveLicenseDispatchStatus({ branch: "not_applied", finalizerOk: false, rawOutcome: "FAILED" })).toEqual({
      status: "HUMAN_REQUIRED",
      effectCertainty: "UNKNOWN",
    });
    expect(resolveLicenseDispatchStatus({ branch: "uncertain", finalizerOk: false, rawOutcome: "UNKNOWN" })).toEqual({
      status: "HUMAN_REQUIRED",
      effectCertainty: "UNKNOWN",
    });
  });
});

describe("CV-DSP-02-FIX F4/F5 license durable path stays inert (pure)", () => {
  it("intent-v1 rows are not secret-required provenance (the claim filter never picks them up)", () => {
    expect(isSecretRequiredProvenance("intent-v1")).toBe(false);
    expect(isSecretRequiredProvenance("secret-required-v1")).toBe(true);
  });
});
