/**
 * CINEVISION API seam tests (SIMULATED-only, no DB, no live calls).
 *
 * Covers: typed CINEVISION write port, fencing-token shape, idempotency
 * validation + operation/payload fingerprint conflicts, timeout→UNKNOWN,
 * negative tests (no authz, timeout, duplicate replay → single effect or
 * MANUAL), readback + reconcile behavior, and issue #51 recovery scenarios
 * at the port level.
 */

import { describe, expect, it } from "vitest";
import type { ProviderOperationRequest } from "../src/provider/provider-port.js";
import {
  buildSimulatedFencingToken,
  buildSimulatedWriteFingerprint,
  CinevisionSimulatedWritePort,
  classifySimulatedWriteTimeout,
  SimulatedWriteReadback,
  validateSimulatedWriteKey,
} from "../src/provider/provider-cinevision-simulated.js";

let keySeq = 0;
function nextKey(prefix: string): string {
  keySeq += 1;
  return `${prefix}-key-${String(keySeq).padStart(4, "0")}`;
}

function request(
  action: string,
  key: string,
  overrides: Partial<ProviderOperationRequest> = {},
): ProviderOperationRequest {
  return {
    tenantId: "tenant-sim-0001",
    providerAccountId: "account-sim-0001",
    action,
    entityType: "license",
    entityId: "entity-0001",
    idempotencyKey: key,
    payload: { plan_key: "annual" },
    correlationId: buildSimulatedFencingToken("provider-dispatcher-1"),
    ...overrides,
  };
}

describe("simulated write seam shape", () => {
  it("port requires a secret ref at the type level (future wiring must pass the gate)", () => {
    expect(new CinevisionSimulatedWritePort().requiresSecretRef).toBe(true);
  });

  it("every result carries the explicit simulated marker", async () => {
    const port = new CinevisionSimulatedWritePort();
    const result = await port.requestOperation(request("createTrial", nextKey("cv")));
    expect(result.simulated).toBe(true);
  });

  it("fencing tokens are unique per acquisition (same shape as dispatcher claim tokens)", () => {
    const tokens = new Set([
      buildSimulatedFencingToken("provider-dispatcher-1"),
      buildSimulatedFencingToken("provider-dispatcher-1"),
      buildSimulatedFencingToken("provider-dispatcher-1"),
    ]);
    expect(tokens.size).toBe(3);
  });

  it("idempotency keys are validated (token shape only)", () => {
    expect(validateSimulatedWriteKey(nextKey("cv"))).toBe(true);
    expect(validateSimulatedWriteKey("")).toBe(false);
    expect(validateSimulatedWriteKey("has space")).toBe(false);
    expect(validateSimulatedWriteKey(undefined)).toBe(false);
  });

  it("invalid keys park MANUAL with zero effects", async () => {
    const port = new CinevisionSimulatedWritePort();
    const result = await port.requestOperation(request("createTrial", "bad key!"));
    expect(result.outcome).toBe("MANUAL");
    expect(port.effectCount).toBe(0);
  });

  it("fingerprint binds the operation/payload identity (key-order independent)", () => {
    const a = request("createTrial", "fp-key-0001", { payload: { x: 1, y: 2 } });
    const b = request("createTrial", "fp-key-0001", { payload: { y: 2, x: 1 } });
    const c = request("createTrial", "fp-key-0001", { payload: { y: 2, x: 3 } });
    expect(buildSimulatedWriteFingerprint(a)).toBe(buildSimulatedWriteFingerprint(b));
    expect(buildSimulatedWriteFingerprint(a)).not.toBe(buildSimulatedWriteFingerprint(c));
  });
});

