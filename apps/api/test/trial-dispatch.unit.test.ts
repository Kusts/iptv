import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandActor } from "@iptv/domain";
import { CommandBus, type CommandHandlerContext } from "../src/commands/command-bus.js";
import { registerCrmCommands } from "../src/crm/crm.commands.js";
import { registerHumanReviewCommands } from "../src/human-review/human-review.commands.js";
import { registerPolicyCommands } from "../src/policy/policy.commands.js";
import { registerTrialCommands, applyTrialProvisionOutcome } from "../src/trial/trial.commands.js";
import { registerProviderCommands, applySecretPortOutcome, decideVerifyingTrialReconcile } from "../src/provider/provider.commands.js";
import type { TrialReadbackResult } from "../src/trial/trial-readback.js";
import { normalizeTrialExternalId } from "../src/trial/trial-readback.js";
import { FakeTrialReadback, fakeTrialExternalId } from "./fakes/trial-readback-fake.js";
import { EchoProviderOpsAdapter, ManualProviderOpsAdapter } from "../src/provider/provider-port.js";
import type { ProviderReadbackPort } from "../src/provider/provider-port.js";
import { buildDispatchPortPayload, TRIAL_CAPABILITY_KEY } from "../src/provider/provider-secret-gate.js";
import { SECRET_REQUIRED_ADAPTER_VERSION } from "../src/provider/provider-port.js";
import type { AdapterResult, ProviderOperationRequest, ProviderOpsPort } from "../src/provider/provider-port.js";
import { trialMemoryOf, insertProviderOperation, updateProviderOperation } from "../src/trial/trial-store.js";
import * as trialStore from "../src/trial/trial-store.js";
import { MemoryDb } from "./fakes/memory-fakes.js";

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

  constructor(private outcome: AdapterResult = { outcome: "MANUAL", detail: "browser: parked", externalRef: null }) {}

  setOutcome(outcome: AdapterResult): void {
    this.outcome = outcome;
  }

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

