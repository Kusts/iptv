import { beforeEach, describe, expect, it } from "vitest";
import type { CommandActor } from "@iptv/domain";
import { CommandBus, type CommandHandlerContext } from "../src/commands/command-bus.js";
import { registerCrmCommands } from "../src/crm/crm.commands.js";
import { registerHumanReviewCommands } from "../src/human-review/human-review.commands.js";
import { registerPolicyCommands } from "../src/policy/policy.commands.js";
import { registerTrialCommands } from "../src/trial/trial.commands.js";
import { registerProviderCommands, applySecretPortOutcome } from "../src/provider/provider.commands.js";
import {
  genericReadbackTimeoutMsFromEnv,
  providerDispatchLeaseMsFromEnv,
  providerDispatchModeFromEnv,
  providerDispatchTimeoutMsFromEnv,
  raceGenericReadback,
  type AdapterResult,
  type ProviderOperationRequest,
  type ProviderOpsPort,
  type ProviderReadbackPort,
} from "../src/provider/provider-port.js";
import {
  buildClaimToken,
  classifyDispatchProvenance,
  decideDispatchRecovery,
  isDispatchCapabilityBlocked,
  isSecretRequiredProvenance,
  racePortCall,
  stripDispatchMetadata,
} from "../src/provider/provider-dispatcher.service.js";
import {
  buildDispatchPortPayload,
  buildSubscriptionProvisionExternalPayload,
  buildTrialProvisionExternalPayload,
  TRIAL_CAPABILITY_KEY,
} from "../src/provider/provider-secret-gate.js";
import { trialMemoryOf } from "../src/trial/trial-store.js";
import { raceTrialReadback, trialReadbackTimeoutMsFromEnv } from "../src/trial/trial-readback.js";
import { MemoryDb } from "./fakes/memory-fakes.js";
import { FakeTrialReadback } from "./fakes/trial-readback-fake.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const VALID_REF = "infisical://production/BROWSER_WORKER_KEY";

const PERMISSIONS = ["trial.write", "provider.operation.write", "crm.person.read", "crm.lead.write"];

function actor(): CommandActor {
  return {
    userId: "22222222-2222-4222-8222-222222222222",
    isPlatformAdmin: false,
    tenantId: TENANT,
    roleKeys: ["tenant_owner"],
    permissions: PERMISSIONS,
    actorType: "human",
  };
}

/** Future BROWSER-shaped port (test-only): requires a secret, never a value. */
class FakeBrowserPort implements ProviderOpsPort {
  readonly name = "browser";
  readonly requiresSecretRef = true;
  readonly calls: ProviderOperationRequest[] = [];

  constructor(private readonly outcome: AdapterResult = { outcome: "MANUAL", detail: "browser: parked", externalRef: null }) {}

  async requestOperation(input: ProviderOperationRequest): Promise<AdapterResult> {
    this.calls.push(input);
    return this.outcome;
  }
}

const CONFIGURED_SECRETS_PORT = {
  name: "infisical-test",
  async getSecret(): Promise<string> {
    throw new Error("must never be called by the API gate");
  },
};

