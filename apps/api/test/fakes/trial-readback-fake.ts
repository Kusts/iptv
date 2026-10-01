import type {
  TrialReadbackPort,
  TrialReadbackQuery,
  TrialReadbackResult,
} from "../../src/trial/trial-readback.js";

/**
 * FASE5-S6 test fake for `TrialReadbackPort`: controllable READ_CUSTOMER
 * snapshots for the trial postcondition gate. The `satisfied` mode
 * deliberately returns `isTrial` as the STRING `"1"` so the happy path
 * always exercises the §11 defensive normalization (never a pre-normalized
 * boolean). `externalId` derives deterministically from the trial id for
 * stable binding asserts.
 *
 * FASE5-FIX3 (fixture correction): the id derives from the UUIDv7 RANDOM
 * tail (`slice(-12)`), never the head — the head (`slice(0, 8)`) is a
 * timestamp prefix that collides for same-window creations (65s window),
 * manufacturing an impossible world (two provider customers sharing one
 * stable id) that the `provider_bindings_external_unique` constraint
 * rightly rejects. Same documented pattern as the Wave 7 fixtures.
 */
export function fakeTrialExternalId(trialId: string): string {
  return `trial-${trialId.replace(/-/g, "").slice(-12)}`;
}
export type FakeTrialReadbackMode =
  | "satisfied"
  | "not-trial"
  | "expired"
  | "missing-id"
  | "missing-customer"
  | "inconclusive"
  | "throw"
  | "null-customer";

export class FakeTrialReadback implements TrialReadbackPort {
  readonly queries: TrialReadbackQuery[] = [];

  constructor(public mode: FakeTrialReadbackMode = "satisfied") {}

  async readTrialCustomer(query: TrialReadbackQuery): Promise<TrialReadbackResult> {
    this.queries.push(query);
    const externalId = fakeTrialExternalId(query.trialId);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    switch (this.mode) {
      case "satisfied":
        return {
          conclusive: true,
          customer: { exists: true, externalId, isTrial: "1", expiresAt: future },
          evidence: "fake:conclusive",
        };
      case "not-trial":
        return {
          conclusive: true,
          customer: { exists: true, externalId, isTrial: "false", expiresAt: future },
          evidence: "fake:conclusive",
        };
      case "expired":
        return {
          conclusive: true,
          customer: { exists: true, externalId, isTrial: true, expiresAt: past },
          evidence: "fake:conclusive",
        };
      case "missing-id":
        return {
          conclusive: true,
          customer: { exists: true, externalId: null, isTrial: true, expiresAt: future },
          evidence: "fake:conclusive",
        };
      case "missing-customer":
        return {
          conclusive: true,
          customer: { exists: false, externalId: null, isTrial: null, expiresAt: null },
          evidence: "fake:conclusive",
        };
      case "inconclusive":
        return { conclusive: false, customer: null, evidence: "fake:inconclusive" };
      case "null-customer":
        // FASE5-FIX4-N2: conclusive snapshot WITHOUT a customer — carries
        // no proof, so recovery must converge HUMAN_REQUIRED directly
        // instead of re-parking VERIFYING through the applier.
        return { conclusive: true, customer: null, evidence: "fake:null-customer" };
      case "throw":
        throw new Error("fake readback transport failure");
    }
  }
}