function setupSecretTrialBus(browser: FakeBrowserPort): { db: MemoryDb; bus: CommandBus } {
  const db = new MemoryDb();
  seedTrialAccount(db);
  markTrialGateAvailable(db);
  // FASE5-S6: the secret path now gates SUCCEEDED on a conclusive
  // READ_CUSTOMER readback — the suite default satisfies it (string
  // `is_trial`, future expiry) so these flows prove the full
  // dispatch→readback→binding→ACTIVE path.
  const trialReadbackPort = new FakeTrialReadback();
  const bus = new CommandBus(db);
  registerHumanReviewCommands(bus);
  registerPolicyCommands(bus);
  registerCrmCommands(bus);
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

/**
 * FASE5-S6: satisfied readback with a fixed external id for applier-direct
 * tests (the bus-level fake derives the id from the trial instead).
 */
function satisfiedReadback(externalId: string): TrialReadbackResult {
  return {
    conclusive: true,
    customer: {
      exists: true,
      externalId,
      isTrial: "1",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    evidence: "test:conclusive",
  };
}

async function requestSecretTrial(bus: CommandBus, canonicalName: string): Promise<string> {
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

beforeEach(() => {
  delete process.env["PROVIDER_DISPATCH_MODE"];
});

describe("CV-DSP-02 trial durable cut (secret branch)", () => {
  it("inline and durable share the queue-only contract: zero port calls in-transaction", async () => {
    const browser = new FakeBrowserPort({
      outcome: "SUCCEEDED",
      detail: "browser: ok",
      externalRef: "ext-inline-1",
    });
    const { db, bus } = setupSecretTrialBus(browser);
    const trialId = await requestSecretTrial(bus, "Inline Trial");
    const provisioned = await bus.execute<{ id: string; status: string; operationId: string; effectUncertain: boolean }>(
      actor(),
      "trial.begin_provisioning",
      { trialId },
    );
    // FASE5-S6-FIX2 (SPEC §41): the secret-required `trial.provision`
    // NEVER executes inline — the REQUESTED row is the committed intent
    // the durable dispatcher claims post-commit (parity with the durable
    // cut by construction).
    expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING", effectUncertain: true } });
    expect(browser.calls).toHaveLength(0);
    const { mem } = probeTrialMemory(db);
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
    const opId = provisioned.ok ? provisioned.data.operationId : "";
    const op = mem.providerOperations.get(opId);
    expect(op?.status).toBe("REQUESTED");
    expect(op?.adapterVersion).toBe(SECRET_REQUIRED_ADAPTER_VERSION);
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("provider.operation_requested.v1");
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).not.toContain("trial.activated.v1");
  });

  it("durable returns PROVISIONING with zero external effect; the row stays REQUESTED", async () => {
    process.env["PROVIDER_DISPATCH_MODE"] = "durable";
    try {
      const browser = new FakeBrowserPort();
      const { db, bus } = setupSecretTrialBus(browser);
      const trialId = await requestSecretTrial(bus, "Durable Trial");
      const provisioned = await bus.execute<{
        id: string;
        status: string;
        operationId: string;
        effectUncertain: boolean;
      }>(actor(), "trial.begin_provisioning", { trialId });
      expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING", effectUncertain: true } });
      expect(browser.calls).toHaveLength(0);
      if (!provisioned.ok) throw new Error("expected durable park");
      const { mem } = probeTrialMemory(db);
      expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
      const op = mem.providerOperations.get(provisioned.data.operationId);
      expect(op?.status).toBe("REQUESTED");
      expect(op?.effectCertainty).toBe("UNKNOWN");
      expect(op?.adapterVersion).toBe(SECRET_REQUIRED_ADAPTER_VERSION);
      expect(op?.completedAt).toBeNull();
      expect(mem.providerAttempts.filter((a) => a.operationId === provisioned.data.operationId)).toHaveLength(0);
      const types = db.txFor(TENANT).events.map((e) => e.event_type);
      expect(types).toContain("provider.operation_requested.v1");
      expect(types).toContain("trial.provisioning_started.v1");
      expect(types).not.toContain("provider.operation_succeeded.v1");
      expect(types).not.toContain("provider.operation_failed.v1");
      expect(types).not.toContain("trial.activated.v1");
      expect(dumped({ events: db.txFor(TENANT).events, op })).not.toContain("infisical://");
    } finally {
      delete process.env["PROVIDER_DISPATCH_MODE"];
    }
  });
});

describe("CV-DSP-02 trial shared outcome applier (one source of truth)", () => {
  async function durableParkedTrial(
    canonicalName: string,
  ): Promise<{ db: MemoryDb; bus: CommandBus; trialId: string; operationId: string }> {
    process.env["PROVIDER_DISPATCH_MODE"] = "durable";
    try {
      const browser = new FakeBrowserPort();
      const { db, bus } = setupSecretTrialBus(browser);
      const trialId = await requestSecretTrial(bus, canonicalName);
      const provisioned = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", { trialId });
      if (!provisioned.ok) throw new Error(`durable park failed: ${dumped(provisioned)}`);
      return { db, bus, trialId, operationId: provisioned.data.operationId };
    } finally {
      delete process.env["PROVIDER_DISPATCH_MODE"];
    }
  }

  it("SUCCEEDED activates with safe evidence only", async () => {
    const { db, trialId, operationId } = await durableParkedTrial("Applier Success");
    const { ctx } = probeTrialMemory(db);
    const applied = await applyTrialProvisionOutcome(ctx, {
      operationId,
      trialId,
      raw: { outcome: "SUCCEEDED", detail: "raw must never persist", externalRef: "ext-abc" },
      // FASE5-S6: SUCCEEDED alone no longer terminates — the conclusive
      // readback carries the postcondition proof (string `is_trial`
      // exercises the §11 normalization on the happy path).
      trialReadback: satisfiedReadback("ext-abc"),
    });
    expect(applied).toEqual({ status: "SUCCEEDED", trialStatus: "ACTIVE", effectCertainty: "KNOWN_APPLIED", resumed: true });
    const { mem } = probeTrialMemory(db);
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("ACTIVE");
    expect(mem.providerOperations.get(operationId)?.resultSummary).toEqual({
      external_ref: "ext-abc",
      readback: "conclusive",
      postcondition: "satisfied",
    });
    expect(dumped({ op: mem.providerOperations.get(operationId), events: db.txFor(TENANT).events })).not.toContain(
      "raw must never persist",
    );
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("trial.activated.v1");
    // FASE5-S6 (§30/§31): the stable binding is recorded and the trial
    // points at it; sanitized readback evidence exists with no raw payload.
    expect(mem.providerBindings).toHaveLength(1);
    expect(mem.providerBindings[0]).toMatchObject({ entityType: "trial", entityId: trialId, externalId: "ext-abc" });
    expect(mem.trials.get(trialId)?.providerBindingId).toBe(mem.providerBindings[0]?.id);
    expect(mem.providerEvidence).toHaveLength(1);
    expect(mem.providerEvidence[0]).toMatchObject({
      operationId,
      evidenceType: "TRIAL_READBACK_POSTCONDITION",
    });
    expect(dumped(mem.providerEvidence[0]?.structured)).not.toContain("raw must never persist");
  });

  it("SUCCEEDED with an invalid ref demotes to VERIFYING (ambiguous effect retained)", async () => {
    const { db, trialId, operationId } = await durableParkedTrial("Applier Demotion");
    const { ctx } = probeTrialMemory(db);
    const applied = await applyTrialProvisionOutcome(ctx, {
      operationId,
      trialId,
      raw: { outcome: "SUCCEEDED", detail: "x", externalRef: "infisical://production/LEAK" },
    });
    expect(applied).toEqual({ status: "VERIFYING", trialStatus: "PROVISIONING", effectCertainty: "UNKNOWN", resumed: false });
    const { mem } = probeTrialMemory(db);
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
    expect(mem.providerOperations.get(operationId)?.status).toBe("VERIFYING");
  });

  it("FAILED returns the trial to REQUESTED with the fixed code", async () => {
    const { db, trialId, operationId } = await durableParkedTrial("Applier Failed");
    const { ctx } = probeTrialMemory(db);
    const applied = await applyTrialProvisionOutcome(ctx, {
      operationId,
      trialId,
      raw: { outcome: "FAILED", detail: "raw failure text", externalRef: null },
    });
    expect(applied).toEqual({ status: "FAILED", trialStatus: "REQUESTED", effectCertainty: "KNOWN_NOT_APPLIED", resumed: true });
    const { mem } = probeTrialMemory(db);
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("REQUESTED");
    expect(mem.providerOperations.get(operationId)?.resultSummary).toEqual({ error_code: "PROVISION_FAILED" });
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("trial.provisioning_failed.v1");
  });

  it("UNKNOWN parks VERIFYING and MANUAL parks HUMAN_REQUIRED, both PROVISIONING", async () => {
    const first = await durableParkedTrial("Applier Unknown");
    const firstCtx = probeTrialMemory(first.db).ctx;
    expect(
      await applyTrialProvisionOutcome(firstCtx, {
        operationId: first.operationId,
        trialId: first.trialId,
        raw: { outcome: "UNKNOWN", detail: "x", externalRef: null },
      }),
    ).toEqual({ status: "VERIFYING", trialStatus: "PROVISIONING", effectCertainty: "UNKNOWN", resumed: false });

    const second = await durableParkedTrial("Applier Manual");
    const secondCtx = probeTrialMemory(second.db).ctx;
    expect(
      await applyTrialProvisionOutcome(secondCtx, {
        operationId: second.operationId,
        trialId: second.trialId,
        raw: { outcome: "MANUAL", detail: "x", externalRef: null },
      }),
    ).toEqual({ status: "HUMAN_REQUIRED", trialStatus: "PROVISIONING", effectCertainty: "UNKNOWN", resumed: false });
  });

  it("a fence on the memory path falls back to the unfenced behavior", async () => {
    const { db, trialId, operationId } = await durableParkedTrial("Applier Fence Memory");
    const { ctx } = probeTrialMemory(db);
    const applied = await applyTrialProvisionOutcome(
      ctx,
      {
        operationId,
        trialId,
        raw: { outcome: "SUCCEEDED", detail: "x", externalRef: "ext-f" },
        trialReadback: satisfiedReadback("ext-f"),
      },
      { claimedBy: "any-token" },
    );
    expect(applied?.status).toBe("SUCCEEDED");
  });
});

describe("CV-DSP-02-FIX F1 trial payload parity (memory)", () => {
  it("persisted intent projects to the certified dispatcher payload (no domain metadata on the wire)", async () => {
    const browser = new FakeBrowserPort({
      outcome: "SUCCEEDED",
      detail: "browser: ok",
      externalRef: "ext-parity",
    });
    const { db, bus } = setupSecretTrialBus(browser);
    const trialId = await requestSecretTrial(bus, "Parity Trial");
    const provisioned = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", { trialId });
    if (!provisioned.ok) throw new Error(`expected queue: ${dumped(provisioned)}`);
    // FASE5-S6-FIX2 (SPEC §41): no inline wire call exists anymore — the
    // parity proof is that the persisted intent projects to exactly the
    // certified dispatcher payload (domain metadata stays on the row).
    expect(browser.calls).toHaveLength(0);
    const { mem } = probeTrialMemory(db);
    const persisted = mem.providerOperations.get(provisioned.data.operationId)?.requestedPayload as Record<
      string,
      unknown
    >;
    expect(persisted["trial_kind"]).toBe("TRIAL");
    expect(buildDispatchPortPayload("trial.provision", persisted)).toEqual({
      duration_minutes: 60,
      adult_content_enabled: false,
    });
  });
});

describe("CV-DSP-02-FIX F2 failed honesty (memory)", () => {
  it("durable FAILED with a CANCELLED trial emits no event and reports honestly", async () => {
    process.env["PROVIDER_DISPATCH_MODE"] = "durable";
    try {
      const browser = new FakeBrowserPort();
      const { db, bus } = setupSecretTrialBus(browser);
      const trialId = await requestSecretTrial(bus, "Cancelled Before Effect");
      const parked = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", { trialId });
      if (!parked.ok) throw new Error(`durable park failed: ${dumped(parked)}`);
      const { operationId } = parked.data;
      const cancelled = await bus.execute(actor(), "trial.cancel", { trialId, reason: "operator changed mind" });
      expect(cancelled.ok).toBe(true);
      const eventsBefore = db.txFor(TENANT).events.length;
      const { ctx } = probeTrialMemory(db);
      const applied = await applyTrialProvisionOutcome(ctx, {
        operationId,
        trialId,
        raw: { outcome: "FAILED", detail: "late failure", externalRef: null },
      });
      // No transition happened (CANCELLED already left PROVISIONING).
      expect(applied).toEqual({
        status: "FAILED",
        trialStatus: "CANCELLED",
        effectCertainty: "KNOWN_NOT_APPLIED",
        resumed: false,
      });
      const { mem } = probeTrialMemory(db);
      expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("CANCELLED");
      expect(mem.providerOperations.get(operationId)?.status).toBe("FAILED");
      const newTypes = db.txFor(TENANT).events.slice(eventsBefore).map((e) => e.event_type);
      expect(newTypes).toContain("provider.operation_failed.v1");
      expect(newTypes).not.toContain("trial.provisioning_failed.v1");
    } finally {
      delete process.env["PROVIDER_DISPATCH_MODE"];
    }
  });
});

describe("CV-DSP-02-FIX F3 shared trial applier parity (memory)", () => {
  it("generic entry uses the canonical business key + preparation; dispatcher path activates with binding", async () => {
    const browser = new FakeBrowserPort({
      outcome: "SUCCEEDED",
      detail: "browser: ok",
      externalRef: "ext-shared",
    });
    const { db, bus } = setupSecretTrialBus(browser);
    // Entry 1: trial.begin_provisioning queues the durable intent.
    const trialA = await requestSecretTrial(bus, "Entry Trial");
    const provisionedA = await bus.execute<{ status: string; operationId: string }>(
      actor(),
      "trial.begin_provisioning",
      { trialId: trialA },
    );
    expect(provisionedA).toMatchObject({ ok: true, data: { status: "PROVISIONING" } });
    // Entry 2: an eligible REQUESTED trial driven through the generic
    // provider entry with an ARBITRARY caller key. FASE5-FIX3-R1: the caller
    // key is IGNORED for `trial.provision` — the row carries the canonical
    // business key, exactly like the domain entry.
    const trialB = await requestSecretTrial(bus, "Entry Provider");
    const requested = await bus.execute<{ id: string; status: string; effectCertainty: string }>(
      actor(),
      "provider.request_operation",
      {
        action: "trial.provision",
        entityType: "trial",
        entityId: trialB,
        idempotencyKey: `f3-parity-${trialB}`,
        payload: { duration_minutes: 60, adult_content_enabled: false },
      },
    );
    expect(requested).toMatchObject({ ok: true, data: { status: "QUEUED", effectCertainty: "UNKNOWN" } });
    const { mem } = probeTrialMemory(db);
    if (!provisionedA.ok || !requested.ok) throw new Error("expected both entries queued");
    const opA = mem.providerOperations.get(provisionedA.data.operationId);
    const opB = mem.providerOperations.get(requested.data.id);
    // SAME canonical identity on both entries (caller key discarded)...
    expect(opA?.idempotencyKey).toBe(`trial-provision:${trialA}`);
    expect(opB?.idempotencyKey).toBe(`trial-provision:${trialB}`);
    expect(opA?.status).toBe("REQUESTED");
    expect(opB?.status).toBe("REQUESTED");
    expect(opA?.adapterVersion).toBe(SECRET_REQUIRED_ADAPTER_VERSION);
    expect(opB?.adapterVersion).toBe(SECRET_REQUIRED_ADAPTER_VERSION);
    // ...SAME preparation (FASE5-FIX3-R2): both trials PROVISIONING with
    // zero port effect anywhere (the durable dispatcher owns the send).
    expect(mem.trials.get(trialA)?.lifecycleStatus).toBe("PROVISIONING");
    expect(mem.trials.get(trialB)?.lifecycleStatus).toBe("PROVISIONING");
    expect(browser.calls).toHaveLength(0);
    const allEvents = db.txFor(TENANT).events;
    const startedEvents = allEvents.filter((e) => e.event_type === "trial.provisioning_started.v1");
    expect(startedEvents).toHaveLength(2);
    // A second caller key for the same trial never mints a second row.
    const opsBefore = mem.providerOperations.size;
    const dup = await bus.execute(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId: trialB,
      idempotencyKey: `f3-parity-other-${trialB}`,
      payload: { duration_minutes: 60, adult_content_enabled: false },
    });
    expect(dup.ok).toBe(false);
    expect(mem.providerOperations.size).toBe(opsBefore);
    expect(browser.calls).toHaveLength(0);
    // Dispatcher path (shared applier + satisfied readback with the fake's
    // deterministic external id, the same contract `drainOnce` runs
    // post-commit): SUCCEEDED → ACTIVE + binding.
    const { ctx } = probeTrialMemory(db);
    const snapshot = satisfiedReadback(fakeTrialExternalId(trialB));
    const applied = await applyTrialProvisionOutcome(ctx, {
      operationId: requested.data.id,
      trialId: trialB,
      raw: { outcome: "SUCCEEDED", detail: "browser: ok", externalRef: "ext-shared" },
      via: "provider.resolve",
      trialReadback: snapshot,
    });
    expect(applied).toMatchObject({ status: "SUCCEEDED", trialStatus: "ACTIVE", effectCertainty: "KNOWN_APPLIED" });
    expect(mem.trials.get(trialB)?.lifecycleStatus).toBe("ACTIVE");
    const binding = mem.providerBindings.find((b) => b.entityId === trialB);
    expect(binding?.externalId).toBe(fakeTrialExternalId(trialB));
    expect(mem.trials.get(trialB)?.providerBindingId).toBe(binding?.id);
    // Post-success intent is blocked by the lifecycle/reopen barrier
    // (Security#2: a new intent after success never reopens).
    const after = await bus.execute(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId: trialB,
      idempotencyKey: `f3-post-success-${trialB}`,
      payload: { duration_minutes: 60, adult_content_enabled: false },
    });
    expect(after.ok).toBe(false);
    if (after.ok) throw new Error("expected a post-success refusal");
    expect(after.code).toBe("precondition_failed");
  });

  it("the shared applier keeps the explicit via provenance on the activation event", async () => {
    process.env["PROVIDER_DISPATCH_MODE"] = "durable";
    try {
      const browser = new FakeBrowserPort();
      const { db, bus } = setupSecretTrialBus(browser);
      const withVia = await requestSecretTrial(bus, "Via Provider Resolve");
      const parkedVia = await bus.execute(actor(), "trial.begin_provisioning", { trialId: withVia });
      if (!parkedVia.ok) throw new Error(`durable park failed: ${dumped(parkedVia)}`);
      const withoutVia = await requestSecretTrial(bus, "Via Domain Entry");
      const parkedPlain = await bus.execute(actor(), "trial.begin_provisioning", { trialId: withoutVia });
      if (!parkedPlain.ok) throw new Error(`durable park failed: ${dumped(parkedPlain)}`);
      const { ctx } = probeTrialMemory(db);
      const opVia = (parkedVia as { data: { operationId: string } }).data.operationId;
      const opPlain = (parkedPlain as { data: { operationId: string } }).data.operationId;
      const appliedVia = await applyTrialProvisionOutcome(ctx, {
        operationId: opVia,
        trialId: withVia,
        raw: { outcome: "SUCCEEDED", detail: "x", externalRef: "ext-via" },
        via: "provider.resolve",
        trialReadback: satisfiedReadback("ext-via"),
      });
      const appliedPlain = await applyTrialProvisionOutcome(ctx, {
        operationId: opPlain,
        trialId: withoutVia,
        raw: { outcome: "SUCCEEDED", detail: "x", externalRef: "ext-plain" },
        trialReadback: satisfiedReadback("ext-plain"),
      });
      expect(appliedVia?.trialStatus).toBe("ACTIVE");
      expect(appliedPlain?.trialStatus).toBe("ACTIVE");
      // Same domain effect; the only deliberate difference is the explicit via.
      const events = db.txFor(TENANT).events;
      const dataVia = events
        .filter((e) => e.event_type === "trial.activated.v1" && e.aggregate_id === withVia)
        .map((e) => e.data as Record<string, unknown>);
      const dataPlain = events
        .filter((e) => e.event_type === "trial.activated.v1" && e.aggregate_id === withoutVia)
        .map((e) => e.data as Record<string, unknown>);
      expect(dataVia).toHaveLength(1);
      expect(dataPlain).toHaveLength(1);
      expect(dataVia[0]).toMatchObject({ via: "provider.resolve" });
      expect(dataPlain[0]).not.toHaveProperty("via");
    } finally {
      delete process.env["PROVIDER_DISPATCH_MODE"];
    }
  });

  it("provider.request_operation on an already-parked trial is refused with no second port call", async () => {
    const browser = new FakeBrowserPort({
      outcome: "SUCCEEDED",
      detail: "browser: ok",
      externalRef: "ext-shared",
    });
    const { db, bus } = setupSecretTrialBus(browser);
    // Park the trial through the domain entry (durable: no port effect yet).
    process.env["PROVIDER_DISPATCH_MODE"] = "durable";
    let trialId: string;
    try {
      trialId = await requestSecretTrial(bus, "Parked Then Bypass");
      const parked = await bus.execute(actor(), "trial.begin_provisioning", { trialId });
      if (!parked.ok) throw new Error(`durable park failed: ${dumped(parked)}`);
    } finally {
      delete process.env["PROVIDER_DISPATCH_MODE"];
    }
    const callsBefore = browser.calls.length;
    const { mem: bypassMem } = probeTrialMemory(db);
    const opsBefore = bypassMem.providerOperations.size;
    // The bypass entry now refuses: a non-terminal operation is already open.
    const refused = await bus.execute(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId: trialId,
      idempotencyKey: `f3-bypass-${trialId}`,
      payload: { duration_minutes: 60, adult_content_enabled: false },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a precondition refusal");
    expect(refused.code).toBe("precondition_failed");
    expect(browser.calls).toHaveLength(callsBefore);
    expect(bypassMem.providerOperations.size).toBe(opsBefore);
    expect(bypassMem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
  });
});

describe("SPEC §26 CREATE_TRIAL business-key idempotency (trial-provision:{trialId})", () => {
  it("first provisioning persists the stable key with zero port calls (secret branch)", async () => {
    const browser = new FakeBrowserPort({
      outcome: "SUCCEEDED",
      detail: "browser: ok",
      externalRef: "ext-bk-1",
    });
    const { db, bus } = setupSecretTrialBus(browser);
    const trialId = await requestSecretTrial(bus, "Business Key Secret");
    const provisioned = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", { trialId });
    if (!provisioned.ok) throw new Error(`expected queue: ${dumped(provisioned)}`);
    const { mem } = probeTrialMemory(db);
    const op = mem.providerOperations.get(provisioned.data.operationId);
    expect(op?.idempotencyKey).toBe(`trial-provision:${trialId}`);
    // FASE5-S6-FIX2 (SPEC §41): the wire key is exercised by the durable
    // dispatcher (which reuses this same persisted key); inline performs
    // zero port calls.
    expect(browser.calls).toHaveLength(0);
  });

  it("echo/manual branch uses the identical business key (parity)", async () => {
    const db = new MemoryDb();
    const bus = new CommandBus(db);
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    registerTrialCommands(bus, { opsPort: new EchoProviderOpsAdapter() });
    const personRes = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Business Key Echo",
    });
    if (!personRes.ok) throw new Error("person setup failed");
    const trialRes = await bus.execute<{ id: string | null }>(actor(), "trial.request", {
      personId: personRes.data.id,
      durationMinutes: 60,
    });
    if (!trialRes.ok || trialRes.data.id === null) throw new Error("trial setup failed");
    const trialId = trialRes.data.id;
    const provisioned = await bus.execute<{ operationId: string; status: string }>(
      actor(),
      "trial.begin_provisioning",
      { trialId },
    );
    if (!provisioned.ok) throw new Error(`expected success: ${dumped(provisioned)}`);
    const { mem } = probeTrialMemory(db);
    const op = mem.providerOperations.get(provisioned.data.operationId);
    expect(op?.idempotencyKey).toBe(`trial-provision:${trialId}`);
  });

  it("retry after conclusive FAILED reuses the SAME operation (secret branch, no unique violation)", async () => {
    const browser = new FakeBrowserPort({ outcome: "FAILED", detail: "browser: no credit", externalRef: null });
    const { db, bus } = setupSecretTrialBus(browser);
    const trialId = await requestSecretTrial(bus, "Business Key Retry");
    const first = await bus.execute<{ operationId: string; status: string }>(actor(), "trial.begin_provisioning", {
      trialId,
    });
    if (!first.ok) throw new Error(`expected queue: ${dumped(first)}`);
    expect(first.data.status).toBe("PROVISIONING");
    const firstOpId = first.data.operationId;
    // FASE5-S6-FIX2 (SPEC §41): the conclusive FAILED is applied where the
    // dispatcher applies it — through the shared applier, with no I/O.
    const { ctx } = probeTrialMemory(db);
    const failed = await applyTrialProvisionOutcome(ctx, {
      operationId: firstOpId,
      trialId,
      raw: { outcome: "FAILED", detail: "browser: no credit", externalRef: null },
    });
    expect(failed).toEqual({
      status: "FAILED",
      trialStatus: "REQUESTED",
      effectCertainty: "KNOWN_NOT_APPLIED",
      resumed: true,
    });
    const before = probeTrialMemory(db);
    expect(before.mem.providerOperations.get(firstOpId)?.status).toBe("FAILED");
    expect(before.mem.providerOperations.get(firstOpId)?.idempotencyKey).toBe(`trial-provision:${trialId}`);

    const retry = await bus.execute<{ operationId: string; status: string }>(actor(), "trial.begin_provisioning", {
      trialId,
    });
    expect(retry).toMatchObject({ ok: true, data: { status: "PROVISIONING", operationId: firstOpId } });
    const { mem, ctx: retryCtx } = probeTrialMemory(db);
    // Exactly one provision row for the intent; per-attempt history on it.
    const rows = [...mem.providerOperations.values()].filter(
      (op) => op.tenantId === TENANT && op.entityType === "trial" && op.entityId === trialId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey).toBe(`trial-provision:${trialId}`);
    // The retried intent terminalizes through the same applier (satisfied
    // readback → SUCCEEDED) with zero port calls anywhere.
    const succeeded = await applyTrialProvisionOutcome(retryCtx, {
      operationId: firstOpId,
      trialId,
      raw: { outcome: "SUCCEEDED", detail: "browser: ok", externalRef: "ext-bk-retry" },
      trialReadback: satisfiedReadback("ext-bk-retry"),
    });
    expect(succeeded?.status).toBe("SUCCEEDED");
    expect(mem.providerOperations.get(firstOpId)?.status).toBe("SUCCEEDED");
    expect(mem.providerAttempts.filter((a) => a.operationId === firstOpId)).toHaveLength(2);
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("ACTIVE");
    expect(browser.calls).toHaveLength(0);
  });

  it("echo retry after FAILED reuses the SAME operation across adapters (manual -> echo)", async () => {
    const db = new MemoryDb();
    const bus = new CommandBus(db);
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    const manual = new ManualProviderOpsAdapter();
    registerTrialCommands(bus, { opsPort: manual });
    registerProviderCommands(bus, { opsPort: manual });
    const personRes = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Business Key Cross Adapter",
    });
    if (!personRes.ok) throw new Error("person setup failed");
    const trialRes = await bus.execute<{ id: string | null }>(actor(), "trial.request", {
      personId: personRes.data.id,
      durationMinutes: 60,
    });
    if (!trialRes.ok || trialRes.data.id === null) throw new Error("trial setup failed");
    const trialId = trialRes.data.id;
    const parked = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", { trialId });
    if (!parked.ok) throw new Error(`expected manual park: ${dumped(parked)}`);
    const failed = await bus.execute(actor(), "provider.resolve_operation", {
      operationId: parked.data.operationId,
      outcome: "FAILED",
      note: "credit exhausted",
    });
    expect(failed.ok).toBe(true);
    // The retry states `adapter: "echo"` per-call — the same seam the
    // compat suite uses — so the same intent row is reopened with the new
    // adapter's payload/version instead of inserting a second row.
    const retry = await bus.execute<{ operationId: string; status: string }>(actor(), "trial.begin_provisioning", {
      trialId,
      adapter: "echo",
      echoOutcome: "success",
    });
    expect(retry).toMatchObject({ ok: true, data: { status: "ACTIVE", operationId: parked.data.operationId } });
    const { mem } = probeTrialMemory(db);
    const rows = [...mem.providerOperations.values()].filter(
      (op) => op.tenantId === TENANT && op.entityType === "trial" && op.entityId === trialId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey).toBe(`trial-provision:${trialId}`);
  });

  it("duplicate begin while non-terminal is blocked with 409 and keeps exactly one operation", async () => {
    process.env["PROVIDER_DISPATCH_MODE"] = "durable";
    try {
      const browser = new FakeBrowserPort();
      const { db, bus } = setupSecretTrialBus(browser);
      const trialId = await requestSecretTrial(bus, "Business Key Duplicate");
      const first = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", { trialId });
      if (!first.ok) throw new Error(`durable park failed: ${dumped(first)}`);
      const second = await bus.execute(actor(), "trial.begin_provisioning", { trialId });
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error("expected a conflict");
      expect(second.code).toBe("precondition_failed");
      const { mem } = probeTrialMemory(db);
      const rows = [...mem.providerOperations.values()].filter(
        (op) => op.tenantId === TENANT && op.entityType === "trial" && op.entityId === trialId,
      );
      expect(rows).toHaveLength(1);
    } finally {
      delete process.env["PROVIDER_DISPATCH_MODE"];
    }
  });

  it("replay after SUCCEEDED creates no new operation (lifecycle barrier)", async () => {
    const browser = new FakeBrowserPort({
      outcome: "SUCCEEDED",
      detail: "browser: ok",
      externalRef: "ext-bk-replay",
    });
    const { db, bus } = setupSecretTrialBus(browser);
    const trialId = await requestSecretTrial(bus, "Business Key Replay");
    const first = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", { trialId });
    if (!first.ok) throw new Error(`expected queue: ${dumped(first)}`);
    // FASE5-S6-FIX2 (SPEC §41): terminalization runs where the dispatcher
    // runs it — through the shared applier, with no I/O.
    const { ctx } = probeTrialMemory(db);
    const applied = await applyTrialProvisionOutcome(ctx, {
      operationId: first.data.operationId,
      trialId,
      raw: { outcome: "SUCCEEDED", detail: "browser: ok", externalRef: "ext-bk-replay" },
      trialReadback: satisfiedReadback("ext-bk-replay"),
    });
    expect(applied?.status).toBe("SUCCEEDED");
    const replay = await bus.execute(actor(), "trial.begin_provisioning", { trialId });
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("expected a conflict");
    expect(replay.code).toBe("precondition_failed");
    const { mem } = probeTrialMemory(db);
    const rows = [...mem.providerOperations.values()].filter(
      (op) => op.tenantId === TENANT && op.entityType === "trial" && op.entityId === trialId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey).toBe(`trial-provision:${trialId}`);
    expect(browser.calls).toHaveLength(0);
  });
});