function dumped(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function probeTrialMemory(db: MemoryDb) {
  const ctx = {
    tx: db.txFor(TENANT),
    tenantId: TENANT,
    actor: actor(),
    commandId: "33333333-3333-4333-8333-333333333333",
    correlationId: "44444444-4444-4444-8444-444444444444",
    causationId: null,
  } as unknown as CommandHandlerContext;
  const mem = trialMemoryOf(ctx);
  if (mem === null) throw new Error("no trial memory available");
  return { mem, ctx };
}

function seedTrialAccount(db: MemoryDb): void {
  const { mem } = probeTrialMemory(db);
  const providerId = "c9c9c9c9-c9c9-4c9c-8c9c-c9c9c9c9c9c9";
  if (!mem.providers.has(providerId)) {
    mem.providers.set(providerId, { id: providerId, providerKey: "cinevision", name: "CINEVISION" });
  }
  const accountId = "a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a9";
  if (!mem.providerAccounts.has(accountId)) {
    mem.providerAccounts.set(accountId, {
      id: accountId,
      tenantId: TENANT,
      providerId,
      name: "seeded trial account",
      secretRef: "wave4://no-real-credential",
    });
  }
}

/**
 * FASE5-S4S5 arrange: the suite-private AVAILABLE flip of the per-action
 * trial gate row plus the designation of the seeded disposable account.
 * MemoryDb is per-test (never a shared global row); the deps carry the
 * designation so no test touches `process.env`.
 */
const TRIAL_DISPOSABLE_ACCOUNT_ID = "a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a9";

function markTrialGateAvailable(db: MemoryDb) {
  db.txFor(TENANT).capabilities.set(TRIAL_CAPABILITY_KEY, {
    key: TRIAL_CAPABILITY_KEY,
    ownerContext: "provider",
    availability: "AVAILABLE",
    certificationStatus: "CERTIFIED",
    riskLevel: "HIGH",
    mvpPhase: "W0",
    manualEquivalent: "manual",
    policyFamily: "provider-integration",
    degradation: "suite-private AVAILABLE (FASE5-S4S5 arrange, never the shared row)",
    permissions: [],
  });
}

function secretBus(browser: FakeBrowserPort): { db: MemoryDb; bus: CommandBus } {
  const db = new MemoryDb();
  seedTrialAccount(db);
  markTrialGateAvailable(db);
  const bus = new CommandBus(db);
  registerHumanReviewCommands(bus);
  registerPolicyCommands(bus);
  registerCrmCommands(bus);
  // FASE5-S6: SUCCEEDED on the secret path gates on a conclusive
  // readback — the suite default satisfies it.
  const trialReadbackPort = new FakeTrialReadback();
  registerTrialCommands(bus, {
    opsPort: browser,
    secretsPort: CONFIGURED_SECRETS_PORT,
    loadSecretRef: async () => VALID_REF,
    trialDisposableAccountId: TRIAL_DISPOSABLE_ACCOUNT_ID,
    trialReadbackPort,
  });
  registerProviderCommands(bus, {
    opsPort: browser,
    secretsPort: CONFIGURED_SECRETS_PORT,
    loadSecretRef: async () => VALID_REF,
    trialDisposableAccountId: TRIAL_DISPOSABLE_ACCOUNT_ID,
    trialReadbackPort,
  });
  return { db, bus };
}

async function requestEligibleTrial(bus: CommandBus, canonicalName: string): Promise<string> {
  const personRes = await bus.execute<{ id: string }>(actor(), "person.register", { canonicalName });
  expect(personRes.ok).toBe(true);
  if (!personRes.ok) throw new Error("person setup failed");
  const trialRes = await bus.execute<{ id: string | null; status: string }>(actor(), "trial.request", {
    personId: personRes.data.id,
    durationMinutes: 60,
  });
  expect(trialRes.ok).toBe(true);
  if (!trialRes.ok || trialRes.data.id === null) throw new Error("trial setup failed");
  return trialRes.data.id;
}

async function requestSecret(
  bus: CommandBus,
  idempotencyKey: string,
): Promise<{ id: string; status: string; effectCertainty: string; trialId: string }> {
  // SPEC §25: `trial.provision` requires a real REQUESTED trial with a
  // persisted ALLOW — a synthetic entity id is refused before the port.
  const trialId = await requestEligibleTrial(bus, `Dispatch ${idempotencyKey}`);
  const result = await bus.execute<{ id: string; status: string; effectCertainty: string }>(
    actor(),
    "provider.request_operation",
    {
      action: "trial.provision",
      entityType: "trial",
      entityId: trialId,
      idempotencyKey,
      payload: { duration_minutes: 60 },
    },
  );
  if (!result.ok) throw new Error(`expected ok, got ${dumped(result)}`);
  return { ...result.data, trialId };
}

beforeEach(() => {
  delete process.env["PROVIDER_DISPATCH_MODE"];
  delete process.env["PROVIDER_DISPATCH_TIMEOUT_MS"];
  delete process.env["PROVIDER_DISPATCH_LEASE_MS"];
  delete process.env["PROVIDER_TRIAL_READBACK_TIMEOUT_MS"];
});

describe("CV-DSP-01 dispatch mode flag (pure)", () => {
  it("defaults to inline; only the exact 'durable' value enables durable", () => {
    expect(providerDispatchModeFromEnv({} as NodeJS.ProcessEnv)).toBe("inline");
    expect(providerDispatchModeFromEnv({ PROVIDER_DISPATCH_MODE: "" } as unknown as NodeJS.ProcessEnv)).toBe("inline");
    expect(providerDispatchModeFromEnv({ PROVIDER_DISPATCH_MODE: "DURABLE" } as unknown as NodeJS.ProcessEnv)).toBe("inline");
    expect(providerDispatchModeFromEnv({ PROVIDER_DISPATCH_MODE: "durable" } as unknown as NodeJS.ProcessEnv)).toBe("durable");
  });

  it("timeout falls back to 30000 and clamps garbage", () => {
    expect(providerDispatchTimeoutMsFromEnv({} as NodeJS.ProcessEnv)).toBe(30_000);
    expect(providerDispatchTimeoutMsFromEnv({ PROVIDER_DISPATCH_TIMEOUT_MS: "nope" } as unknown as NodeJS.ProcessEnv)).toBe(30_000);
    expect(providerDispatchTimeoutMsFromEnv({ PROVIDER_DISPATCH_TIMEOUT_MS: "5000" } as unknown as NodeJS.ProcessEnv)).toBe(5000);
    expect(providerDispatchTimeoutMsFromEnv({ PROVIDER_DISPATCH_TIMEOUT_MS: "9999999" } as unknown as NodeJS.ProcessEnv)).toBe(300_000);
  });

  it("lease falls back to 300000 and clamps garbage", () => {
    expect(providerDispatchLeaseMsFromEnv({} as NodeJS.ProcessEnv)).toBe(300_000);
    expect(providerDispatchLeaseMsFromEnv({ PROVIDER_DISPATCH_LEASE_MS: "0" } as unknown as NodeJS.ProcessEnv)).toBe(300_000);
    expect(providerDispatchLeaseMsFromEnv({ PROVIDER_DISPATCH_LEASE_MS: "60000" } as unknown as NodeJS.ProcessEnv)).toBe(60_000);
  });
});

describe("CV-DSP-01 recovery decision matrix (pure)", () => {
  const cases: Array<{
    name: string;
    status: string;
    leaseExpired: boolean;
    dispatchStarted: boolean;
    expected: "release_to_requested" | "park_verifying" | "none";
  }> = [
    { name: "QUEUED pre-send expired → release", status: "QUEUED", leaseExpired: true, dispatchStarted: false, expected: "release_to_requested" },
    { name: "RUNNING pre-send expired → release", status: "RUNNING", leaseExpired: true, dispatchStarted: false, expected: "release_to_requested" },
    { name: "QUEUED post-send expired → verify", status: "QUEUED", leaseExpired: true, dispatchStarted: true, expected: "park_verifying" },
    { name: "RUNNING post-send expired → verify", status: "RUNNING", leaseExpired: true, dispatchStarted: true, expected: "park_verifying" },
    { name: "QUEUED live lease → untouched", status: "QUEUED", leaseExpired: false, dispatchStarted: false, expected: "none" },
    { name: "RUNNING live lease → untouched", status: "RUNNING", leaseExpired: false, dispatchStarted: true, expected: "none" },
    { name: "VERIFYING expired → untouched (reconcile owns it)", status: "VERIFYING", leaseExpired: true, dispatchStarted: true, expected: "none" },
    { name: "SUCCEEDED expired → untouched", status: "SUCCEEDED", leaseExpired: true, dispatchStarted: true, expected: "none" },
    { name: "REQUESTED expired → untouched (never leased)", status: "REQUESTED", leaseExpired: true, dispatchStarted: false, expected: "none" },
  ];
  for (const tc of cases) {
    it(tc.name, () => {
      expect(
        decideDispatchRecovery({ status: tc.status, leaseExpired: tc.leaseExpired, dispatchStarted: tc.dispatchStarted }),
      ).toBe(tc.expected);
    });
  }
});

describe("CV-DSP-01 bounded port call (pure)", () => {
  it("passes results through", async () => {
    const port: ProviderOpsPort = {
      name: "echo",
      requestOperation: async () => ({ outcome: "SUCCEEDED", detail: "ok", externalRef: null }),
    };
    const call = await racePortCall(
      port,
      {
        tenantId: TENANT,
        providerAccountId: "a",
        action: "trial.provision",
        entityType: "trial",
        entityId: "e",
        idempotencyKey: "k",
        payload: {},
        correlationId: "c",
      },
      1000,
    );
    expect(call).toEqual({ kind: "result", result: { outcome: "SUCCEEDED", detail: "ok", externalRef: null } });
  });

  it("maps a hanging port to timeout (the dispatcher parks VERIFYING/UNKNOWN)", async () => {
    const port: ProviderOpsPort = {
      name: "browser",
      requiresSecretRef: true,
      requestOperation: () => new Promise<AdapterResult>(() => undefined),
    };
    const call = await racePortCall(
      port,
      {
        tenantId: TENANT,
        providerAccountId: "a",
        action: "trial.provision",
        entityType: "trial",
        entityId: "e",
        idempotencyKey: "k",
        payload: {},
        correlationId: "c",
      },
      10,
    );
    expect(call).toEqual({ kind: "timeout" });
  });

  it("maps a throwing port to threw (the dispatcher parks VERIFYING/UNKNOWN)", async () => {
    const port: ProviderOpsPort = {
      name: "browser",
      requiresSecretRef: true,
      requestOperation: async () => {
        throw new Error("post-effect boom");
      },
    };
    const call = await racePortCall(
      port,
      {
        tenantId: TENANT,
        providerAccountId: "a",
        action: "trial.provision",
        entityType: "trial",
        entityId: "e",
        idempotencyKey: "k",
        payload: {},
        correlationId: "c",
      },
      1000,
    );
    expect(call).toEqual({ kind: "threw" });
  });
});

describe("FASE5-S6-FIX2 bounded trial readback (SPEC §35, pure)", () => {
  const query = {
    tenantId: TENANT,
    operationId: "op-1",
    trialId: "trial-1",
    providerAccountId: "a",
    externalRef: "ext-1",
  };

  it("budget falls back to 30000 and clamps garbage (same shape as the port-call budget)", () => {
    expect(trialReadbackTimeoutMsFromEnv({} as NodeJS.ProcessEnv)).toBe(30_000);
    expect(trialReadbackTimeoutMsFromEnv({ PROVIDER_TRIAL_READBACK_TIMEOUT_MS: "nope" } as unknown as NodeJS.ProcessEnv)).toBe(
      30_000,
    );
    expect(trialReadbackTimeoutMsFromEnv({ PROVIDER_TRIAL_READBACK_TIMEOUT_MS: "0" } as unknown as NodeJS.ProcessEnv)).toBe(
      30_000,
    );
    expect(trialReadbackTimeoutMsFromEnv({ PROVIDER_TRIAL_READBACK_TIMEOUT_MS: "5000" } as unknown as NodeJS.ProcessEnv)).toBe(
      5000,
    );
    expect(
      trialReadbackTimeoutMsFromEnv({ PROVIDER_TRIAL_READBACK_TIMEOUT_MS: "9999999" } as unknown as NodeJS.ProcessEnv),
    ).toBe(300_000);
  });

  it("passes conclusive snapshots through before the budget", async () => {
    const readback = new FakeTrialReadback();
    const result = await raceTrialReadback(readback, { ...query, trialId: "t-12345678" }, 1000);
    expect(result?.conclusive).toBe(true);
    expect(readback.queries).toHaveLength(1);
  });

  it("maps a hanging readback to null (dispatcher parks VERIFYING/UNKNOWN, never FAILED, never a re-send)", async () => {
    const hanging = { readTrialCustomer: () => new Promise<never>(() => undefined) };
    const result = await raceTrialReadback(hanging, query, 10);
    expect(result).toBeNull();
  });

  it("maps a throwing readback to null (never propagates, never a re-send)", async () => {
    const failing = {
      readTrialCustomer: async (): Promise<never> => {
        throw new Error("readback transport boom");
      },
    };
    const result = await raceTrialReadback(failing, query, 1000);
    expect(result).toBeNull();
  });
});

describe("FASE5-FIX5 bounded generic readback (SPEC §35, pure)", () => {
  const query = {
    tenantId: TENANT,
    operationId: "op-1",
    action: "trial.provision",
    externalRef: null,
    adapter: "browser",
    adapterVersion: "secret-required-v1",
  };

  it("budget falls back to 30000 and clamps garbage (same shape as the sibling budgets)", () => {
    expect(genericReadbackTimeoutMsFromEnv({} as NodeJS.ProcessEnv)).toBe(30_000);
    expect(
      genericReadbackTimeoutMsFromEnv({ PROVIDER_GENERIC_READBACK_TIMEOUT_MS: "nope" } as unknown as NodeJS.ProcessEnv),
    ).toBe(30_000);
    expect(
      genericReadbackTimeoutMsFromEnv({ PROVIDER_GENERIC_READBACK_TIMEOUT_MS: "0" } as unknown as NodeJS.ProcessEnv),
    ).toBe(30_000);
    expect(
      genericReadbackTimeoutMsFromEnv({ PROVIDER_GENERIC_READBACK_TIMEOUT_MS: "5000" } as unknown as NodeJS.ProcessEnv),
    ).toBe(5000);
    expect(
      genericReadbackTimeoutMsFromEnv({ PROVIDER_GENERIC_READBACK_TIMEOUT_MS: "9999999" } as unknown as NodeJS.ProcessEnv),
    ).toBe(300_000);
  });

  it("passes conclusive answers through before the budget", async () => {
    const readback: ProviderReadbackPort = {
      async verify() {
        return { effectApplied: true, evidence: "test:conclusive", conclusive: true };
      },
    };
    const result = await raceGenericReadback(readback, query, 1000);
    expect(result).toMatchObject({ effectApplied: true, conclusive: true });
  });

  it("maps a hanging verify to null (never wedges the caller)", async () => {
    const hanging: ProviderReadbackPort = {
      verify: () => new Promise<never>(() => undefined),
    };
    const result = await raceGenericReadback(hanging, query, 10);
    expect(result).toBeNull();
  });

  it("maps a throwing verify to null (never propagates)", async () => {
    const failing: ProviderReadbackPort = {
      async verify(): Promise<never> {
        throw new Error("generic readback boom");
      },
    };
    const result = await raceGenericReadback(failing, query, 1000);
    expect(result).toBeNull();
  });
});

describe("CV-DSP-01 secret trial.provision queues without executing (FASE5-S6-FIX2 SPEC §41)", () => {
  it("inline and durable share the queue-only contract: zero port calls in-transaction", async () => {
    const browser = new FakeBrowserPort();
    const { db, bus } = secretBus(browser);
    const data = await requestSecret(bus, "inline-default-1");
    // FASE5-S6-FIX2: the secret-required `trial.provision` NEVER executes
    // inline — the REQUESTED row is the committed intent for the durable
    // dispatcher (parity with the durable cut by construction).
    expect(data.status).toBe("QUEUED");
    expect(data.effectCertainty).toBe("UNKNOWN");
    expect(browser.calls).toHaveLength(0);
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("provider.operation_requested.v1");
    expect(probeTrialMemory(db).mem.providerOperations.get(data.id)?.status).toBe("REQUESTED");
  });

  it("durable returns QUEUED/UNKNOWN with zero external effect", async () => {
    process.env["PROVIDER_DISPATCH_MODE"] = "durable";
    try {
      const browser = new FakeBrowserPort();
      const { db, bus } = secretBus(browser);
      const data = await requestSecret(bus, "durable-cut-1");
      expect(data.status).toBe("QUEUED");
      expect(data.effectCertainty).toBe("UNKNOWN");
      expect(browser.calls).toHaveLength(0);

      const tx = db.txFor(TENANT);
      const types = tx.events.map((e) => e.event_type);
      // The eligible-trial arrange emits its own request events; the
      // provider entry itself emits exactly one provider event.
      expect(types).toContain("provider.operation_requested.v1");
      expect(types.filter((t) => t.startsWith("provider."))).toEqual(["provider.operation_requested.v1"]);
      const { mem } = probeTrialMemory(db);
      const op = mem.providerOperations.get(data.id);
      expect(op?.status).toBe("REQUESTED");
      expect(op?.effectCertainty).toBe("UNKNOWN");
      expect(op?.completedAt).toBeNull();
      expect(mem.providerAttempts.filter((a) => a.operationId === data.id)).toHaveLength(0);
      expect(dumped({ events: tx.events, audits: tx.audits, op })).not.toContain("infisical://");
    } finally {
      delete process.env["PROVIDER_DISPATCH_MODE"];
    }
  });
});

describe("CV-DSP-01 shared outcome applier (one source of truth)", () => {
  async function setupOp(): Promise<{ db: MemoryDb; operationId: string; trialId: string; ctx: CommandHandlerContext }> {
    const browser = new FakeBrowserPort();
    const { db, bus } = secretBus(browser);
    const data = await requestSecret(bus, `shared-outcome-${Math.random().toString(36).slice(2)}`);
    const { ctx } = probeTrialMemory(db);
    return { db, operationId: data.id, trialId: data.trialId, ctx };
  }

  it("SUCCEEDED with a valid ref terminalizes with safe evidence", async () => {
    const { db, operationId, trialId, ctx } = await setupOp();
    // FASE5-S6 (§30): the binding path requires the trial to hold
    // PROVISIONING (the dispatcher-claimed row state). The provider entry
    // above leaves the trial REQUESTED, so park it explicitly — the same
    // precondition the trial-entry tests arrange via begin_provisioning.
    probeTrialMemory(db).mem.trials.get(trialId)!.lifecycleStatus = "PROVISIONING";
    const applied = await applySecretPortOutcome(ctx, {
      operationId,
      action: "trial.provision",
      entityType: "trial",
      entityId: trialId,
      raw: { outcome: "SUCCEEDED", detail: "raw must never persist", externalRef: "ext-123" },
      // FASE5-S6: SUCCEEDED alone no longer terminates — the conclusive
      // readback carries the postcondition proof.
      trialReadback: {
        conclusive: true,
        customer: {
          exists: true,
          externalId: "ext-123",
          isTrial: "1",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        evidence: "test:conclusive",
      },
    });
    expect(applied).toEqual({ status: "SUCCEEDED", effectCertainty: "KNOWN_APPLIED" });
    const { mem } = probeTrialMemory(db);
    const op = mem.providerOperations.get(operationId);
    expect(op?.resultSummary).toEqual({ external_ref: "ext-123", readback: "conclusive", postcondition: "satisfied" });
    expect(dumped({ op, events: db.txFor(TENANT).events })).not.toContain("raw must never persist");
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("provider.operation_succeeded.v1");
    // FASE5-S6 (§30): the stable binding is recorded for the trial.
    expect(mem.providerBindings).toHaveLength(1);
    expect(mem.providerBindings[0]).toMatchObject({ entityType: "trial", entityId: trialId, externalId: "ext-123" });
  });

  it("SUCCEEDED with an invalid ref demotes to VERIFYING (ambiguous effect retained)", async () => {
    const { operationId, trialId, ctx } = await setupOp();
    const applied = await applySecretPortOutcome(ctx, {
      operationId,
      action: "trial.provision",
      entityType: "trial",
      entityId: trialId,
      raw: { outcome: "SUCCEEDED", detail: "x", externalRef: "infisical://production/LEAK" },
    });
    expect(applied).toEqual({ status: "VERIFYING", effectCertainty: "UNKNOWN" });
  });

  it("FAILED maps to KNOWN_NOT_APPLIED with the failed event", async () => {
    const { db, operationId, trialId, ctx } = await setupOp();
    const applied = await applySecretPortOutcome(ctx, {
      operationId,
      action: "trial.provision",
      entityType: "trial",
      entityId: trialId,
      raw: { outcome: "FAILED", detail: "raw failure text", externalRef: null },
    });
    expect(applied).toEqual({ status: "FAILED", effectCertainty: "KNOWN_NOT_APPLIED" });
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("provider.operation_failed.v1");
  });

  it("UNKNOWN parks VERIFYING and MANUAL parks HUMAN_REQUIRED, both UNKNOWN certainty", async () => {
    const first = await setupOp();
    expect(
      await applySecretPortOutcome(first.ctx, {
        operationId: first.operationId,
        action: "trial.provision",
        entityType: "trial",
        entityId: first.trialId,
        raw: { outcome: "UNKNOWN", detail: "x", externalRef: null },
      }),
    ).toEqual({ status: "VERIFYING", effectCertainty: "UNKNOWN" });

    const second = await setupOp();
    expect(
      await applySecretPortOutcome(second.ctx, {
        operationId: second.operationId,
        action: "trial.provision",
        entityType: "trial",
        entityId: second.trialId,
        raw: { outcome: "MANUAL", detail: "x", externalRef: null },
      }),
    ).toEqual({ status: "HUMAN_REQUIRED", effectCertainty: "UNKNOWN" });
  });

  it("stripDispatchMetadata drops dispatcher bookkeeping before the port call", () => {
    expect(stripDispatchMetadata({ adapter: "browser", capability: "x", duration_minutes: 60 })).toEqual({
      duration_minutes: 60,
    });
  });
});

describe("CV-DSP-02-FIX F1 shared port-payload projection (pure)", () => {
  it("trial.provision keeps certified fields and drops trial_kind + bookkeeping", () => {
    expect(
      buildDispatchPortPayload("trial.provision", {
        duration_minutes: 60,
        adult_content_enabled: false,
        trial_kind: "TRIAL",
        adapter: "browser",
        capability: "AVAILABLE (test)",
      }),
    ).toEqual({ duration_minutes: 60, adult_content_enabled: false });
  });

  it("subscription.provision keeps certified fields and drops customer_id + bookkeeping", () => {
    expect(
      buildDispatchPortPayload("subscription.provision", {
        plan_id: "plan-1",
        plan_key: "monthly",
        customer_id: "cust-1",
        adapter: "browser",
        capability: "AVAILABLE (test)",
      }),
    ).toEqual({ plan_id: "plan-1", plan_key: "monthly" });
  });

  it("unknown actions keep the legacy secret-strip (owning context)", () => {
    expect(buildDispatchPortPayload("provider.anything", { foo: 1, adapter: "browser", capability: "x" })).toEqual({
      foo: 1,
    });
    expect(buildDispatchPortPayload("provider.anything", { foo: 1, secret_ref: "leak" })).toEqual({ foo: 1 });
  });

  it("builders project only certified fields", () => {
    expect(buildTrialProvisionExternalPayload({ duration_minutes: 60, adult_content_enabled: true })).toEqual({
      duration_minutes: 60,
      adult_content_enabled: true,
    });
    expect(buildSubscriptionProvisionExternalPayload({ plan_id: "p", plan_key: "k" })).toEqual({
      plan_id: "p",
      plan_key: "k",
    });
  });
});

describe("CV-DSP-01-FIX D1 claim tokens (pure)", () => {
  it("builds worker:uuid tokens unique per acquisition", () => {
    const base = "provider-dispatcher-123";
    const first = buildClaimToken(base);
    const second = buildClaimToken(base);
    expect(first.startsWith(`${base}:`)).toBe(true);
    expect(second.startsWith(`${base}:`)).toBe(true);
    expect(first).not.toBe(second);
    const suffix = first.slice(base.length + 1);
    expect(suffix).toMatch(/^[0-9a-f-]{8,}$/i);
  });

  it("same process, two drains never share a fencing predicate", () => {
    const base = "provider-dispatcher-999";
    const tokens = new Set([buildClaimToken(base), buildClaimToken(base), buildClaimToken(base)]);
    expect(tokens.size).toBe(3);
  });

  it("a stale worker reclaim mints a token the prior owner cannot match", () => {
    const base = "provider-dispatcher-42";
    const owner = buildClaimToken(base);
    const reclaimer = buildClaimToken(base);
    // The fencing predicate is `claimed_by = $token`: different tokens never
    // satisfy each other's UPDATE, even from the same process.
    expect(owner).not.toBe(reclaimer);
    const storedClaimedBy = owner;
    expect(storedClaimedBy === reclaimer).toBe(false);
  });
});

describe("CV-DSP-01-FIX D2 provenance (pure)", () => {
  it("recognizes the durable secret-required version (case-insensitive)", () => {
    expect(isSecretRequiredProvenance("secret-required-v1")).toBe(true);
    expect(isSecretRequiredProvenance("SECRET-REQUIRED-V1")).toBe(true);
    expect(isSecretRequiredProvenance("echo-v1")).toBe(false);
    expect(isSecretRequiredProvenance(null)).toBe(false);
  });

  it("classifies secret-required by durable version, never by port name", () => {
    expect(classifyDispatchProvenance({ adapterVersion: "secret-required-v1", adapter: "browser" })).toBe(
      "secret-required",
    );
    // Even a secret-required row recorded with an echo adapter label stays
    // secret-required: the version decides, not the label.
    expect(classifyDispatchProvenance({ adapterVersion: "secret-required-v1", adapter: "echo" })).toBe(
      "secret-required",
    );
  });

  it("classifies synthetic echo/manual pairs via the shared readback seam", () => {
    expect(classifyDispatchProvenance({ adapterVersion: "echo-v1", adapter: "echo" })).toBe("synthetic");
    expect(classifyDispatchProvenance({ adapterVersion: "manual-v1", adapter: "manual" })).toBe("synthetic");
  });

  it("classifies spoofs and legacy rows as other (fail-closed, never synthetic)", () => {
    expect(classifyDispatchProvenance({ adapterVersion: "echo-v2", adapter: "echo" })).toBe("other");
    expect(classifyDispatchProvenance({ adapterVersion: "manual-x", adapter: "manual" })).toBe("other");
    expect(classifyDispatchProvenance({ adapterVersion: null, adapter: "echo" })).toBe("other");
    expect(classifyDispatchProvenance({ adapterVersion: null, adapter: null })).toBe("other");
  });
});

describe("CV-DSP-01-FIX D4 capability revalidation (pure)", () => {
  it("missing row blocks the send (fail-closed)", () => {
    expect(isDispatchCapabilityBlocked(null)).toBe(true);
  });

  it("UNAVAILABLE blocks even after an AVAILABLE request", () => {
    expect(isDispatchCapabilityBlocked({ availability: "UNAVAILABLE" })).toBe(true);
  });

  it("AVAILABLE and DEGRADED let the dispatcher proceed", () => {
    expect(isDispatchCapabilityBlocked({ availability: "AVAILABLE" })).toBe(false);
    expect(isDispatchCapabilityBlocked({ availability: "DEGRADED" })).toBe(false);
  });
});

describe("FASE5-S3 inconclusive reconcile convergence (SPEC §16 write incerta, §39 HITL)", () => {
  function unknownBus(): { db: MemoryDb; bus: CommandBus; browser: FakeBrowserPort } {
    const browser = new FakeBrowserPort({ outcome: "UNKNOWN", detail: "browser: uncertain", externalRef: null });
    const { db, bus } = secretBus(browser);
    return { db, bus, browser };
  }

  it("AC1: secret-required VERIFYING + reconcile → scheduled (zero in-tx I/O, zero writes)", async () => {
    const { db, bus, browser } = unknownBus();
    const trialId = await requestEligibleTrial(bus, "S3 Converge Trial");
    const parked = await bus.execute<{ status: string; operationId: string }>(actor(), "trial.begin_provisioning", {
      trialId,
    });
    expect(parked).toMatchObject({ ok: true, data: { status: "PROVISIONING" } });
    if (!parked.ok) throw new Error(`expected PROVISIONING park: ${dumped(parked)}`);
    const operationId = parked.data.operationId;
    // FASE5-S6-FIX2 (SPEC §41): the secret path queues without executing,
    // so the uncertain send + VERIFYING park now happen in the durable
    // dispatcher. Arrange the VERIFYING row directly (the exact shape the
    // dispatcher writes post-send) — and no port was ever called.
    expect(browser.calls).toHaveLength(0);
    probeTrialMemory(db).mem.providerOperations.get(operationId)!.status = "VERIFYING";
    const callsBefore = browser.calls.length;

    // FASE5-FIX4-N1 (SPEC §12/§41): reconcile of a VERIFYING real trial
    // only SCHEDULES — zero port traffic, zero writes. The S3 convergence
    // (HUMAN_REQUIRED on inconclusive readback) runs in the durable
    // dispatcher recovery outside any transaction.
    const reconciled = await bus.execute<{
      status: string;
      effectCertainty: string;
      effectApplied: boolean;
      resumedTrial: boolean;
      reconciliation?: string;
    }>(actor(), "provider.reconcile", { operationId });
    expect(reconciled).toMatchObject({
      ok: true,
      data: {
        status: "VERIFYING",
        effectCertainty: "UNKNOWN",
        effectApplied: false,
        resumedTrial: false,
        reconciliation: "scheduled",
      },
    });
    // Never touches the operation.
    expect(browser.calls).toHaveLength(callsBefore);

    const { mem } = probeTrialMemory(db);
    const op = mem.providerOperations.get(operationId);
    expect(op?.status).toBe("VERIFYING");
    expect(op?.effectCertainty).toBe("UNKNOWN");
    expect(op?.completedAt).toBeNull();
    // The trial never moved: still PROVISIONING, resolvable via recovery.
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");

    // Same event/audit vocabulary as before: no terminal event, no trial
    // move event, no new attempt row.
    const types = db.txFor(TENANT).events.map((e) => e.event_type);
    expect(types).not.toContain("provider.operation_succeeded.v1");
    expect(types).not.toContain("provider.operation_failed.v1");
    expect(types).not.toContain("trial.activated.v1");
    expect(types).not.toContain("trial.provisioning_failed.v1");
    const attempts = mem.providerAttempts.filter((a) => a.operationId === operationId);
    expect(attempts.map((a) => a.status)).not.toContain("HUMAN_REQUIRED");
    expect(dumped({ op, response: reconciled })).not.toContain("infisical://");
  });

  it("AC3: repeat scheduled reconcile over a VERIFYING real trial writes nothing; converged HUMAN_REQUIRED stays a no-op", async () => {
    const { db, bus } = unknownBus();
    const trialId = await requestEligibleTrial(bus, "S3 Idempotent Trial");
    const parked = await bus.execute<{ status: string; operationId: string }>(actor(), "trial.begin_provisioning", {
      trialId,
    });
    if (!parked.ok) throw new Error(`expected PROVISIONING park: ${dumped(parked)}`);
    const operationId = parked.data.operationId;
    // FASE5-S6-FIX2: same dispatcher-shape arrange as AC1 above.
    probeTrialMemory(db).mem.providerOperations.get(operationId)!.status = "VERIFYING";
    const first = await bus.execute<{ status: string; reconciliation?: string }>(actor(), "provider.reconcile", {
      operationId,
    });
    expect(first).toMatchObject({ ok: true, data: { status: "VERIFYING", reconciliation: "scheduled" } });

    const { mem } = probeTrialMemory(db);
    const attemptsBefore = mem.providerAttempts.filter((a) => a.operationId === operationId).length;
    const eventsBefore = db.txFor(TENANT).events.length;
    const opBefore = dumped(mem.providerOperations.get(operationId));

    const second = await bus.execute<{
      status: string;
      effectCertainty: string;
      effectApplied: boolean;
      resumedTrial: boolean;
      reconciliation?: string;
    }>(actor(), "provider.reconcile", { operationId });
    expect(second).toMatchObject({
      ok: true,
      data: {
        status: "VERIFYING",
        effectCertainty: "UNKNOWN",
        effectApplied: false,
        resumedTrial: false,
        reconciliation: "scheduled",
      },
    });
    // Zero duplicate writes: no new attempt, no new event, same row.
    expect(mem.providerAttempts.filter((a) => a.operationId === operationId)).toHaveLength(attemptsBefore);
    expect(db.txFor(TENANT).events).toHaveLength(eventsBefore);
    expect(dumped(mem.providerOperations.get(operationId))).toBe(opBefore);
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");

    // An already-converged secret-required HUMAN_REQUIRED row (dispatcher
    // recovery output) stays an honest no-op with zero writes.
    mem.providerOperations.get(operationId)!.status = "HUMAN_REQUIRED";
    const converged = await bus.execute<{ status: string }>(actor(), "provider.reconcile", { operationId });
    expect(converged).toMatchObject({ ok: true, data: { status: "HUMAN_REQUIRED" } });
    expect(mem.providerAttempts.filter((a) => a.operationId === operationId)).toHaveLength(attemptsBefore);
    expect(db.txFor(TENANT).events).toHaveLength(eventsBefore);
  });

});

describe("SPEC §25 provider.request_operation trial.preconditions (fail-closed)", () => {
  async function requestTrialProvision(
    bus: CommandBus,
    input: { entityId: string; idempotencyKey: string },
  ): Promise<{ ok: boolean; code?: string }> {
    const result = await bus.execute(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId: input.entityId,
      idempotencyKey: input.idempotencyKey,
      payload: { duration_minutes: 60 },
    });
    return result.ok ? { ok: true } : { ok: false, code: result.code };
  }

  it("AC3: unknown trial is refused with not_found and zero side effects", async () => {
    const browser = new FakeBrowserPort();
    const { db, bus } = secretBus(browser);
    const refused = await requestTrialProvision(bus, {
      entityId: "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3",
      idempotencyKey: "s25-unknown",
    });
    expect(refused).toEqual({ ok: false, code: "not_found" });
    expect(browser.calls).toHaveLength(0);
    const { mem } = probeTrialMemory(db);
    expect(mem.providerOperations.size).toBe(0);
    expect(db.txFor(TENANT).events).toHaveLength(0);
  });

  it("AC3: non-REQUESTED trial is refused with precondition_failed and no port call", async () => {
    const browser = new FakeBrowserPort({
      outcome: "SUCCEEDED",
      detail: "browser: ok",
      externalRef: "ext-s25",
    });
    const { db, bus } = secretBus(browser);
    const trialId = await requestEligibleTrial(bus, "S25 Active Trial");
    // FASE5-S6-FIX2: ACTIVE is arranged directly (inline secret execution
    // no longer exists) — the refusal asserts below are unchanged.
    probeTrialMemory(db).mem.trials.get(trialId)!.lifecycleStatus = "ACTIVE";
    const callsBefore = browser.calls.length;
    const { mem: activeMem } = probeTrialMemory(db);
    const opsBefore = activeMem.providerOperations.size;
    const refused = await requestTrialProvision(bus, { entityId: trialId, idempotencyKey: "s25-active" });
    expect(refused).toEqual({ ok: false, code: "precondition_failed" });
    expect(browser.calls).toHaveLength(callsBefore);
    expect(activeMem.providerOperations.size).toBe(opsBefore);
  });

  it("AC3: open non-terminal operation refuses a second intent with no port call", async () => {
    process.env["PROVIDER_DISPATCH_MODE"] = "durable";
    try {
      const browser = new FakeBrowserPort();
      const { db, bus } = secretBus(browser);
      const trialId = await requestEligibleTrial(bus, "S25 Parked Trial");
      const parked = await bus.execute(actor(), "trial.begin_provisioning", { trialId });
      if (!parked.ok) throw new Error(`durable park failed: ${dumped(parked)}`);
      const { mem: parkedMem } = probeTrialMemory(db);
      const opsBefore = parkedMem.providerOperations.size;
      const refused = await requestTrialProvision(bus, { entityId: trialId, idempotencyKey: "s25-parked" });
      expect(refused).toEqual({ ok: false, code: "precondition_failed" });
      expect(browser.calls).toHaveLength(0);
      expect(parkedMem.providerOperations.size).toBe(opsBefore);
    } finally {
      delete process.env["PROVIDER_DISPATCH_MODE"];
    }
  });

  it("AC4: eligible REQUESTED trial queues through the provider entry (SPEC §41)", async () => {
    const browser = new FakeBrowserPort({
      outcome: "SUCCEEDED",
      detail: "browser: ok",
      externalRef: "ext-s25-happy",
    });
    const { db, bus } = secretBus(browser);
    const trialId = await requestEligibleTrial(bus, "S25 Happy Trial");
    const result = await bus.execute<{ id: string; status: string; effectCertainty: string }>(
      actor(),
      "provider.request_operation",
      {
        action: "trial.provision",
        entityType: "trial",
        entityId: trialId,
        idempotencyKey: "s25-happy",
        payload: { duration_minutes: 60 },
      },
    );
    // FASE5-S6-FIX2 (SPEC §41): the secret-required `trial.provision`
    // NEVER executes inline — zero port calls inside the command
    // transaction; the durable dispatcher owns execution + readback.
    expect(result).toMatchObject({ ok: true, data: { status: "QUEUED", effectCertainty: "UNKNOWN" } });
    expect(browser.calls).toHaveLength(0);
    expect(probeTrialMemory(db).mem.providerOperations.size).toBe(1);
  });
});