describe("simulated write negative tests", () => {
  it("no-authz parks MANUAL (operator gate)", async () => {
    const port = new CinevisionSimulatedWritePort("no_authz");
    const result = await port.requestOperation(request("createTrial", nextKey("cv")));
    expect(result.outcome).toBe("MANUAL");
    expect(port.effectCount).toBe(0);
  });

  it("timeout classifies to UNKNOWN, never FAILED", async () => {
    const port = new CinevisionSimulatedWritePort("timeout", 10);
    const result = await port.requestOperation(request("createTrial", nextKey("cv")));
    expect(result.outcome).toBe("UNKNOWN");
    expect(result).toEqual(classifySimulatedWriteTimeout("createTrial"));
  });

  it("duplicate replay yields a single effect", async () => {
    const port = new CinevisionSimulatedWritePort("success");
    const key = nextKey("cv");
    const first = await port.requestOperation(request("createTrial", key));
    const second = await port.requestOperation(request("createTrial", key));
    expect(first.outcome).toBe("SUCCEEDED");
    expect(second.outcome).toBe("SUCCEEDED");
    expect(port.effectCount).toBe(1);
    expect(port.ledgerSize).toBe(1);
  });

  it("key reuse with a divergent operation/payload parks MANUAL as conflict (no new effect, no overwrite)", async () => {
    const port = new CinevisionSimulatedWritePort("success");
    const key = nextKey("cv");
    const first = await port.requestOperation(request("createTrial", key));
    expect(first.outcome).toBe("SUCCEEDED");
    const conflict = await port.requestOperation(
      request("blockCustomer", key, { entityId: "entity-0002", payload: { reason: "abuse" } }),
    );
    expect(conflict.outcome).toBe("MANUAL");
    expect(conflict.simulated).toBe(true);
    expect(port.effectCount).toBe(1);
    expect(port.ledgerSize).toBe(1);
    // The original record survives: replaying the ORIGINAL operation still
    // converges to the recorded success, not the conflict.
    const replay = await port.requestOperation(request("createTrial", key));
    expect(replay.outcome).toBe("SUCCEEDED");
    expect(port.effectCount).toBe(1);
    expect(port.ledgerSize).toBe(1);
  });

  it("replay of an uncertain effect parks MANUAL", async () => {
    const port = new CinevisionSimulatedWritePort("unknown");
    const key = nextKey("cv");
    const first = await port.requestOperation(request("createTrial", key));
    expect(first.outcome).toBe("UNKNOWN");
    const second = await port.requestOperation(request("createTrial", key));
    expect(second.outcome).toBe("MANUAL");
    expect(port.effectCount).toBe(0);
  });

  it("audit entries never carry secret material", async () => {
    const port = new CinevisionSimulatedWritePort();
    await port.requestOperation(request("createTrial", nextKey("cv")));
    const dumped = JSON.stringify(port.audit);
    expect(dumped).not.toContain("infisical://");
    expect(port.audit[0]?.simulated).toBe(true);
  });
});

describe("simulated write readback (never re-executes)", () => {
  it("APPLIED / NOT_APPLIED are conclusive; unset is INCONCLUSIVE", async () => {
    const readback = new SimulatedWriteReadback();
    const inconclusive = await readback.verify({
      tenantId: "t",
      operationId: "op-1",
      action: "createTrial",
      externalRef: null,
    });
    expect(inconclusive.conclusive).toBe(false);
    readback.markApplied("op-1");
    const applied = await readback.verify({
      tenantId: "t",
      operationId: "op-1",
      action: "createTrial",
      externalRef: null,
    });
    expect(applied).toMatchObject({ effectApplied: true, conclusive: true });
  });
});

describe("issue #51 recovery scenarios at the port level (SIMULATED)", () => {
  it("session-expired → UNKNOWN/VERIFYING; retry replays without a second effect", async () => {
    const port = new CinevisionSimulatedWritePort("unknown");
    const key = nextKey("cv51");
    const first = await port.requestOperation(request("createTrial", key));
    expect(first.outcome).toBe("UNKNOWN");
    const effectsBefore = port.effectCount;
    const retry = await port.requestOperation(request("createTrial", key));
    expect(retry.outcome).toBe("MANUAL");
    expect(port.effectCount).toBe(effectsBefore);
    // LIVE_NEEDED: real session re-auth + lease reclaim need live/operator.
  });

  it("crash-after-effect shape: SUCCESS recorded once; retries converge to one effect", async () => {
    const port = new CinevisionSimulatedWritePort("success");
    const key = nextKey("cv51");
    for (let i = 0; i < 3; i += 1) {
      await port.requestOperation(request("createTrial", key));
    }
    expect(port.effectCount).toBe(1);
    // LIVE_NEEDED: real crash-restart reclaim runs in `recoverOnce` on PG.
  });

  it("timed-out send parks UNKNOWN; retry parks MANUAL for verification (same-instance state model, not a restart proof)", async () => {
    const port = new CinevisionSimulatedWritePort("timeout", 10);
    const key = nextKey("cv51");
    const first = await port.requestOperation(request("createTrial", key));
    expect(first.outcome).toBe("UNKNOWN");
    // The key is reserved BEFORE the send: the ledger preserves the
    // uncertain state even though the ack never arrived.
    expect(port.ledgerSize).toBe(1);
    expect(port.effectCount).toBe(0);
    // Even after the provider recovers, retrying the same key must park
    // for verification — never re-execute the send.
    port.setBehavior("success");
    const effectsBefore = port.effectCount;
    const retry = await port.requestOperation(request("createTrial", key));
    expect(retry.outcome).toBe("MANUAL");
    expect(port.effectCount).toBe(effectsBefore);
    expect(port.ledgerSize).toBe(1);
    // LIVE_NEEDED: a real restart-before-ack recovery (new process reclaiming
    // the key) needs the DB dispatcher; this models the ledger state only.
  });

  it("replay/duplication on the CINEVISION port converges to one effect", async () => {
    const cv = new CinevisionSimulatedWritePort("success");
    const cvKey = nextKey("cv51");
    for (let i = 0; i < 3; i += 1) {
      await cv.requestOperation(request("createTrial", cvKey));
    }
    expect(cv.effectCount).toBe(1);
    expect(cv.ledgerSize).toBe(1);
  });
});