describe("SPEC §25 eligibility gates provisioning (fail-closed)", () => {
  /**
   * A REQUESTED trial row with NO eligibility decision (e.g. predating the
   * gate, or a decision lost upstream). Built directly in memory — the point
   * is the absence of an ALLOW, not the request flow.
   */
  function insertBareTrial(db: MemoryDb, trialId: string): void {
    const { mem } = probeTrialMemory(db);
    mem.trials.set(trialId, {
      id: trialId,
      tenantId: TENANT,
      personId: "55555555-5555-4555-8555-555555555555",
      leadId: null,
      previousTrialId: null,
      trialKind: "TRIAL",
      retrialReason: null,
      lifecycleStatus: "REQUESTED",
      technicalOutcome: "PENDING",
      requestedDurationMinutes: 60,
      adultContentEnabled: false,
      providerAccountId: null,
      providerBindingId: null,
      activatedAt: null,
      expiresAt: null,
      endedAt: null,
      invalidatedReason: null,
    });
  }

  function anchorDecision(db: MemoryDb, trialId: string, outcome: string): void {
    const { mem } = probeTrialMemory(db);
    mem.decisions.push({
      id: "66666666-6666-4666-8666-666666666666",
      tenantId: TENANT,
      personId: "55555555-5555-4555-8555-555555555555",
      outcome,
      policyVersion: "test-policy-v1",
      previousTrialId: null,
      reasonCodes: [outcome === "ALLOW" ? "FIRST_PRIMARY_TRIAL" : "TEST_DENY"],
      evidenceJson: { trial_id: trialId },
      actorType: "human",
      actorId: null,
    });
  }

  it("AC1: begin_provisioning without ALLOW refuses 409 with zero operations and zero port calls", async () => {
    const browser = new FakeBrowserPort({
      outcome: "SUCCEEDED",
      detail: "browser: ok",
      externalRef: "ext-ac1",
    });
    const { db, bus } = setupSecretTrialBus(browser);
    const trialId = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
    insertBareTrial(db, trialId);
    const refused = await bus.execute(actor(), "trial.begin_provisioning", { trialId });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a precondition refusal");
    expect(refused.code).toBe("precondition_failed");
    expect(browser.calls).toHaveLength(0);
    const { mem } = probeTrialMemory(db);
    expect(mem.providerOperations.size).toBe(0);
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("REQUESTED");
  });

  it("AC2: begin_provisioning with DENY or REVIEW-pending refuses 409 with no side effects", async () => {
    for (const [index, outcome] of ["DENY", "REVIEW"].entries()) {
      const browser = new FakeBrowserPort({
        outcome: "SUCCEEDED",
        detail: "browser: ok",
        externalRef: "ext-ac2",
      });
      const { db, bus } = setupSecretTrialBus(browser);
      const trialId = `a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2${index}2`;
      insertBareTrial(db, trialId);
      anchorDecision(db, trialId, outcome);
      const refused = await bus.execute(actor(), "trial.begin_provisioning", { trialId });
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error(`expected a precondition refusal for ${outcome}`);
      expect(refused.code).toBe("precondition_failed");
      expect(browser.calls).toHaveLength(0);
      const { mem } = probeTrialMemory(db);
      expect(mem.providerOperations.size).toBe(0);
      expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("REQUESTED");
    }
  });

  it("AC3: provider.request_operation with an unknown trial refuses without a port call", async () => {
    const browser = new FakeBrowserPort({
      outcome: "SUCCEEDED",
      detail: "browser: ok",
      externalRef: "ext-ac3",
    });
    const { db, bus } = setupSecretTrialBus(browser);
    const refused = await bus.execute(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId: "b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3",
      idempotencyKey: "ac3-unknown-trial",
      payload: { duration_minutes: 60 },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal for an unknown trial");
    expect(refused.code).toBe("not_found");
    expect(browser.calls).toHaveLength(0);
    expect(probeTrialMemory(db).mem.providerOperations.size).toBe(0);
  });

  it("AC3: provider.request_operation without ALLOW refuses without a port call", async () => {
    const browser = new FakeBrowserPort({
      outcome: "SUCCEEDED",
      detail: "browser: ok",
      externalRef: "ext-ac3b",
    });
    const { db, bus } = setupSecretTrialBus(browser);
    const trialId = "b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b4";
    insertBareTrial(db, trialId);
    const refused = await bus.execute(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId: trialId,
      idempotencyKey: "ac3-no-allow",
      payload: { duration_minutes: 60 },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal without ALLOW");
    expect(refused.code).toBe("precondition_failed");
    expect(browser.calls).toHaveLength(0);
    expect(probeTrialMemory(db).mem.providerOperations.size).toBe(0);
  });

  it("AC3: provider.request_operation on a non-REQUESTED trial refuses without a port call", async () => {
    const browser = new FakeBrowserPort({
      outcome: "SUCCEEDED",
      detail: "browser: ok",
      externalRef: "ext-ac3c",
    });
    const { db, bus } = setupSecretTrialBus(browser);
    const trialId = await requestSecretTrial(bus, "AC3 Active Trial");
    // FASE5-S6-FIX2 (SPEC §41): ACTIVE is terminalized where the
    // dispatcher terminalizes it — through the shared applier, with no
    // I/O. The refusal asserts below are unchanged.
    const parked = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", { trialId });
    if (!parked.ok) throw new Error(`expected queue: ${dumped(parked)}`);
    const { ctx } = probeTrialMemory(db);
    const activated = await applyTrialProvisionOutcome(ctx, {
      operationId: parked.data.operationId,
      trialId,
      raw: { outcome: "SUCCEEDED", detail: "browser: ok", externalRef: "ext-ac3c" },
      trialReadback: satisfiedReadback("ext-ac3c"),
    });
    expect(activated?.trialStatus).toBe("ACTIVE");
    expect(probeTrialMemory(db).mem.trials.get(trialId)?.lifecycleStatus).toBe("ACTIVE");
    const callsBefore = browser.calls.length;
    const { mem: ac3Mem } = probeTrialMemory(db);
    const opsBefore = ac3Mem.providerOperations.size;
    const refused = await bus.execute(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId: trialId,
      idempotencyKey: "ac3-active-trial",
      payload: { duration_minutes: 60 },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal for a non-REQUESTED trial");
    expect(refused.code).toBe("precondition_failed");
    expect(browser.calls).toHaveLength(callsBefore);
    expect(ac3Mem.providerOperations.size).toBe(opsBefore);
  });
});

describe("FASE5-S6 trial readback postcondition gate (SPEC §25/§18, proveniência real com fakes)", () => {
  function setupSecretTrialBusWithReadback(
    browser: FakeBrowserPort,
    trialReadbackPort: FakeTrialReadback | TrialReadbackResult,
  ): { db: MemoryDb; bus: CommandBus; readback: FakeTrialReadback | null } {
    const db = new MemoryDb();
    seedTrialAccount(db);
    markTrialGateAvailable(db);
    const readback = trialReadbackPort instanceof FakeTrialReadback ? trialReadbackPort : null;
    const snapshot = trialReadbackPort instanceof FakeTrialReadback ? null : trialReadbackPort;
    const port: FakeTrialReadback = readback ?? {
      readTrialCustomer: async () => snapshot as TrialReadbackResult,
    } as unknown as FakeTrialReadback;
    const bus = new CommandBus(db);
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    registerTrialCommands(bus, {
      opsPort: browser,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      trialDisposableAccountId: TRIAL_DISPOSABLE_ACCOUNT_ID,
      trialReadbackPort: port as FakeTrialReadback,
    });
    registerProviderCommands(bus, {
      opsPort: browser,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      trialDisposableAccountId: TRIAL_DISPOSABLE_ACCOUNT_ID,
      trialReadbackPort: port as FakeTrialReadback,
    });
    return { db, bus, readback };
  }

  function successBrowser(externalRef: string): FakeBrowserPort {
    return new FakeBrowserPort({ outcome: "SUCCEEDED", detail: "browser: ok", externalRef });
  }

  it("AC1 (gate): satisfied readback → ACTIVE + binding + KNOWN_APPLIED + evidência sanitizada, sem re-send", async () => {
    const browser = successBrowser("ext-s6-happy");
    const readback = new FakeTrialReadback("satisfied");
    const { db, bus } = setupSecretTrialBusWithReadback(browser, readback);
    const trialId = await requestSecretTrial(bus, "S6 Happy Trial");
    const provisioned = await bus.execute<{ id: string; status: string; operationId: string; effectUncertain: boolean }>(
      actor(),
      "trial.begin_provisioning",
      { trialId },
    );
    expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING", effectUncertain: true } });
    if (!provisioned.ok) throw new Error("expected PROVISIONING queue");
    // FASE5-S6-FIX2 (SPEC §41): the bus only queues — zero port calls and
    // zero readback traffic inside the command transaction. The gate runs
    // where the durable dispatcher runs it: one bounded READ_CUSTOMER
    // consult whose sanitized result decides in the applier (no I/O there).
    expect(browser.calls).toHaveLength(0);
    expect(readback.queries).toHaveLength(0);
    const { mem, ctx } = probeTrialMemory(db);
    const snapshot = await readback.readTrialCustomer({
      tenantId: TENANT,
      operationId: provisioned.data.operationId,
      trialId,
      providerAccountId: TRIAL_DISPOSABLE_ACCOUNT_ID,
      externalRef: "ext-s6-happy",
    });
    // Exactly one READ_CUSTOMER: no re-send in any branch.
    expect(readback.queries).toHaveLength(1);
    expect(readback.queries[0]).toMatchObject({ trialId, externalRef: "ext-s6-happy" });
    const applied = await applyTrialProvisionOutcome(ctx, {
      operationId: provisioned.data.operationId,
      trialId,
      raw: { outcome: "SUCCEEDED", detail: "browser: ok", externalRef: "ext-s6-happy" },
      trialReadback: snapshot,
    });
    expect(applied).toMatchObject({ status: "SUCCEEDED", trialStatus: "ACTIVE", effectCertainty: "KNOWN_APPLIED" });
    expect(browser.calls).toHaveLength(0);
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("ACTIVE");
    const op = mem.providerOperations.get(provisioned.data.operationId);
    expect(op?.status).toBe("SUCCEEDED");
    expect(op?.effectCertainty).toBe("KNOWN_APPLIED");
    // §30: binding written once, trial correlated.
    expect(mem.providerBindings).toHaveLength(1);
    expect(mem.providerBindings[0]).toMatchObject({ entityType: "trial", entityId: trialId });
    expect(mem.providerBindings[0]?.externalId).toBe(fakeTrialExternalId(trialId));
    expect(mem.trials.get(trialId)?.providerBindingId).toBe(mem.providerBindings[0]?.id);
    // §31: sanitized evidence only — fixed codes/ids, no raw payload.
    expect(mem.providerEvidence).toHaveLength(1);
    const evidence = mem.providerEvidence[0];
    expect(evidence).toMatchObject({ operationId: provisioned.data.operationId, evidenceType: "TRIAL_READBACK_POSTCONDITION" });
    expect(evidence?.structured).toMatchObject({ readback: "conclusive", postcondition: "satisfied" });
    expect(dumped(evidence?.structured)).not.toContain("fake:conclusive");
    expect(dumped(evidence?.structured)).not.toContain("browser: ok");
    expect(dumped({ op, events: db.txFor(TENANT).events })).not.toContain("infisical://");
  });

  it.each([
    ["not-trial", "not_trial"],
    ["expired", "expires_at_past"],
    ["missing-id", "external_id_missing"],
    ["missing-customer", "customer_missing"],
  ] as const)(
    "AC2 (gate): readback %s → HUMAN_REQUIRED + POSTCONDITION_MISMATCH (%s), trial nunca ACTIVE, sem re-send",
    async (mode, reason) => {
      const browser = successBrowser(`ext-s6-${mode}`);
      const readback = new FakeTrialReadback(mode);
      const { db, bus } = setupSecretTrialBusWithReadback(browser, readback);
      const trialId = await requestSecretTrial(bus, `S6 Violated ${mode}`);
      const provisioned = await bus.execute<{ status: string; operationId: string; effectUncertain: boolean }>(
        actor(),
        "trial.begin_provisioning",
        { trialId },
      );
      expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING", effectUncertain: true } });
      if (!provisioned.ok) throw new Error("expected PROVISIONING queue");
      // FASE5-S6-FIX2 (SPEC §41): the bus only queues — the violated
      // postcondition below is decided where the dispatcher decides it.
      expect(browser.calls).toHaveLength(0);
      const { mem, ctx } = probeTrialMemory(db);
      const snapshot = await readback.readTrialCustomer({
        tenantId: TENANT,
        operationId: provisioned.data.operationId,
        trialId,
        providerAccountId: TRIAL_DISPOSABLE_ACCOUNT_ID,
        externalRef: `ext-s6-${mode}`,
      });
      expect(readback.queries).toHaveLength(1);
      const applied = await applyTrialProvisionOutcome(ctx, {
        operationId: provisioned.data.operationId,
        trialId,
        raw: { outcome: "SUCCEEDED", detail: "browser: ok", externalRef: `ext-s6-${mode}` },
        trialReadback: snapshot,
      });
      expect(applied).toMatchObject({ status: "HUMAN_REQUIRED", effectCertainty: "UNKNOWN" });
      expect(browser.calls).toHaveLength(0);
      expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
      const op = mem.providerOperations.get(provisioned.data.operationId);
      expect(op?.status).toBe("HUMAN_REQUIRED");
      expect(op?.effectCertainty).toBe("UNKNOWN");
      expect(op?.resultSummary).toMatchObject({ error_code: "POSTCONDITION_MISMATCH", postcondition: reason });
      const attempts = mem.providerAttempts.filter((a) => a.operationId === provisioned.data.operationId);
      expect(attempts.map((a) => a.errorCode)).toContain("POSTCONDITION_MISMATCH");
      // Never SUCCEEDED/ACTIVE, no binding, no activation event.
      expect(mem.providerBindings).toHaveLength(0);
      expect(mem.trials.get(trialId)?.providerBindingId).toBeNull();
      const types = db.txFor(TENANT).events.map((e) => e.event_type);
      expect(types).not.toContain("trial.activated.v1");
      expect(types).not.toContain("provider.operation_succeeded.v1");
    },
  );

  it("AC2 (gate): expires_at inválida (lixo) → HUMAN_REQUIRED + POSTCONDITION_MISMATCH", async () => {
    const browser = successBrowser("ext-s6-garbage-expiry");
    const { db, bus } = setupSecretTrialBusWithReadback(browser, {
      conclusive: true,
      customer: { exists: true, externalId: "ext-garbage", isTrial: true, expiresAt: "not-a-date" },
      evidence: "test:garbage-expiry",
    });
    const trialId = await requestSecretTrial(bus, "S6 Garbage Expiry");
    const provisioned = await bus.execute<{ status: string; operationId: string }>(actor(), "trial.begin_provisioning", {
      trialId,
    });
    expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING" } });
    // FASE5-S6-FIX2 (SPEC §41): the bus only queues — zero port calls.
    expect(browser.calls).toHaveLength(0);
    if (!provisioned.ok) throw new Error("expected PROVISIONING queue");
    const { mem, ctx } = probeTrialMemory(db);
    const applied = await applyTrialProvisionOutcome(ctx, {
      operationId: provisioned.data.operationId,
      trialId,
      raw: { outcome: "SUCCEEDED", detail: "browser: ok", externalRef: "ext-garbage" },
      trialReadback: {
        conclusive: true,
        customer: { exists: true, externalId: "ext-garbage", isTrial: true, expiresAt: "not-a-date" },
        evidence: "test:garbage-expiry",
      },
    });
    expect(applied).toMatchObject({ status: "HUMAN_REQUIRED" });
    const op = mem.providerOperations.get(provisioned.data.operationId);
    expect(op?.status).toBe("HUMAN_REQUIRED");
    expect(op?.resultSummary).toMatchObject({ error_code: "POSTCONDITION_MISMATCH", postcondition: "expires_at_invalid" });
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
    expect(mem.providerBindings).toHaveLength(0);
  });

  it("AC3 (gate): readback inconclusivo → VERIFYING/UNKNOWN; reconcile agenda (sem I/O em-tx, sem re-send)", async () => {
    const browser = successBrowser("ext-s6-inconclusive");
    const readback = new FakeTrialReadback("inconclusive");
    const { db, bus } = setupSecretTrialBusWithReadback(browser, readback);
    const trialId = await requestSecretTrial(bus, "S6 Inconclusive Trial");
    const provisioned = await bus.execute<{ status: string; operationId: string; effectUncertain: boolean }>(
      actor(),
      "trial.begin_provisioning",
      { trialId },
    );
    expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING", effectUncertain: true } });
    if (!provisioned.ok) throw new Error("expected PROVISIONING queue");
    // FASE5-S6-FIX2 (SPEC §41): the bus only queues — zero port calls and
    // zero readback traffic inline. Absent readback decides VERIFYING where
    // the dispatcher decides it (absent ≡ inconclusive downstream).
    expect(browser.calls).toHaveLength(0);
    expect(readback.queries).toHaveLength(0);
    const { mem, ctx } = probeTrialMemory(db);
    const parked = await applyTrialProvisionOutcome(ctx, {
      operationId: provisioned.data.operationId,
      trialId,
      raw: { outcome: "SUCCEEDED", detail: "browser: ok", externalRef: "ext-s6-inconclusive" },
      trialReadback: null,
    });
    expect(parked).toMatchObject({ status: "VERIFYING", trialStatus: "PROVISIONING", effectCertainty: "UNKNOWN" });
    const op = mem.providerOperations.get(provisioned.data.operationId);
    expect(op?.status).toBe("VERIFYING");
    expect(op?.effectCertainty).toBe("UNKNOWN");
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
    expect(mem.providerBindings).toHaveLength(0);
    const callsAfterSend = browser.calls.length;
    const readbackQueriesBefore = readback.queries.length;
    const attemptsBefore = mem.providerAttempts.filter((a) => a.operationId === provisioned.data.operationId).length;
    const eventsBefore = db.txFor(TENANT).events.length;
    // FASE5-FIX4-N1 (SPEC §12/§41): reconcile of a VERIFYING real trial
    // only SCHEDULES — zero port traffic, zero writes. The S3 convergence
    // (HUMAN_REQUIRED) runs in the durable dispatcher recovery outside any
    // transaction (proven on Postgres by the reconcileOnce suite).
    const reconciled = await bus.execute<{ status: string; effectCertainty: string; reconciliation?: string }>(
      actor(),
      "provider.reconcile",
      {
        operationId: provisioned.data.operationId,
      },
    );
    expect(reconciled).toMatchObject({
      ok: true,
      data: { status: "VERIFYING", effectCertainty: "UNKNOWN", reconciliation: "scheduled" },
    });
    expect(browser.calls).toHaveLength(callsAfterSend);
    expect(readback.queries).toHaveLength(readbackQueriesBefore);
    expect(mem.providerOperations.get(provisioned.data.operationId)?.status).toBe("VERIFYING");
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
    expect(mem.providerBindings).toHaveLength(0);
    expect(mem.providerAttempts.filter((a) => a.operationId === provisioned.data.operationId)).toHaveLength(
      attemptsBefore,
    );
    expect(db.txFor(TENANT).events).toHaveLength(eventsBefore);
  });

  it("AC3 (gate): readback ausente → VERIFYING/UNKNOWN (throw/timeout viram nulo no budget), sem re-enviar", async () => {
    const browser = successBrowser("ext-s6-throw");
    const { db, bus } = setupSecretTrialBusWithReadback(browser, new FakeTrialReadback("throw"));
    const trialId = await requestSecretTrial(bus, "S6 Throw Trial");
    const provisioned = await bus.execute<{ status: string; operationId: string }>(actor(), "trial.begin_provisioning", {
      trialId,
    });
    expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING" } });
    // FASE5-S6-FIX2 (SPEC §35+§41): the throwing port is never consulted
    // inline — zero calls. The throw/timeout → null conversion is proven
    // by `raceTrialReadback` unit tests + the dispatcher hang integration
    // test; the applier below proves null → VERIFYING (never a re-send).
    expect(browser.calls).toHaveLength(0);
    if (!provisioned.ok) throw new Error("expected PROVISIONING queue");
    const { mem, ctx } = probeTrialMemory(db);
    const parked = await applyTrialProvisionOutcome(ctx, {
      operationId: provisioned.data.operationId,
      trialId,
      raw: { outcome: "SUCCEEDED", detail: "browser: ok", externalRef: "ext-s6-throw" },
      trialReadback: null,
    });
    expect(parked).toMatchObject({ status: "VERIFYING", trialStatus: "PROVISIONING", effectCertainty: "UNKNOWN" });
    expect(browser.calls).toHaveLength(0);
    expect(mem.providerOperations.get(provisioned.data.operationId)?.status).toBe("VERIFYING");
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
  });

  it("AC5 (applier): replay do outcome satisfeito não duplica o binding (upsert)", async () => {
    const browser = successBrowser("ext-s6-replay");
    const parkedBus = setupSecretTrialBus(browser);
    process.env["PROVIDER_DISPATCH_MODE"] = "durable";
    let trialId: string;
    let operationId: string;
    try {
      trialId = await requestSecretTrial(parkedBus.bus, "S6 Binding Replay");
      const res = await parkedBus.bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", { trialId });
      if (!res.ok) throw new Error(`durable park failed: ${dumped(res)}`);
      operationId = res.data.operationId;
    } finally {
      delete process.env["PROVIDER_DISPATCH_MODE"];
    }
    const { mem, ctx } = probeTrialMemory(parkedBus.db);
    const input = {
      operationId,
      trialId,
      raw: { outcome: "SUCCEEDED", detail: "x", externalRef: "ext-replay" },
      trialReadback: satisfiedReadback("ext-replay"),
    };
    const first = await applyTrialProvisionOutcome(ctx, input);
    expect(first?.status).toBe("SUCCEEDED");
    expect(mem.providerBindings).toHaveLength(1);
    const bindingId = mem.providerBindings[0]?.id;
    // Replay of the same satisfied outcome: upsert reuses the row, the
    // trial keeps pointing at it, no duplicate binding appears.
    const second = await applyTrialProvisionOutcome(ctx, input);
    expect(second?.status).toBe("SUCCEEDED");
    expect(mem.providerBindings).toHaveLength(1);
    expect(mem.providerBindings[0]?.id).toBe(bindingId);
    expect(mem.trials.get(trialId)?.providerBindingId).toBe(bindingId);
    // Durable park performs zero port calls; the two applier replays below
    // never touch the port either (no re-send on any branch).
    expect(browser.calls).toHaveLength(0);
  });
});

describe("FASE5-FIX4-N1 reconcile of secret-required trial.provision schedules dispatcher recovery (zero in-tx I/O)", () => {
  class ConclusiveGenericReadback implements ProviderReadbackPort {
    constructor(private readonly applied: boolean) {}
    async verify(): Promise<{ effectApplied: boolean; evidence: string; conclusive: boolean }> {
      return { effectApplied: this.applied, evidence: "test:conclusive-generic", conclusive: true };
    }
  }

  function setupReconcileBus(
    browser: FakeBrowserPort,
    generic: ProviderReadbackPort,
    trialRb: FakeTrialReadback,
  ): { db: MemoryDb; bus: CommandBus } {
    const db = new MemoryDb();
    seedTrialAccount(db);
    markTrialGateAvailable(db);
    const bus = new CommandBus(db);
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    registerTrialCommands(bus, {
      opsPort: browser,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      trialDisposableAccountId: TRIAL_DISPOSABLE_ACCOUNT_ID,
      trialReadbackPort: trialRb,
    });
    registerProviderCommands(bus, {
      opsPort: browser,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      trialDisposableAccountId: TRIAL_DISPOSABLE_ACCOUNT_ID,
      trialReadbackPort: trialRb,
      readbackPort: generic,
    });
    return { db, bus };
  }

  async function parkVerifyingTrial(
    bus: CommandBus,
    db: MemoryDb,
    canonicalName: string,
  ): Promise<{ trialId: string; operationId: string }> {
    const trialId = await requestSecretTrial(bus, canonicalName);
    const provisioned = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", { trialId });
    if (!provisioned.ok) throw new Error(`durable park failed: ${dumped(provisioned)}`);
    const { operationId } = provisioned.data;
    // Simulate the crash window: the send happened, the readback gave no
    // proof, so the dispatcher parked VERIFYING/UNKNOWN (no re-send).
    const { ctx } = probeTrialMemory(db);
    const parked = await applyTrialProvisionOutcome(ctx, {
      operationId,
      trialId,
      raw: { outcome: "SUCCEEDED", detail: "browser: ok", externalRef: "ext-r3" },
      trialReadback: null,
    });
    expect(parked).toMatchObject({ status: "VERIFYING", trialStatus: "PROVISIONING" });
    return { trialId, operationId };
  }

  it("VERIFYING real trial → reconciliation scheduled: zero port traffic, zero writes, row untouched", async () => {
    const browser = new FakeBrowserPort();
    const trialRb = new FakeTrialReadback("satisfied");
    const { db, bus } = setupReconcileBus(browser, new ConclusiveGenericReadback(true), trialRb);
    const { trialId, operationId } = await parkVerifyingTrial(bus, db, "R3 Satisfied Trial");
    // Even with conclusive doubles attached, reconcile consults NOTHING:
    // the R3 gate runs in the dispatcher recovery outside any transaction.
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
    const { mem } = probeTrialMemory(db);
    expect(mem.providerOperations.get(operationId)?.status).toBe("VERIFYING");
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
    expect(mem.providerBindings).toHaveLength(0);
    expect(browser.calls).toHaveLength(0);
    expect(trialRb.queries).toHaveLength(0);
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).not.toContain("trial.activated.v1");
  });

  it("repeat scheduled reconcile writes nothing (no attempt, no event, same row)", async () => {
    const browser = new FakeBrowserPort();
    const { db, bus } = setupReconcileBus(browser, new ConclusiveGenericReadback(true), new FakeTrialReadback("satisfied"));
    const { operationId } = await parkVerifyingTrial(bus, db, "R3 Repeat Trial");
    const first = await bus.execute<{ status: string; reconciliation?: string }>(actor(), "provider.reconcile", {
      operationId,
    });
    expect(first).toMatchObject({ ok: true, data: { status: "VERIFYING", reconciliation: "scheduled" } });
    const { mem } = probeTrialMemory(db);
    const attemptsBefore = mem.providerAttempts.filter((a) => a.operationId === operationId).length;
    const eventsBefore = db.txFor(TENANT).events.length;
    const rowBefore = dumped(mem.providerOperations.get(operationId));
    const second = await bus.execute<{ status: string; reconciliation?: string }>(actor(), "provider.reconcile", {
      operationId,
    });
    expect(second).toMatchObject({ ok: true, data: { status: "VERIFYING", reconciliation: "scheduled" } });
    expect(mem.providerAttempts.filter((a) => a.operationId === operationId)).toHaveLength(attemptsBefore);
    expect(db.txFor(TENANT).events).toHaveLength(eventsBefore);
    expect(dumped(mem.providerOperations.get(operationId))).toBe(rowBefore);
  });

describe("FASE5-FIX4-N1/N2 decideVerifyingTrialReconcile: pure R3 branch contract (no I/O)", () => {
  it("generic inconclusive → converge-human-required (never a re-send, never VERIFYING rewrite)", () => {
    expect(
      decideVerifyingTrialReconcile({ conclusive: false, effectApplied: false }, null),
    ).toEqual({ kind: "converge-human-required" });
  });

  it("generic conclusive NOT_APPLIED → fail-not-applied (trial readback never consulted)", () => {
    expect(
      decideVerifyingTrialReconcile(
        { conclusive: true, effectApplied: false },
        satisfiedReadback("ext-not-applied"),
      ),
    ).toEqual({ kind: "fail-not-applied" });
  });

  it("generic conclusive APPLIED + inconclusive trial readback → converge-human-required", () => {
    expect(
      decideVerifyingTrialReconcile({ conclusive: true, effectApplied: true }, {
        conclusive: false,
        customer: null,
        evidence: "test:inconclusive",
      }),
    ).toEqual({ kind: "converge-human-required" });
  });

  it("N2: generic conclusive APPLIED + conclusive trial readback WITHOUT customer → converge-human-required (no VERIFYING self-loop)", () => {
    expect(
      decideVerifyingTrialReconcile({ conclusive: true, effectApplied: true }, {
        conclusive: true,
        customer: null,
        evidence: "test:null-customer",
      }),
    ).toEqual({ kind: "converge-human-required" });
    expect(
      decideVerifyingTrialReconcile({ conclusive: true, effectApplied: true }, null),
    ).toEqual({ kind: "converge-human-required" });
  });

  it("generic conclusive APPLIED + conclusive trial readback WITH customer → gate-succeeded (applier owns postconditions)", () => {
    const trialReadback = satisfiedReadback("ext-gate");
    expect(decideVerifyingTrialReconcile({ conclusive: true, effectApplied: true }, trialReadback)).toEqual({
      kind: "gate-succeeded",
      trialReadback,
    });
  });
});
});

describe("FASE5-FIX3-R4 S3 convergence is CAS-fenced (loser writes nothing)", () => {
  it("a second concurrent convergence loses silently: no overwrite, no attempts/events", async () => {
    const browser = new FakeBrowserPort();
    const { db, bus } = setupSecretTrialBus(browser);
    const trialId = await requestSecretTrial(bus, "R4 Race Trial");
    const provisioned = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", { trialId });
    if (!provisioned.ok) throw new Error(`durable park failed: ${dumped(provisioned)}`);
    const { operationId } = provisioned.data;
    const { mem, ctx } = probeTrialMemory(db);
    const parked = await applyTrialProvisionOutcome(ctx, {
      operationId,
      trialId,
      raw: { outcome: "SUCCEEDED", detail: "browser: ok", externalRef: "ext-r4" },
      trialReadback: null,
    });
    expect(parked?.status).toBe("VERIFYING");
    const wire = {
      operationId,
      action: "trial.provision",
      entityType: "trial",
      entityId: trialId,
      raw: { outcome: "MANUAL", detail: "reconcile: inconclusive readback", externalRef: null },
    } as const;
    const first = await applySecretPortOutcome(ctx, wire, { expectedStatus: "VERIFYING" });
    expect(first).toMatchObject({ status: "HUMAN_REQUIRED", effectCertainty: "UNKNOWN" });
    const attemptsAfterFirst = mem.providerAttempts.length;
    const eventsAfterFirst = db.txFor(TENANT).events.length;
    // The delayed loser converges over an already-moved row: silent null,
    // zero writes of any kind, no overwrite of the winner.
    const second = await applySecretPortOutcome(ctx, wire, { expectedStatus: "VERIFYING" });
    expect(second).toBeNull();
    expect(mem.providerAttempts.length).toBe(attemptsAfterFirst);
    expect(db.txFor(TENANT).events.length).toBe(eventsAfterFirst);
    expect(mem.providerOperations.get(operationId)?.status).toBe("HUMAN_REQUIRED");
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
  });
});

describe("FASE5-FIX3-R5 observed expiresAt wins on the real path", () => {
  it("activation uses the readback-observed expiry, not the local now+duration", async () => {
    const browser = new FakeBrowserPort({ outcome: "SUCCEEDED", detail: "browser: ok", externalRef: "ext-r5" });
    const { db, bus } = setupSecretTrialBus(browser);
    const trialId = await requestSecretTrial(bus, "R5 Observed Expiry");
    const provisioned = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", { trialId });
    if (!provisioned.ok) throw new Error(`durable park failed: ${dumped(provisioned)}`);
    const { operationId } = provisioned.data;
    // Deliberately different from the local 60min computation: +7 days.
    const observed = new Date(Date.now() + 7 * 24 * 3_600_000);
    const { mem, ctx } = probeTrialMemory(db);
    const applied = await applyTrialProvisionOutcome(ctx, {
      operationId,
      trialId,
      raw: { outcome: "SUCCEEDED", detail: "browser: ok", externalRef: "ext-r5" },
      trialReadback: {
        conclusive: true,
        customer: { exists: true, externalId: "ext-r5-observed", isTrial: true, expiresAt: observed.toISOString() },
        evidence: "test:r5-observed-expiry",
      },
    });
    expect(applied).toMatchObject({ status: "SUCCEEDED", trialStatus: "ACTIVE" });
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("ACTIVE");
    expect(mem.trials.get(trialId)?.expiresAt?.getTime()).toBe(observed.getTime());
    expect(browser.calls).toHaveLength(0);
  });
});

describe("FASE5-FIX3-R6 normalizeTrialExternalId conservative contract", () => {
  it.each([["trial-abc123"], ["ext_1"], ["a:b.c-d_e"], ["X"], ["012345678901234567890123456789012345678901234567890123456789"]])(
    "accepts conservative token %s",
    (token) => {
      expect(normalizeTrialExternalId(token)).toBe(token);
    },
  );

  it.each([
    ["https://panel.example/trial/1"],
    ["op@host.example"],
    ["with space"],
    ["semi;colon"],
    ["slash/id"],
    [""],
    ["   "],
    ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
    ["trai\nling"],
  ])("rejects secret-like or out-of-contract id %s", (token) => {
    expect(normalizeTrialExternalId(token)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(normalizeTrialExternalId(null)).toBeNull();
    expect(normalizeTrialExternalId(123)).toBeNull();
    expect(normalizeTrialExternalId({})).toBeNull();
  });
});

describe("FASE5-FIX3-S1 arbitrary synthetic actions never resume a trial", () => {
  function setupEchoBus(): { db: MemoryDb; bus: CommandBus } {
    const db = new MemoryDb();
    const bus = new CommandBus(db);
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    registerTrialCommands(bus, { opsPort: new EchoProviderOpsAdapter() });
    registerProviderCommands(bus, { opsPort: new EchoProviderOpsAdapter() });
    return { db, bus };
  }

  async function requestEchoTrial(bus: CommandBus, canonicalName: string): Promise<string> {
    const personRes = await bus.execute<{ id: string }>(actor(), "person.register", { canonicalName });
    if (!personRes.ok) throw new Error("person setup failed");
    const trialRes = await bus.execute<{ id: string | null }>(actor(), "trial.request", {
      personId: personRes.data.id,
      durationMinutes: 60,
    });
    if (!trialRes.ok || trialRes.data.id === null) throw new Error("trial setup failed");
    return trialRes.data.id;
  }

  it("an arbitrary synthetic action with entityType=trial does not activate a PROVISIONING trial", async () => {
    const { db, bus } = setupEchoBus();
    const trialId = await requestEchoTrial(bus, "S1 Arbitrary Trial");
    const parked = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", {
      trialId,
      echoOutcome: "unknown",
    });
    if (!parked.ok) throw new Error(`expected VERIFYING park: ${dumped(parked)}`);
    const { mem } = probeTrialMemory(db);
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
    const eventsBefore = db.txFor(TENANT).events.length;
    const res = await bus.execute<{ status: string }>(actor(), "provider.request_operation", {
      action: "arbitrary.noop",
      entityType: "trial",
      entityId: trialId,
      idempotencyKey: "s1-arbitrary-key",
      payload: {},
    });
    expect(res).toMatchObject({ ok: true, data: { status: "SUCCEEDED" } });
    // The synthetic op terminalized, but the trial never moved: no resume,
    // no activation event from an action that is not its provision.
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
    const newTypes = db.txFor(TENANT).events.slice(eventsBefore).map((e) => e.event_type);
    expect(newTypes).not.toContain("trial.activated.v1");
  });

  it("echo trial.provision synthetic still activates (dev convenience preserved)", async () => {
    const { db, bus } = setupEchoBus();
    const trialId = await requestEchoTrial(bus, "S1 Echo Provision Trial");
    const res = await bus.execute<{ status: string }>(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId: trialId,
      idempotencyKey: "s1-echo-provision-key",
      payload: {},
    });
    expect(res).toMatchObject({ ok: true, data: { status: "SUCCEEDED" } });
    const { mem } = probeTrialMemory(db);
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("ACTIVE");
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("trial.activated.v1");
  });
});

