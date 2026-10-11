/**
 * MK Ativador SIMULATED-fixture tests (G07, credential-independent).
 *
 * No live provider actions: every external call runs against
 * `InMemorySimulatedMkExternal`. Deterministic fixtures only (counter-based
 * keys — no timestamp-UUID slicing).
 */

import { describe, expect, it } from "vitest";
import { MkAtivadorSkeletonAdapter } from "../../src/providers/mkativador/adapter.js";
import { InMemorySimulatedMkExternal } from "../../src/providers/mkativador/simulated.js";
import {
  isOverSpendingLimit,
  validateMkInput,
  type MkOperationInput,
} from "../../src/providers/mkativador/types.js";

let keySeq = 0;
function nextKey(prefix: string): string {
  keySeq += 1;
  return `${prefix}-key-${String(keySeq).padStart(4, "0")}`;
}

const REFS = {
  accountRef: "infisical://test/mk/ACCOUNT",
  channelRef: "infisical://test/mk/CHANNEL",
};

function purchaseInput(overrides: Partial<MkOperationInput> = {}): MkOperationInput {
  return {
    kind: "purchase",
    idempotencyKey: nextKey("mk"),
    spendingLimitMinor: 5000,
    amountMinor: 2000,
    credentials: { ...REFS },
    externalProductId: "app-001",
    ...overrides,
  } as MkOperationInput;
}

describe("MK credential seam (refs, never values)", () => {
  it("rejects raw values where a secret ref is required", () => {
    const bad = purchaseInput({
      credentials: { accountRef: "s3cr3t-value", channelRef: "other-value" },
    });
    expect(validateMkInput(bad)).toContain("secret ref");
  });

  it("rejects malformed idempotency keys", () => {
    expect(validateMkInput(purchaseInput({ idempotencyKey: "" }))).toContain("idempotencyKey");
    expect(validateMkInput(purchaseInput({ idempotencyKey: "has space" }))).toContain("idempotencyKey");
  });

  it("adapter parks malformed input as MANUAL with an audit entry, zero external calls", async () => {
    const external = new InMemorySimulatedMkExternal();
    const adapter = new MkAtivadorSkeletonAdapter({ external });
    const result = await adapter.execute(purchaseInput({ idempotencyKey: "bad key!" }));
    expect(result.outcome).toBe("MANUAL");
    expect(result.simulated).toBe(true);
    expect(result.needsHuman).toBe(true);
    expect(external.calls).toHaveLength(0);
    expect(adapter.audit).toHaveLength(1);
    expect(JSON.stringify(adapter.audit)).not.toContain("infisical://");
  });
});

describe("MK spending-limit + idempotency", () => {
  it("purchase above the operator cap parks MANUAL before any external call", async () => {
    const external = new InMemorySimulatedMkExternal();
    const adapter = new MkAtivadorSkeletonAdapter({ external });
    const input = purchaseInput({ amountMinor: 9000, spendingLimitMinor: 5000 });
    expect(isOverSpendingLimit(input)).toBe(true);
    const result = await adapter.execute(input);
    expect(result.outcome).toBe("MANUAL");
    expect(result.reconciliationState).toBe("MANUAL");
    expect(external.calls).toHaveLength(0);
  });

  it("reads never trip the spending gate", () => {
    expect(
      isOverSpendingLimit({
        kind: "balance.query",
        idempotencyKey: nextKey("mk"),
        spendingLimitMinor: 0,
        amountMinor: 0,
        credentials: { ...REFS },
      }),
    ).toBe(false);
  });

  it("duplicate replay performs a single externally-visible effect", async () => {
    const external = new InMemorySimulatedMkExternal("success");
    const adapter = new MkAtivadorSkeletonAdapter({ external });
    const key = nextKey("mk");
    const first = await adapter.execute(purchaseInput({ idempotencyKey: key }));
    const second = await adapter.execute(purchaseInput({ idempotencyKey: key }));
    expect(first.outcome).toBe("SUCCESS");
    expect(second.outcome).toBe("SUCCESS");
    expect(external.effectCount).toBe(1);
    expect(external.ledgerSize).toBe(1);
  });

  it("replay of an uncertain effect parks MANUAL for operator verification", async () => {
    const external = new InMemorySimulatedMkExternal("unknown");
    const adapter = new MkAtivadorSkeletonAdapter({ external });
    const key = nextKey("mk");
    const first = await adapter.execute(purchaseInput({ idempotencyKey: key }));
    expect(first.outcome).toBe("UNKNOWN");
    const second = await adapter.execute(purchaseInput({ idempotencyKey: key }));
    expect(second.outcome).toBe("MANUAL");
    expect(external.effectCount).toBe(0);
  });
});

describe("MK full operation surface (SIMULATED)", () => {
  it("covers auth seam, balance, product, purchase, activation and readback", async () => {
    const external = new InMemorySimulatedMkExternal("success");
    const adapter = new MkAtivadorSkeletonAdapter({ external });
    const kinds: MkOperationInput[] = [
      { kind: "auth.session", idempotencyKey: nextKey("mk"), spendingLimitMinor: 5000, amountMinor: 0, credentials: { ...REFS } },
      { kind: "balance.query", idempotencyKey: nextKey("mk"), spendingLimitMinor: 5000, amountMinor: 0, credentials: { ...REFS } },
      { kind: "product.query", idempotencyKey: nextKey("mk"), spendingLimitMinor: 5000, amountMinor: 0, credentials: { ...REFS }, externalProductId: "app-001" },
      purchaseInput({ idempotencyKey: nextKey("mk") }),
      { kind: "activation", idempotencyKey: nextKey("mk"), spendingLimitMinor: 5000, amountMinor: 0, credentials: { ...REFS }, purchaseRef: "pur-001", targetId: "AA-BB-CC-001" },
      { kind: "readback", idempotencyKey: nextKey("mk"), spendingLimitMinor: 5000, amountMinor: 0, credentials: { ...REFS }, subjectIdempotencyKey: "mk-subject-0001" },
    ];
    for (const input of kinds) {
      const result = await adapter.execute(input);
      expect(result.simulated).toBe(true);
      expect(["SUCCESS", "FAILURE", "UNKNOWN", "MANUAL"]).toContain(result.outcome);
    }
    expect(adapter.audit).toHaveLength(kinds.length);
  });

  it("UNKNOWN stays distinct from SUCCESS/FAILURE and forces human review", async () => {
    const external = new InMemorySimulatedMkExternal("timeout");
    const adapter = new MkAtivadorSkeletonAdapter({ external, timeoutMs: 5 });
    const result = await adapter.execute(purchaseInput());
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.outcome).not.toBe("SUCCESS");
    expect(result.outcome).not.toBe("FAILURE");
    expect(result.reconciliationState).toBe("VERIFYING");
    expect(result.needsHuman).toBe(true);
  });

  it("no-authz parks MANUAL (operator gate, no invented purchase)", async () => {
    const external = new InMemorySimulatedMkExternal("no_authz");
    const adapter = new MkAtivadorSkeletonAdapter({ external });
    const result = await adapter.execute(purchaseInput());
    expect(result.outcome).toBe("MANUAL");
    expect(result.needsHuman).toBe(true);
  });

  it("audit log never carries secret refs or values", async () => {
    const external = new InMemorySimulatedMkExternal("success");
    const adapter = new MkAtivadorSkeletonAdapter({ external });
    await adapter.execute(purchaseInput());
    const dumped = JSON.stringify({ audit: adapter.audit, calls: external.audit });
    expect(dumped).not.toContain("infisical://");
    expect(dumped).not.toContain("ACCOUNT");
  });
});
