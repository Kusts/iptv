import { beforeEach, describe, expect, it } from "vitest";
import type { CommandActor } from "@iptv/domain";
import { CommandBus, type CommandHandlerContext } from "../src/commands/command-bus.js";
import { registerCrmCommands } from "../src/crm/crm.commands.js";
import { registerHumanReviewCommands } from "../src/human-review/human-review.commands.js";
import { registerPolicyCommands } from "../src/policy/policy.commands.js";
import { registerTrialCommands } from "../src/trial/trial.commands.js";
import { registerProviderCommands } from "../src/provider/provider.commands.js";
import { EchoProviderOpsAdapter } from "../src/provider/provider-port.js";
import type { AdapterResult, ProviderOperationRequest, ProviderOpsPort } from "../src/provider/provider-port.js";
import {
  TRIAL_CAPABILITY_KEY,
  decideTrialDispatchGate,
  isTrialCapabilitySatisfied,
  trialDisposableAccountIdFromEnv,
} from "../src/provider/provider-secret-gate.js";
import { trialMemoryOf } from "../src/trial/trial-store.js";
import { FakeTrialReadback } from "./fakes/trial-readback-fake.js";
import { MemoryDb } from "./fakes/memory-fakes.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const VALID_REF = "infisical://production/BROWSER_WORKER_KEY";
const SEEDED_ACCOUNT_ID = "a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a9";
const OTHER_ACCOUNT_ID = "b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b8b8";

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
  if (!mem.providerAccounts.has(SEEDED_ACCOUNT_ID)) {
    mem.providerAccounts.set(SEEDED_ACCOUNT_ID, {
      id: SEEDED_ACCOUNT_ID,
      tenantId: TENANT,
      providerId,
      name: "seeded trial account",
      secretRef: "wave4://no-real-credential",
    });
  }
}

function setCapability(db: MemoryDb, key: string, availability: string): void {
  db.txFor(TENANT).capabilities.set(key, {
    key,
    ownerContext: "provider",
    availability,
    certificationStatus: availability === "AVAILABLE" ? "CERTIFIED" : "UNCERTIFIED",
    riskLevel: "HIGH",
    mvpPhase: "W0",
    manualEquivalent: "manual",
    policyFamily: "provider-integration",
    degradation: "test gate",
    permissions: [],
  });
}