describe("FASE5-FIX4-N3 an arbitrary newer op never blocks the provision op resolution", () => {
  function setupEchoBus(): { db: MemoryDb; bus: CommandBus } {
    const db = new MemoryDb();
    const bus = new CommandBus(db);
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    registerTrialCommands(bus, { opsPort: new EchoProviderOpsAdapter() });
    registerProviderCommands(bus, { opsPort: new EchoProviderOpsAdapter() });
    return { db, bus };
  }

  async function parkEchoProvision(bus: CommandBus, canonicalName: string): Promise<{ trialId: string; operationId: string }> {
    const personRes = await bus.execute<{ id: string }>(actor(), "person.register", { canonicalName });
    if (!personRes.ok) throw new Error("person setup failed");
    const trialRes = await bus.execute<{ id: string | null }>(actor(), "trial.request", {
      personId: personRes.data.id,
      durationMinutes: 60,
    });
    if (!trialRes.ok || trialRes.data.id === null) throw new Error("trial setup failed");
    const parked = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", {
      trialId: trialRes.data.id,
      echoOutcome: "unknown",
    });
    if (!parked.ok) throw new Error(`expected VERIFYING park: ${dumped(parked)}`);
    return { trialId: trialRes.data.id, operationId: parked.data.operationId };
  }

  it("reconcile of the provision op A resolves the trial even with a newer arbitrary op B", async () => {
    const { db, bus } = setupEchoBus();
    const { trialId, operationId } = await parkEchoProvision(bus, "N3 Arbitrary Trial");
    // Arbitrary newer op B on the same trial: terminalizes alone, resumes
    // nothing (S1), and must not shadow the provision op.
    const poisoned = await bus.execute<{ status: string }>(actor(), "provider.request_operation", {
      action: "arbitrary.noop",
      entityType: "trial",
      entityId: trialId,
      idempotencyKey: "n3-arbitrary-key",
      payload: {},
    });
    expect(poisoned).toMatchObject({ ok: true, data: { status: "SUCCEEDED" } });
    const { mem } = probeTrialMemory(db);
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");

    process.env["PROVIDER_READBACK_EFFECT"] = "APPLIED";
    try {
      const reconciled = await bus.execute<{ status: string; effectCertainty: string; resumedTrial: boolean }>(
        actor(),
        "provider.reconcile",
        { operationId },
      );
      expect(reconciled).toMatchObject({
        ok: true,
        data: { status: "SUCCEEDED", effectCertainty: "KNOWN_APPLIED", resumedTrial: true },
      });
    } finally {
      delete process.env["PROVIDER_READBACK_EFFECT"];
    }
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("ACTIVE");
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("trial.activated.v1");
  });

  it("resolve of the provision op A resumes the trial even with a newer arbitrary op B", async () => {
    const { db, bus } = setupEchoBus();
    const { trialId, operationId } = await parkEchoProvision(bus, "N3 Resolve Trial");
    const poisoned = await bus.execute<{ status: string }>(actor(), "provider.request_operation", {
      action: "arbitrary.noop",
      entityType: "trial",
      entityId: trialId,
      idempotencyKey: "n3-arbitrary-resolve-key",
      payload: {},
    });
    expect(poisoned).toMatchObject({ ok: true, data: { status: "SUCCEEDED" } });

    const resolved = await bus.execute<{ status: string; effectCertainty: string; resumedTrial: boolean }>(
      actor(),
      "provider.resolve_operation",
      { operationId, outcome: "SUCCEEDED" },
    );
    expect(resolved).toMatchObject({
      ok: true,
      data: { status: "SUCCEEDED", effectCertainty: "KNOWN_APPLIED", resumedTrial: true },
    });
    const { mem } = probeTrialMemory(db);
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("ACTIVE");
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("trial.activated.v1");
  });

  it("a newer trial.provision op still supersedes: stale A resolves without resume", async () => {
    const { db, bus } = setupEchoBus();
    const { trialId, operationId } = await parkEchoProvision(bus, "N3 Superseded Trial");
    const { mem, ctx } = probeTrialMemory(db);
    const rowA = mem.providerOperations.get(operationId);
    if (rowA === undefined) throw new Error("provision op A missing");
    // Arrange a NEWER provision op B for the same trial directly (the
    // command entry refuses a second intent while PROVISIONING): B only
    // needs to exist and be newer to supersede A.
    const opB = await insertProviderOperation(ctx, {
      providerAccountId: rowA.providerAccountId,
      action: "trial.provision",
      entityType: "trial",
      entityId: trialId,
      idempotencyKey: "n3-second-provision-key",
      requestedPayload: {},
      adapterVersion: "echo-v1",
    });
    mem.providerOperations.get(opB.id)!.requestedAt = new Date(rowA.requestedAt.getTime() + 1000);
    // The stale provision op A terminalizes but must not resume: the trial
    // is owned by the newer provision op now.
    const resolved = await bus.execute<{ status: string; resumedTrial: boolean }>(
      actor(),
      "provider.resolve_operation",
      { operationId, outcome: "FAILED" },
    );
    expect(resolved).toMatchObject({ ok: true, data: { status: "FAILED", resumedTrial: false } });
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).not.toContain("trial.activated.v1");
  });
});

