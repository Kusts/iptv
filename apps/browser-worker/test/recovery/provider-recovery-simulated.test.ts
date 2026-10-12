/**
 * Issue #51 critical recovery scenarios — SIMULATED where possible.
 *
 * Implemented WITHOUT live providers via the MK + CINEVISION simulated
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
import { MkAtivadorSkeletonAdapter } from "../../src/providers/mkativador/adapter.js";
import { InMemorySimulatedMkExternal } from "../../src/providers/mkativador/simulated.js";
import {
  CinevisionWriteSkeletonAdapter,
  InMemorySimulatedCinevisionWriteExternal,
} from "../../src/providers/cinevision/write-simulated.js";
import type { CinevisionWriteInput } from "../../src/providers/cinevision/writes.js";
import type { MkOperationInput } from "../../src/providers/mkativador/types.js";

let keySeq = 0;
function nextKey(prefix: string): string {
  keySeq += 1;
  return `${prefix}-rec-${String(keySeq).padStart(4, "0")}`;
}

const MK_REFS = {
  accountRef: "infisical://test/mk/ACCOUNT",
  channelRef: "infisical://test/mk/CHANNEL",
};

function mkPurchase(key: string): MkOperationInput {
  return {
    kind: "purchase",
    idempotencyKey: key,
    spendingLimitMinor: 5000,
    amountMinor: 1500,
    credentials: { ...MK_REFS },
    externalProductId: "app-001",
  };
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
  it("MK session-expired mid-call → UNKNOWN/VERIFYING, retry replays without a second effect", async () => {
    const external = new InMemorySimulatedMkExternal("session_expired");
    const adapter = new MkAtivadorSkeletonAdapter({ external });
    const key = nextKey("mk51");
    const first = await adapter.execute(mkPurchase(key));
    expect(first.outcome).toBe("UNKNOWN");
    expect(first.reconciliationState).toBe("VERIFYING");
    const effectsBefore = external.effectCount;
    const retry = await adapter.execute(mkPurchase(key));
    expect(retry.outcome).toBe("MANUAL");
    expect(external.effectCount).toBe(effectsBefore);
  });

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
  it("MK browser-disconnected mid-call → UNKNOWN/VERIFYING, no duplicate on retry", async () => {
    const external = new InMemorySimulatedMkExternal("browser_disconnected");
    const adapter = new MkAtivadorSkeletonAdapter({ external });
    const key = nextKey("mk51");
    const first = await adapter.execute(mkPurchase(key));
    expect(first.outcome).toBe("UNKNOWN");
    const effectsBefore = external.effectCount;
    await adapter.execute(mkPurchase(key));
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

describe("issue #51: restart-before-ack", () => {
  it("MK restart-before-ack → VERIFYING park; reconcile is read-only (no re-execution)", async () => {
    const external = new InMemorySimulatedMkExternal("unknown");
    const adapter = new MkAtivadorSkeletonAdapter({ external });
    const key = nextKey("mk51");
    const first = await adapter.execute(mkPurchase(key));
    expect(first.reconciliationState).toBe("VERIFYING");
    const sendsBefore = external.calls.length;
    const ledgerBefore = external.ledgerSize;
    const effectsBefore = external.effectCount;
    const read = await adapter.execute({
      kind: "readback",
      idempotencyKey: nextKey("mk51"),
      spendingLimitMinor: 5000,
      amountMinor: 0,
      credentials: { ...MK_REFS },
      subjectIdempotencyKey: key,
    });
    expect(read.simulated).toBe(true);
    expect(read.outcome).toBe("UNKNOWN");
    expect(read.reconciliationState).toBe("VERIFYING");
    expect(read.needsHuman).toBe(true);
    // Honest readback observes the SUBJECT entry only: no new external
    // call, no new ledger entry, no new effect.
    expect(external.calls.length).toBe(sendsBefore);
    expect(external.ledgerSize).toBe(ledgerBefore);
    expect(external.effectCount).toBe(effectsBefore);
  });
});

describe("issue #51: MK readback keyed by subject (read-only)", () => {
  function readbackOf(subjectKey: string): MkOperationInput {
    return {
      kind: "readback",
      idempotencyKey: nextKey("mk51"),
      spendingLimitMinor: 5000,
      amountMinor: 0,
      credentials: { ...MK_REFS },
      subjectIdempotencyKey: subjectKey,
    };
  }

  it("applied subject → SUCCESS/SUCCEEDED with zero new mutation", async () => {
    const external = new InMemorySimulatedMkExternal("success");
    const adapter = new MkAtivadorSkeletonAdapter({ external });
    const key = nextKey("mk51");
    const applied = await adapter.execute(mkPurchase(key));
    expect(applied.outcome).toBe("SUCCESS");
    const ledgerBefore = external.ledgerSize;
    const effectsBefore = external.effectCount;
    const callsBefore = external.calls.length;
    const read = await adapter.execute(readbackOf(key));
    expect(read.outcome).toBe("SUCCESS");
    expect(read.reconciliationState).toBe("SUCCEEDED");
    expect(read.needsHuman).toBe(false);
    expect(read.simulated).toBe(true);
    expect(external.calls.length).toBe(callsBefore);
    expect(external.ledgerSize).toBe(ledgerBefore);
    expect(external.effectCount).toBe(effectsBefore);
  });

  it("uncertain subject → UNKNOWN/VERIFYING with zero new mutation", async () => {
    const external = new InMemorySimulatedMkExternal("unknown");
    const adapter = new MkAtivadorSkeletonAdapter({ external });
    const key = nextKey("mk51");
    await adapter.execute(mkPurchase(key));
    const ledgerBefore = external.ledgerSize;
    const effectsBefore = external.effectCount;
    const callsBefore = external.calls.length;
    const read = await adapter.execute(readbackOf(key));
    expect(read.outcome).toBe("UNKNOWN");
    expect(read.reconciliationState).toBe("VERIFYING");
    expect(read.needsHuman).toBe(true);
    expect(external.calls.length).toBe(callsBefore);
    expect(external.ledgerSize).toBe(ledgerBefore);
    expect(external.effectCount).toBe(effectsBefore);
  });

  it("missing subject → MANUAL (inconclusive, operator must verify)", async () => {
    const external = new InMemorySimulatedMkExternal("success");
    const adapter = new MkAtivadorSkeletonAdapter({ external });
    const read = await adapter.execute(readbackOf(nextKey("mk51-ghost")));
    expect(read.outcome).toBe("MANUAL");
    expect(read.needsHuman).toBe(true);
    expect(read.simulated).toBe(true);
    expect(external.ledgerSize).toBe(0);
    expect(external.effectCount).toBe(0);
    expect(external.calls).toHaveLength(0);
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
  it("identical idempotency keys on both providers converge to one effect", async () => {
    const mkExternal = new InMemorySimulatedMkExternal("success");
    const mk = new MkAtivadorSkeletonAdapter({ external: mkExternal });
    const cvExternal = new InMemorySimulatedCinevisionWriteExternal("success");
    const cv = new CinevisionWriteSkeletonAdapter({ external: cvExternal });
    const mkKey = nextKey("mk51");
    const cvKey = nextKey("cv51");
    for (let i = 0; i < 3; i += 1) {
      await mk.execute(mkPurchase(mkKey));
      await cv.execute(cvWrite(cvKey));
    }
    expect(mkExternal.effectCount).toBe(1);
    expect(cvExternal.effectCount).toBe(1);
  });
});