function setupGateBus(
  browser: FakeBrowserPort,
  opts: { trialAvailability?: string; globalAvailability?: string; designatedAccountId?: string } = {},
): { db: MemoryDb; bus: CommandBus } {
  const db = new MemoryDb();
  seedTrialAccount(db);
  if (opts.trialAvailability !== undefined) {
    setCapability(db, TRIAL_CAPABILITY_KEY, opts.trialAvailability);
  }
  if (opts.globalAvailability !== undefined) {
    setCapability(db, "provider.cinevision", opts.globalAvailability);
  }
  const bus = new CommandBus(db);
  registerHumanReviewCommands(bus);
  registerPolicyCommands(bus);
  registerCrmCommands(bus);
  const gateDeps = {
    opsPort: browser,
    secretsPort: CONFIGURED_SECRETS_PORT,
    loadSecretRef: async () => VALID_REF,
    ...(opts.designatedAccountId !== undefined ? { trialDisposableAccountId: opts.designatedAccountId } : {}),
    // FASE5-S6: SUCCEEDED on the secret path gates on a conclusive
    // readback — the suite default satisfies it.
    trialReadbackPort: new FakeTrialReadback(),
  };
  registerTrialCommands(bus, gateDeps);
  registerProviderCommands(bus, gateDeps);
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

beforeEach(() => {
  delete process.env["PROVIDER_DISPATCH_MODE"];
  delete process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"];
});

describe("FASE5-S4S5 trial gate (pure)", () => {
  it("trial capability requires a strict AVAILABLE", () => {
    expect(isTrialCapabilitySatisfied(null)).toBe(false);
    expect(isTrialCapabilitySatisfied({ availability: "UNAVAILABLE" })).toBe(false);
    expect(isTrialCapabilitySatisfied({ availability: "DEGRADED" })).toBe(false);
    expect(isTrialCapabilitySatisfied({ availability: "available" })).toBe(false);
    expect(isTrialCapabilitySatisfied({ availability: "AVAILABLE" })).toBe(true);
  });

  it("designation reads the env, blank means absent", () => {
    expect(trialDisposableAccountIdFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(trialDisposableAccountIdFromEnv({ PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID: "" } as unknown as NodeJS.ProcessEnv)).toBeUndefined();
    expect(trialDisposableAccountIdFromEnv({ PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID: "   " } as unknown as NodeJS.ProcessEnv)).toBeUndefined();
    expect(
      trialDisposableAccountIdFromEnv({ PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID: ` ${SEEDED_ACCOUNT_ID} ` } as unknown as NodeJS.ProcessEnv),
    ).toBe(SEEDED_ACCOUNT_ID);
  });

  it("non-trial actions are never governed by the trial gate", () => {
    expect(
      decideTrialDispatchGate({
        action: "subscription.provision",
        trialCapability: null,
        designatedAccountId: undefined,
        providerAccountId: SEEDED_ACCOUNT_ID,
      }),
    ).toBe("allow");
    expect(
      decideTrialDispatchGate({
        action: "app_license.purchase",
        trialCapability: { availability: "UNAVAILABLE" },
        designatedAccountId: OTHER_ACCOUNT_ID,
        providerAccountId: SEEDED_ACCOUNT_ID,
      }),
    ).toBe("allow");
  });

  it("trial.provision matrix: capability first, then exact designation", () => {
    const base = { action: "trial.provision", providerAccountId: SEEDED_ACCOUNT_ID };
    expect(decideTrialDispatchGate({ ...base, trialCapability: null, designatedAccountId: SEEDED_ACCOUNT_ID })).toBe(
      "blocked_capability",
    );
    expect(
      decideTrialDispatchGate({ ...base, trialCapability: { availability: "UNAVAILABLE" }, designatedAccountId: SEEDED_ACCOUNT_ID }),
    ).toBe("blocked_capability");
    expect(
      decideTrialDispatchGate({ ...base, trialCapability: { availability: "DEGRADED" }, designatedAccountId: SEEDED_ACCOUNT_ID }),
    ).toBe("blocked_capability");
    expect(
      decideTrialDispatchGate({ ...base, trialCapability: { availability: "AVAILABLE" }, designatedAccountId: undefined }),
    ).toBe("blocked_designation");
    expect(
      decideTrialDispatchGate({ ...base, trialCapability: { availability: "AVAILABLE" }, designatedAccountId: OTHER_ACCOUNT_ID }),
    ).toBe("blocked_designation");
    expect(
      decideTrialDispatchGate({ ...base, trialCapability: { availability: "AVAILABLE" }, designatedAccountId: SEEDED_ACCOUNT_ID }),
    ).toBe("allow");
  });
});

describe("FASE5-S4S5 trial.begin_provisioning secret branch (AC2/AC3/AC4)", () => {
  it("AC2: missing trial capability fails closed even with the GLOBAL row AVAILABLE", async () => {
    const browser = new FakeBrowserPort();
    const { db, bus } = setupGateBus(browser, { globalAvailability: "AVAILABLE", designatedAccountId: SEEDED_ACCOUNT_ID });
    const trialId = await requestEligibleTrial(bus, "AC2 no trial cap");
    const eventsBefore = db.txFor(TENANT).events.length;
    const result = await bus.execute(actor(), "trial.begin_provisioning", { trialId });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("must fail closed");
    expect(result.code).toBe("precondition_failed");
    expect(dumped(result)).toContain("trial capability unavailable");
    expect(browser.calls).toHaveLength(0);
    const { mem } = probeTrialMemory(db);
    expect(mem.providerOperations.size).toBe(0);
    expect(db.txFor(TENANT).events).toHaveLength(eventsBefore);
  });

  it("AC2: UNAVAILABLE trial capability fails closed even with the GLOBAL row AVAILABLE", async () => {
    const browser = new FakeBrowserPort();
    const { db, bus } = setupGateBus(browser, {
      globalAvailability: "AVAILABLE",
      trialAvailability: "UNAVAILABLE",
      designatedAccountId: SEEDED_ACCOUNT_ID,
    });
    const trialId = await requestEligibleTrial(bus, "AC2 unavailable trial cap");
    const result = await bus.execute(actor(), "trial.begin_provisioning", { trialId });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("must fail closed");
    expect(result.code).toBe("precondition_failed");
    expect(browser.calls).toHaveLength(0);
    expect(probeTrialMemory(db).mem.providerOperations.size).toBe(0);
  });

  it("AC3: trial AVAILABLE without a designation fails closed", async () => {
    const browser = new FakeBrowserPort();
    const { db, bus } = setupGateBus(browser, { trialAvailability: "AVAILABLE" });
    const trialId = await requestEligibleTrial(bus, "AC3 no designation");
    const result = await bus.execute(actor(), "trial.begin_provisioning", { trialId });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("must fail closed");
    expect(result.code).toBe("precondition_failed");
    expect(dumped(result)).toContain("designated disposable provider account");
    expect(browser.calls).toHaveLength(0);
    expect(probeTrialMemory(db).mem.providerOperations.size).toBe(0);
  });

  it("AC3: trial AVAILABLE with another account designated fails closed", async () => {
    const browser = new FakeBrowserPort();
    const { db, bus } = setupGateBus(browser, { trialAvailability: "AVAILABLE", designatedAccountId: OTHER_ACCOUNT_ID });
    const trialId = await requestEligibleTrial(bus, "AC3 wrong account");
    const result = await bus.execute(actor(), "trial.begin_provisioning", { trialId });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("must fail closed");
    expect(result.code).toBe("precondition_failed");
    expect(browser.calls).toHaveLength(0);
    expect(probeTrialMemory(db).mem.providerOperations.size).toBe(0);
  });

  it("AC3: designated account that went INACTIVE fails closed", async () => {
    const browser = new FakeBrowserPort();
    const { db, bus } = setupGateBus(browser, { trialAvailability: "AVAILABLE", designatedAccountId: SEEDED_ACCOUNT_ID });
    const { mem } = probeTrialMemory(db);
    const seeded = mem.providerAccounts.get(SEEDED_ACCOUNT_ID);
    if (seeded === undefined) throw new Error("seed missing");
    (seeded as { status?: string }).status = "SUSPENDED";
    const trialId = await requestEligibleTrial(bus, "AC3 inactive account");
    const result = await bus.execute(actor(), "trial.begin_provisioning", { trialId });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("must fail closed");
    expect(result.code).toBe("precondition_failed");
    expect(browser.calls).toHaveLength(0);
    expect(mem.providerOperations.size).toBe(0);
  });

  it("AC4: trial AVAILABLE with the exact designation queues for the durable dispatcher (SPEC §41)", async () => {
    const browser = new FakeBrowserPort({ outcome: "SUCCEEDED", detail: "browser: ok", externalRef: "ext-ac4" });
    const { db, bus } = setupGateBus(browser, { trialAvailability: "AVAILABLE", designatedAccountId: SEEDED_ACCOUNT_ID });
    const trialId = await requestEligibleTrial(bus, "AC4 happy path");
    const result = await bus.execute<{ id: string; status: string; operationId: string; effectUncertain: boolean }>(
      actor(),
      "trial.begin_provisioning",
      {
        trialId,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`must queue, got ${dumped(result)}`);
    // FASE5-S6-FIX2 (SPEC §41): the secret-required `trial.provision`
    // NEVER executes inline — zero port calls inside the command
    // transaction. The REQUESTED row is the committed intent the durable
    // dispatcher claims post-commit.
    expect(result.data.status).toBe("PROVISIONING");
    expect(result.data.effectUncertain).toBe(true);
    expect(browser.calls).toHaveLength(0);
    const { mem } = probeTrialMemory(db);
    expect(mem.providerOperations.get(result.data.operationId)?.status).toBe("REQUESTED");
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
  });

  it("GLOBAL UNAVAILABLE still wins even with trial AVAILABLE + designation", async () => {
    const browser = new FakeBrowserPort();
    const { db, bus } = setupGateBus(browser, {
      globalAvailability: "UNAVAILABLE",
      trialAvailability: "AVAILABLE",
      designatedAccountId: SEEDED_ACCOUNT_ID,
    });
    const trialId = await requestEligibleTrial(bus, "global still wins");
    const result = await bus.execute(actor(), "trial.begin_provisioning", { trialId });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("must fail closed");
    expect(result.code).toBe("precondition_failed");
    expect(browser.calls).toHaveLength(0);
    expect(probeTrialMemory(db).mem.providerOperations.size).toBe(0);
  });
});

describe("FASE5-S4S5 provider.request_operation trial.provision (AC2/AC3/AC4)", () => {
  it("AC2: missing trial capability fails closed before any insert or port call", async () => {
    const browser = new FakeBrowserPort();
    const { db, bus } = setupGateBus(browser, { globalAvailability: "AVAILABLE", designatedAccountId: SEEDED_ACCOUNT_ID });
    const trialId = await requestEligibleTrial(bus, "AC2 provider resolve");
    const eventsBefore = db.txFor(TENANT).events.length;
    const result = await bus.execute(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId: trialId,
      idempotencyKey: "ac2-provider-resolve",
      payload: { duration_minutes: 60 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("must fail closed");
    expect(result.code).toBe("precondition_failed");
    expect(browser.calls).toHaveLength(0);
    expect(probeTrialMemory(db).mem.providerOperations.size).toBe(0);
    expect(db.txFor(TENANT).events).toHaveLength(eventsBefore);
  });

  it("AC3: wrong designation fails closed on the provider.resolve entry", async () => {
    const browser = new FakeBrowserPort();
    const { db, bus } = setupGateBus(browser, { trialAvailability: "AVAILABLE", designatedAccountId: OTHER_ACCOUNT_ID });
    const trialId = await requestEligibleTrial(bus, "AC3 provider resolve");
    const result = await bus.execute(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId: trialId,
      idempotencyKey: "ac3-provider-resolve",
      payload: { duration_minutes: 60 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("must fail closed");
    expect(result.code).toBe("precondition_failed");
    expect(browser.calls).toHaveLength(0);
    expect(probeTrialMemory(db).mem.providerOperations.size).toBe(0);
  });

  it("AC4: exact designation queues on the provider.resolve entry (SPEC §41)", async () => {
    const browser = new FakeBrowserPort({ outcome: "SUCCEEDED", detail: "browser: ok", externalRef: "ext-ac4-resolve" });
    const { db, bus } = setupGateBus(browser, { trialAvailability: "AVAILABLE", designatedAccountId: SEEDED_ACCOUNT_ID });
    const trialId = await requestEligibleTrial(bus, "AC4 provider resolve");
    const result = await bus.execute<{ id: string; status: string; effectCertainty: string }>(
      actor(),
      "provider.request_operation",
      {
        action: "trial.provision",
        entityType: "trial",
        entityId: trialId,
        idempotencyKey: "ac4-provider-resolve",
        payload: { duration_minutes: 60 },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`must queue, got ${dumped(result)}`);
    // FASE5-S6-FIX2 (SPEC §41): same queue-only contract as the domain
    // entry — zero port calls inside the command transaction.
    expect(result.data.status).toBe("QUEUED");
    expect(result.data.effectCertainty).toBe("UNKNOWN");
    expect(browser.calls).toHaveLength(0);
    expect(probeTrialMemory(db).mem.providerOperations.get(result.data.id)?.status).toBe("REQUESTED");
  });
});

describe("FASE5-S4S5 synthetics untouched (AC5)", () => {
  it("echo trial.provision still works with no trial capability and no designation", async () => {
    const db = new MemoryDb();
    const bus = new CommandBus(db);
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    const echo = new EchoProviderOpsAdapter();
    registerTrialCommands(bus, { opsPort: echo });
    registerProviderCommands(bus, { opsPort: echo });
    const trialId = await requestEligibleTrial(bus, "AC5 echo trial");
    const result = await bus.execute<{ id: string; status: string }>(actor(), "trial.begin_provisioning", { trialId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`echo must stay green, got ${dumped(result)}`);
    expect(result.data.status).toBe("ACTIVE");
  });
});