describe("FASE5-FIX4-N4 resolve UNKNOWN is fenced on the observed status (loser never overwrites convergence)", () => {
  function setupEchoBus(): { db: MemoryDb; bus: CommandBus } {
    const db = new MemoryDb();
    const bus = new CommandBus(db);
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    registerTrialCommands(bus, { opsPort: new EchoProviderOpsAdapter() });
    registerProviderCommands(bus, { opsPort: new EchoProviderOpsAdapter() });
    return { db, bus };
  }

  async function parkEchoProvision(bus: CommandBus, canonicalName: string): Promise<{ trialId: string; operationId: string }> {
    const personRes = await bus.execute<{ id: string }>(actor(), "person.register", { canonicalName });
    if (!personRes.ok) throw new Error("person setup failed");
    const trialRes = await bus.execute<{ id: string | null }>(actor(), "trial.request", {
      personId: personRes.data.id,
      durationMinutes: 60,
    });
    if (!trialRes.ok || trialRes.data.id === null) throw new Error("trial setup failed");
    const parked = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", {
      trialId: trialRes.data.id,
      echoOutcome: "unknown",
    });
    if (!parked.ok) throw new Error(`expected VERIFYING park: ${dumped(parked)}`);
    return { trialId: trialRes.data.id, operationId: parked.data.operationId };
  }

  it("fenced updateProviderOperation returns null and writes nothing when the row status moved", async () => {
    const { db, bus } = setupEchoBus();
    const { operationId } = await parkEchoProvision(bus, "N4 Fence Store Trial");
    const { mem, ctx } = probeTrialMemory(db);
    expect(mem.providerOperations.get(operationId)?.status).toBe("VERIFYING");
    // A matching fence still writes (sanity: fenced winners proceed).
    const winner = await updateProviderOperation(
      ctx,
      operationId,
      { status: "VERIFYING", effectCertainty: "UNKNOWN", resultSummary: { resolve_note: "n4-winner" } },
      { expectedStatuses: ["VERIFYING"] },
    );
    expect(winner?.status).toBe("VERIFYING");
    expect(winner?.resultSummary).toEqual({ resolve_note: "n4-winner" });
    // The row converges elsewhere (reconcile terminalizes VERIFYING).
    const converged = await updateProviderOperation(ctx, operationId, {
      status: "SUCCEEDED",
      effectCertainty: "KNOWN_APPLIED",
      completed: true,
    });
    expect(converged?.status).toBe("SUCCEEDED");
    const rowBefore = dumped(mem.providerOperations.get(operationId));
    // A stale writer fenced on the old VERIFYING observation loses: null,
    // zero mutation of any kind.
    const loser = await updateProviderOperation(
      ctx,
      operationId,
      { status: "VERIFYING", effectCertainty: "UNKNOWN", resultSummary: { resolve_note: "n4-stale" } },
      { expectedStatuses: ["VERIFYING"] },
    );
    expect(loser).toBeNull();
    expect(dumped(mem.providerOperations.get(operationId))).toBe(rowBefore);
    // An unfenced writer keeps the historical unconditional semantics.
    const unfenced = await updateProviderOperation(ctx, operationId, {
      status: "VERIFYING",
      effectCertainty: "UNKNOWN",
    });
    expect(unfenced?.status).toBe("VERIFYING");
  });

  it("resolve UNKNOWN loses the race instead of overwriting convergence: precondition_failed, no attempt, row untouched", async () => {
    const { db, bus } = setupEchoBus();
    const { operationId } = await parkEchoProvision(bus, "N4 Resolve Race Trial");
    const { mem } = probeTrialMemory(db);
    const attemptsBefore = mem.providerAttempts.filter((a) => a.operationId === operationId).length;
    const eventsBefore = db.txFor(TENANT).events.length;
    // Interleave a concurrent `reconcileOnce` convergence (VERIFYING →
    // SUCCEEDED) between the resolve's read and its fenced write — the
    // same race the CAS-fenced R4 convergence test drives, from the other
    // side of the interleaving.
    const original = trialStore.updateProviderOperation;
    const spy = vi.spyOn(trialStore, "updateProviderOperation").mockImplementationOnce(async (ctx, opId, patch, fence) => {
      const raced = mem.providerOperations.get(opId);
      if (raced !== undefined) {
        raced.status = "SUCCEEDED";
        raced.effectCertainty = "KNOWN_APPLIED";
        raced.completedAt = new Date();
        raced.resultSummary = { reconcile_outcome: "APPLIED", effect_applied: true };
      }
      return original(ctx, opId, patch, fence);
    });
    try {
      const resolved = await bus.execute(actor(), "provider.resolve_operation", {
        operationId,
        outcome: "UNKNOWN",
        note: "n4-stale-resolve",
      });
      expect(resolved).toMatchObject({
        ok: false,
        code: "precondition_failed",
      });
      if (resolved.ok) throw new Error("expected the stale resolve to lose");
      expect(resolved.message).toContain("operation changed concurrently (observed VERIFYING)");
    } finally {
      spy.mockRestore();
    }
    // The convergence survived: no VERIFYING overwrite, no stale merged
    // resolve_note, no attempt, no event.
    expect(mem.providerOperations.get(operationId)?.status).toBe("SUCCEEDED");
    expect(mem.providerOperations.get(operationId)?.resultSummary).toEqual({
      reconcile_outcome: "APPLIED",
      effect_applied: true,
    });
    expect(mem.providerAttempts.filter((a) => a.operationId === operationId)).toHaveLength(attemptsBefore);
    expect(db.txFor(TENANT).events).toHaveLength(eventsBefore);
  });

  it("resolve UNKNOWN happy path still parks VERIFYING and returns resumedTrial:false", async () => {
    const { db, bus } = setupEchoBus();
    const { operationId } = await parkEchoProvision(bus, "N4 Resolve Happy Trial");
    const { mem } = probeTrialMemory(db);
    const attemptsBefore = mem.providerAttempts.filter((a) => a.operationId === operationId).length;
    const resolved = await bus.execute<{ status: string; effectCertainty: string; resumedTrial: boolean }>(
      actor(),
      "provider.resolve_operation",
      { operationId, outcome: "UNKNOWN", note: "n4-park" },
    );
    expect(resolved).toMatchObject({
      ok: true,
      data: { status: "VERIFYING", effectCertainty: "UNKNOWN", resumedTrial: false },
    });
    expect(mem.providerOperations.get(operationId)?.status).toBe("VERIFYING");
    expect(mem.providerOperations.get(operationId)?.resultSummary).toMatchObject({ resolve_note: "n4-park" });
    const attempts = mem.providerAttempts.filter((a) => a.operationId === operationId);
    expect(attempts).toHaveLength(attemptsBefore + 1);
    expect(attempts[attempts.length - 1]).toMatchObject({ status: "VERIFYING", errorCode: "EFFECT_UNKNOWN" });
  });
});
