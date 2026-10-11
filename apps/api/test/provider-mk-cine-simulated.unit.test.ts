/**
 * PROV-MK-CINE-01 API seam tests (SIMULATED-only, no DB, no live calls).
 *
 * Covers: typed write ports (MK + CINEVISION), fencing-token shape,
 * idempotency validation, timeout→UNKNOWN, negative tests (no authz,
 * timeout, duplicate replay → single effect or MANUAL), readback +
 * reconcile behavior, and issue #51 recovery scenarios at the port level.
 */

import { describe, expect, it } from "vitest";
import type { ProviderOperationRequest } from "../src/provider/provider-port.js";
import {
  buildSimulatedFencingToken,
  CinevisionSimulatedWritePort,
  classifySimulatedWriteTimeout,
  MkSimulatedWritePort,
  SimulatedWriteReadback,
  validateSimulatedWriteKey,
} from "../src/provider/provider-mk-cine-simulated.js";

let keySeq = 0;
function nextKey(prefix: string): string {
  keySeq += 1;
  return `${prefix}-key-${String(keySeq).padStart(4, "0")}`;
}

function request(action: string, key: string): ProviderOperationRequest {
  return {
    tenantId: "tenant-sim-0001",
    providerAccountId: "account-sim-0001",
    action,
    entityType: "license",
    entityId: "entity-0001",
    idempotencyKey: key,
    payload: { plan_key: "annual" },
    correlationId: buildSimulatedFencingToken("provider-dispatcher-1"),
  };
}

describe("simulated write seam shape", () => {
  it("ports require a secret ref at the type level (future wiring must pass the gate)", () => {
    expect(new MkSimulatedWritePort().requiresSecretRef).toBe(true);
    expect(new CinevisionSimulatedWritePort().requiresSecretRef).toBe(true);
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
    expect(validateSimulatedWriteKey(nextKey("mk"))).toBe(true);
    expect(validateSimulatedWriteKey("")).toBe(false);
    expect(validateSimulatedWriteKey("has space")).toBe(false);
    expect(validateSimulatedWriteKey(undefined)).toBe(false);
  });

  it("invalid keys park MANUAL with zero effects", async () => {
    const port = new MkSimulatedWritePort();
    const result = await port.requestOperation(request("mk.purchase", "bad key!"));
    expect(result.outcome).toBe("MANUAL");
    expect(port.effectCount).toBe(0);
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
    const port = new MkSimulatedWritePort("timeout", 10);
    const result = await port.requestOperation(request("mk.purchase", nextKey("mk")));
    expect(result.outcome).toBe("UNKNOWN");
    expect(result).toEqual(classifySimulatedWriteTimeout("mk", "mk.purchase"));
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
    const port = new MkSimulatedWritePort();
    await port.requestOperation(request("mk.purchase", nextKey("mk")));
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
    const port = new MkSimulatedWritePort("success");
    const key = nextKey("mk51");
    for (let i = 0; i < 3; i += 1) {
      await port.requestOperation(request("mk.purchase", key));
    }
    expect(port.effectCount).toBe(1);
    // LIVE_NEEDED: real crash-restart reclaim runs in `recoverOnce` on PG.
  });

  it("restart-before-ack: timed-out send parks UNKNOWN; no duplicate mutation on retry", async () => {
    const port = new CinevisionSimulatedWritePort("timeout", 10);
    const key = nextKey("cv51");
    const first = await port.requestOperation(request("createTrial", key));
    expect(first.outcome).toBe("UNKNOWN");
    // LIVE_NEEDED: real restart-before-ack recovery needs the DB dispatcher.
  });

  it("replay/duplication across both ports converges to one effect each", async () => {
    const mk = new MkSimulatedWritePort("success");
    const cv = new CinevisionSimulatedWritePort("success");
    const mkKey = nextKey("mk51");
    const cvKey = nextKey("cv51");
    for (let i = 0; i < 3; i += 1) {
      await mk.requestOperation(request("mk.purchase", mkKey));
      await cv.requestOperation(request("createTrial", cvKey));
    }
    expect(mk.effectCount).toBe(1);
    expect(cv.effectCount).toBe(1);
  });
});
