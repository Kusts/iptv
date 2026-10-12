/**
 * Issue #51 critical recovery scenarios — SIMULATED where possible.
 *
 * Implemented WITHOUT live providers via the CINEVISION simulated
 * fixtures. Each test asserts: no duplicate externally-visible mutation on
 * retry, plus an explicit terminal state (SUCCEEDED / FAILED / VERIFYING /
 * MANUAL).
 *
 * Honest LIVE_NEEDED marks: session re-authentication against the real
 * panel, real browser-disconnect recovery, and real crash-restart lease
 * reclaim (migration 045 `recoverOnce`) require a live/operator
 * environment and are NOT proven here.
 */

import { describe, expect, it } from "vitest";
import {
  CinevisionWriteSkeletonAdapter,
  InMemorySimulatedCinevisionWriteExternal,
} from "../../src/providers/cinevision/write-simulated.js";
import type { CinevisionWriteInput } from "../../src/providers/cinevision/writes.js";

let keySeq = 0;
function nextKey(prefix: string): string {
  keySeq += 1;
  return `${prefix}-rec-${String(keySeq).padStart(4, "0")}`;
}

function cvWrite(key: string): CinevisionWriteInput {
  return {
    action: "createTrial",
    idempotencyKey: key,
    fencingToken: `fencing-${key}-token-abcdef`,
    entityId: "trial-0001",
    fields: { duration_minutes: 60 },
    credentialRef: "infisical://test/cinevision/BROWSER_KEY",
  };
}

describe("issue #51: session-expired", () => {
  it("CINEVISION session-expired mid-call → UNKNOWN/VERIFYING (SIMULATED)", async () => {
    const external = new InMemorySimulatedCinevisionWriteExternal("session_expired");
    const adapter = new CinevisionWriteSkeletonAdapter({ external });
    const result = await adapter.execute(cvWrite(nextKey("cv51")));
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.reconciliationState).toBe("VERIFYING");
    // LIVE_NEEDED: real re-authentication (bounded single reauth + identity
    // re-verify) requires the live panel session and is not proven here.
  });
});

describe("issue #51: browser-disconnected", () => {
  it("CINEVISION browser-disconnected mid-call → UNKNOWN/VERIFYING, no duplicate on retry", async () => {
    const external = new InMemorySimulatedCinevisionWriteExternal("browser_disconnected");
    const adapter = new CinevisionWriteSkeletonAdapter({ external });
    const key = nextKey("cv51");
    const first = await adapter.execute(cvWrite(key));
    expect(first.outcome).toBe("UNKNOWN");
    const effectsBefore = external.effectCount;
    await adapter.execute(cvWrite(key));
    expect(external.effectCount).toBe(effectsBefore);
    // LIVE_NEEDED: real Chromium disconnect/restart recovery is proven only
    // against a live browser profile.
  });
});

describe("issue #51: crash-after-external-effect (SIMULATED)", () => {
  it("CINEVISION ack lost after effect → caller sees UNKNOWN, readback finds the effect, retry does not duplicate", async () => {
    const external = new InMemorySimulatedCinevisionWriteExternal("crash_after_effect");
    const adapter = new CinevisionWriteSkeletonAdapter({ external });
    const key = nextKey("cv51");
    const input = cvWrite(key);
    const observed = await adapter.execute(input);
    expect(observed.outcome).toBe("UNKNOWN");
    expect(external.effectCount).toBe(1);
    const { decision } = await adapter.reconcile(input, {
      action: input.action,
      idempotencyKey: key,
      externalRef: `cv-sim-${input.action}-ref`,
    });
    expect(decision).toEqual({ kind: "succeed" });
    const retry = await adapter.execute(cvWrite(key));
    expect(retry.outcome).toBe("SUCCESS");
    expect(external.effectCount).toBe(1);
    // LIVE_NEEDED: real crash-restart lease reclaim runs in migration 045
    // `recoverOnce` against PostgreSQL and is not proven by this unit test.
  });
});

describe("issue #51: CINEVISION readback keyed by operation (no cross-match)", () => {
  it("FAIL vs UNKNOWN stay distinct; null refs and action mismatches never reconcile another op", async () => {
    const external = new InMemorySimulatedCinevisionWriteExternal("success");
    const adapter = new CinevisionWriteSkeletonAdapter({ external });
    const keyA = nextKey("cv51");
    const keyB = nextKey("cv51");
    const inputA = cvWrite(keyA);
    const inputB = cvWrite(keyB);
    await external.send(inputA, "failure");
    await external.send(inputB, "unknown");
    const effectsBefore = external.effectCount;
    const sendsBefore = external.sends.length;
    // A (FAIL, null ref): exact-key lookup reports not-applied conclusively.
    const { decision: decA } = await adapter.reconcile(inputA, {
      action: inputA.action,
      idempotencyKey: keyA,
      externalRef: null,
    });
    expect(decA).toEqual({ kind: "fail" });
    // B (UNKNOWN): inconclusive → manual, never a re-send.
    const { decision: decB } = await adapter.reconcile(inputB, {
      action: inputB.action,
      idempotencyKey: keyB,
      externalRef: null,
    });
    expect(decB.kind).toBe("manual");
    // A null ref for an unknown key never reconciles another operation.
    const { decision: decGhost } = await adapter.reconcile(inputA, {
      action: inputA.action,
      idempotencyKey: nextKey("cv51"),
      externalRef: null,
    });
    expect(decGhost.kind).toBe("manual");
    // Action mismatch never reconciles, even with the right key.
    const { decision: decMismatch } = await adapter.reconcile(inputA, {
      action: "blockCustomer",
      idempotencyKey: keyA,
      externalRef: null,
    });
    expect(decMismatch.kind).toBe("manual");
    // Readback observed only: no new sends, no new effects.
    expect(external.sends).toHaveLength(sendsBefore);
    expect(external.effectCount).toBe(effectsBefore);
  });
});

describe("issue #51: replay/duplication", () => {
  it("identical idempotency keys on the CINEVISION seam converge to one effect", async () => {
    const cvExternal = new InMemorySimulatedCinevisionWriteExternal("success");
    const cv = new CinevisionWriteSkeletonAdapter({ external: cvExternal });
    const cvKey = nextKey("cv51");
    for (let i = 0; i < 3; i += 1) {
      await cv.execute(cvWrite(cvKey));
    }
    expect(cvExternal.effectCount).toBe(1);
  });
});
