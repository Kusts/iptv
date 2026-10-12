/**
 * CINEVISION write-adapter prep tests (SIMULATED-only).
 *
 * Covers: typed write interface validation, lease/fencing plumbing,
 * idempotency keys, timeout→UNKNOWN classification, readback + reconcile
 * hook, and negative tests (no authz, timeout, duplicate replay).
 * No live provider actions; no invented endpoints.
 */

import { describe, expect, it } from "vitest";
import {
  CinevisionWriteSkeletonAdapter,
  InMemorySimulatedCinevisionWriteExternal,
} from "../../src/providers/cinevision/write-simulated.js";
import {
  classifyCinevisionWriteTimeout,
  decideCinevisionLeaseRecovery,
  decideCinevisionWriteReconcile,
  validateCinevisionWriteInput,
  type CinevisionWriteInput,
} from "../../src/providers/cinevision/writes.js";

let keySeq = 0;
function nextKey(prefix: string): string {
  keySeq += 1;
  return `${prefix}-key-${String(keySeq).padStart(4, "0")}`;
}

function writeInput(overrides: Partial<CinevisionWriteInput> = {}): CinevisionWriteInput {
  return {
    action: "createTrial",
    idempotencyKey: nextKey("cv"),
    fencingToken: `fencing-token-${String(keySeq).padStart(4, "0")}-abcdef`,
    entityId: "trial-0001",
    fields: { duration_minutes: 60 },
    credentialRef: "infisical://test/cinevision/BROWSER_KEY",
    ...overrides,
  };
}

describe("cinevision write input validation", () => {
  it("rejects credential values where a secret ref is required", () => {
    expect(validateCinevisionWriteInput(writeInput({ credentialRef: "raw-value" }))).toContain(
      "secret ref",
    );
  });

  it("rejects malformed idempotency keys and short fencing tokens", () => {
    expect(validateCinevisionWriteInput(writeInput({ idempotencyKey: "" }))).toContain("idempotencyKey");
    expect(validateCinevisionWriteInput(writeInput({ fencingToken: "short" }))).toContain("fencingToken");
  });

  it("rejects secret-like field keys and ref-like field values", () => {
    expect(
      validateCinevisionWriteInput(writeInput({ fields: { password: "x" } })),
    ).toContain("forbidden key");
    expect(
      validateCinevisionWriteInput(writeInput({ fields: { note: "infisical://x" } })),
    ).toContain("forbidden ref value");
  });

  it("adapter parks invalid input as MANUAL with zero sends", async () => {
    const external = new InMemorySimulatedCinevisionWriteExternal();
    const adapter = new CinevisionWriteSkeletonAdapter({ external });
    const result = await adapter.execute(writeInput({ idempotencyKey: "bad key!" }));
    expect(result.outcome).toBe("MANUAL");
    expect(external.sends).toHaveLength(0);
    expect(adapter.audit).toHaveLength(1);
  });
});

describe("cinevision write negative paths (SIMULATED)", () => {
  it("no-authz parks MANUAL (operator gate)", async () => {
    const external = new InMemorySimulatedCinevisionWriteExternal("no_authz");
    const adapter = new CinevisionWriteSkeletonAdapter({ external });
    const result = await adapter.execute(writeInput());
    expect(result.outcome).toBe("MANUAL");
    expect(result.needsHuman).toBe(true);
  });

  it("timeout classifies to UNKNOWN/VERIFYING, never FAILED", async () => {
    const external = new InMemorySimulatedCinevisionWriteExternal("timeout");
    const adapter = new CinevisionWriteSkeletonAdapter({ external });
    const result = await adapter.execute(writeInput());
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.reconciliationState).toBe("VERIFYING");
    expect(classifyCinevisionWriteTimeout("createTrial").outcome).toBe("UNKNOWN");
  });

  it("duplicate replay yields a single effect", async () => {
    const external = new InMemorySimulatedCinevisionWriteExternal("success");
    const adapter = new CinevisionWriteSkeletonAdapter({ external });
    const key = nextKey("cv");
    const first = await adapter.execute(writeInput({ idempotencyKey: key }));
    const second = await adapter.execute(writeInput({ idempotencyKey: key }));
    expect(first.outcome).toBe("SUCCESS");
    expect(second.outcome).toBe("SUCCESS");
    expect(external.effectCount).toBe(1);
  });

  it("lease recovery reuses the migration 045 frontier polarity", () => {
    expect(
      decideCinevisionLeaseRecovery({ status: "RUNNING", leaseExpired: true, dispatchStarted: false }),
    ).toBe("release");
    expect(
      decideCinevisionLeaseRecovery({ status: "RUNNING", leaseExpired: true, dispatchStarted: true }),
    ).toBe("park_verifying");
    expect(
      decideCinevisionLeaseRecovery({ status: "RUNNING", leaseExpired: false, dispatchStarted: true }),
    ).toBe("none");
    expect(
      decideCinevisionLeaseRecovery({ status: "SUCCEEDED", leaseExpired: true, dispatchStarted: true }),
    ).toBe("none");
  });
});

describe("cinevision write readback + reconciliation hook", () => {
  it("conclusive applied readback reconciles to succeed", async () => {
    const external = new InMemorySimulatedCinevisionWriteExternal("success");
    const adapter = new CinevisionWriteSkeletonAdapter({ external });
    const input = writeInput();
    const sent = await adapter.execute(input);
    expect(sent.externalRef).not.toBeNull();
    const { decision } = await adapter.reconcile(input, {
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      externalRef: sent.externalRef,
    });
    expect(decision).toEqual({ kind: "succeed" });
  });

  it("conclusive not-applied readback reconciles to fail", () => {
    expect(
      decideCinevisionWriteReconcile({ effectApplied: false, conclusive: true, evidence: "x", simulated: true }),
    ).toEqual({ kind: "fail" });
  });

  it("inconclusive readback reconciles to MANUAL, never a re-send", async () => {
    const external = new InMemorySimulatedCinevisionWriteExternal("unknown");
    const adapter = new CinevisionWriteSkeletonAdapter({ external });
    const input = writeInput();
    await adapter.execute(input);
    const sendsBefore = external.sends.length;
    const { decision } = await adapter.reconcile(input, {
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      externalRef: "cv-sim-missing-ref",
    });
    expect(decision.kind).toBe("manual");
    expect(external.sends).toHaveLength(sendsBefore);
  });

  it("input/query identity mismatch stays MANUAL: UNKNOWN input never adopts another op SUCCESS", async () => {
    const external = new InMemorySimulatedCinevisionWriteExternal("success");
    const adapter = new CinevisionWriteSkeletonAdapter({ external });
    const inputA = writeInput();
    const inputB = writeInput();
    await external.send(inputA, "unknown");
    const sentB = await external.send(inputB, "success");
    expect(sentB.result.outcome).toBe("SUCCESS");
    expect(sentB.result.externalRef).not.toBeNull();
    const sendsBefore = external.sends.length;
    const { decision, readback } = await adapter.reconcile(inputA, {
      action: inputB.action,
      idempotencyKey: inputB.idempotencyKey,
      externalRef: sentB.result.externalRef,
    });
    expect(decision.kind).toBe("manual");
    expect(readback.conclusive).toBe(false);
    expect(external.sends).toHaveLength(sendsBefore);
  });

  it("input/query identity mismatch stays MANUAL: UNKNOWN input never adopts another op FAILURE", async () => {
    const external = new InMemorySimulatedCinevisionWriteExternal("success");
    const adapter = new CinevisionWriteSkeletonAdapter({ external });
    const inputA = writeInput();
    const inputB = writeInput();
    await external.send(inputA, "unknown");
    await external.send(inputB, "failure");
    const sendsBefore = external.sends.length;
    const { decision, readback } = await adapter.reconcile(inputA, {
      action: inputB.action,
      idempotencyKey: inputB.idempotencyKey,
      externalRef: null,
    });
    expect(decision.kind).toBe("manual");
    expect(decision).not.toEqual({ kind: "fail" });
    expect(readback.conclusive).toBe(false);
    expect(external.sends).toHaveLength(sendsBefore);
  });
});
