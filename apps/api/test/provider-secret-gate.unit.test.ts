import { describe, expect, it } from "vitest";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../src/commands/command-bus.js";
import { registerCrmCommands } from "../src/crm/crm.commands.js";
import { registerHumanReviewCommands } from "../src/human-review/human-review.commands.js";
import { registerPolicyCommands } from "../src/policy/policy.commands.js";
import { registerTrialCommands } from "../src/trial/trial.commands.js";
import { registerProviderCommands } from "../src/provider/provider.commands.js";
import {
  EchoProviderOpsAdapter,
  ManualProviderOpsAdapter,
  SECRET_REQUIRED_ADAPTER_VERSION,
  isSyntheticReadbackSubject,
  type AdapterResult,
  type ProviderOperationRequest,
  type ProviderOpsPort,
  type ProviderReadbackPort,
  type ReadbackResult,
} from "../src/provider/provider-port.js";
import { requestOperationInput, resolveOperationInput } from "../src/provider/provider.commands.js";
import {
  assertBrowserSecretReady,
  isSecretRequiringPort,
  isSecretsPortConfigured,
  PROVIDER_CALL_UNCERTAIN_CODE,
  validateSecretRefFormat,
} from "../src/provider/provider-secret-gate.js";
import { trialMemoryOf } from "../src/trial/trial-store.js";
import type { CommandHandlerContext } from "../src/commands/command-bus.js";
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

const NOOP_SECRETS_PORT = {
  name: "noop",
  async getSecret(): Promise<string> {
    throw new Error("noop");
  },
};

function dumped(value: unknown): string {
  return JSON.stringify(value ?? null);
}

describe("PF-05 secret-ref gate (pure)", () => {
  it("echo/manual never require a secret", () => {
    expect(isSecretRequiringPort({ name: "echo" })).toBe(false);
    expect(isSecretRequiringPort({ name: "manual" })).toBe(false);
    expect(isSecretRequiringPort({ name: "browser" })).toBe(true);
    expect(isSecretRequiringPort({ name: "cinevision-v1", requiresSecretRef: true })).toBe(true);
  });

  it("validates ref format without ever echoing the ref", () => {
    expect(validateSecretRefFormat(null)).toEqual({ ok: false, reason: "missing" });
    expect(validateSecretRefFormat("")).toEqual({ ok: false, reason: "missing" });
    expect(validateSecretRefFormat("wave4://no-real-credential")).toEqual({ ok: false, reason: "placeholder" });
    expect(validateSecretRefFormat("not-a-ref")).toEqual({ ok: false, reason: "malformed" });
    expect(validateSecretRefFormat(VALID_REF)).toEqual({ ok: true, secretRef: VALID_REF });
  });

  it("requires a configured (non-noop) SecretsPort without calling getSecret", () => {
    expect(isSecretsPortConfigured(null)).toBe(false);
    expect(isSecretsPortConfigured(undefined)).toBe(false);
    expect(isSecretsPortConfigured(NOOP_SECRETS_PORT)).toBe(false);
    expect(isSecretsPortConfigured(CONFIGURED_SECRETS_PORT)).toBe(true);
    const ok = assertBrowserSecretReady({ secretRef: VALID_REF, secretsPort: CONFIGURED_SECRETS_PORT });
    expect(ok).toEqual({ ok: true, secretRef: VALID_REF });
    for (const bad of [null, "wave4://no-real-credential", "bad"] as const) {
      const failed = assertBrowserSecretReady({ secretRef: bad, secretsPort: CONFIGURED_SECRETS_PORT });
      expect(failed.ok).toBe(false);
      if (!failed.ok) {
        expect(dumped(failed.message)).not.toContain("wave4://");
        expect(dumped(failed.message)).not.toContain("infisical://");
      }
    }
    const noPort = assertBrowserSecretReady({ secretRef: VALID_REF, secretsPort: NOOP_SECRETS_PORT });
    expect(noPort.ok).toBe(false);
  });
});

describe("PF-05 provider.request_operation gate", () => {
  it("echo/manual keep working with the placeholder and no SecretsPort", async () => {
    for (const port of [new EchoProviderOpsAdapter(), new ManualProviderOpsAdapter()] as const) {
      const db = new MemoryDb();
      const bus = new CommandBus(db);
      registerProviderCommands(bus, { opsPort: port });
      const entityId = "33333333-3333-4333-8333-333333333333";
      const result = await bus.execute<{ id: string; status: string }>(actor(), "provider.request_operation", {
        action: "trial.provision",
        entityType: "trial",
        entityId,
        idempotencyKey: `echo-ok-${port.name}`,
        payload: {},
      });
      expect(result.ok).toBe(true);
    }
  });

  it("BROWSER with placeholder ref fails closed before REQUESTED/port", async () => {
    const db = new MemoryDb();
    const browser = new FakeBrowserPort();
    const bus = new CommandBus(db);
    // Default memory loader returns the wave4 placeholder → gate rejects.
    registerProviderCommands(bus, { opsPort: browser, secretsPort: CONFIGURED_SECRETS_PORT });
    const result = await bus.execute(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId: "44444444-4444-4444-8444-444444444444",
      idempotencyKey: "browser-placeholder-1",
      payload: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("precondition_failed");
      expect(dumped(result.message)).not.toContain("wave4://");
    }
    expect(browser.calls).toHaveLength(0);
    const tx = db.txFor(TENANT);
    expect(tx.events).toHaveLength(0);
    expect(tx.audits).toHaveLength(1);
  });

  it("BROWSER with malformed ref fails closed without calling the port", async () => {
    const db = new MemoryDb();
    const browser = new FakeBrowserPort();
    const bus = new CommandBus(db);
    registerProviderCommands(bus, {
      opsPort: browser,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => "not-a-valid-ref",
    });
    const result = await bus.execute(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId: "55555555-5555-4555-8555-555555555555",
      idempotencyKey: "browser-malformed-1",
      payload: {},
    });
    expect(result.ok).toBe(false);
    expect(browser.calls).toHaveLength(0);
    expect(db.txFor(TENANT).events).toHaveLength(0);
  });

  it("BROWSER with valid ref but Noop SecretsPort fails closed", async () => {
    const db = new MemoryDb();
    const browser = new FakeBrowserPort();
    const bus = new CommandBus(db);
    registerProviderCommands(bus, {
      opsPort: browser,
      secretsPort: NOOP_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
    });
    const result = await bus.execute(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId: "66666666-6666-4666-8666-666666666666",
      idempotencyKey: "browser-noop-1",
      payload: {},
    });
    expect(result.ok).toBe(false);
    expect(browser.calls).toHaveLength(0);
    expect(db.txFor(TENANT).events).toHaveLength(0);
  });

  it("BROWSER with valid ref + configured port forwards ONLY the secret_ref string", async () => {
    const db = new MemoryDb();
    seedTrialAccount(db);
    const browser = new FakeBrowserPort();
    const bus = new CommandBus(db);
    registerProviderCommands(bus, {
      opsPort: browser,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
    });
    const entityId = "77777777-7777-4777-8777-777777777777";
    const result = await bus.execute<{ id: string; status: string }>(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId,
      idempotencyKey: "browser-valid-1",
      payload: { duration_minutes: 60 },
    });
    expect(result.ok).toBe(true);
    expect(browser.calls).toHaveLength(1);
    const call = browser.calls[0] as ProviderOperationRequest;
    // Only the validated string crosses the frontier — never a value.
    expect(call.secretRef).toBe(VALID_REF);
    expect(dumped(call.payload)).not.toContain("infisical://");

    // Persisted + emitted surfaces carry no ref and no value.
    const tx = db.txFor(TENANT);
    expect(dumped(tx.events)).not.toContain("infisical://");
    expect(dumped(tx.audits)).not.toContain("infisical://");
  });

  it("BROWSER rejects smuggled secret keys instead of stripping them", async () => {
    const db = new MemoryDb();
    seedTrialAccount(db);
    const browser = new FakeBrowserPort();
    const bus = new CommandBus(db);
    registerProviderCommands(bus, {
      opsPort: browser,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
    });
    const result = await bus.execute(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId: "88888888-8888-4888-8888-888888888888",
      idempotencyKey: "browser-smuggled-1",
      payload: { duration_minutes: 60, secret_ref: "smuggled-must-be-rejected" },
    });
    expect(result.ok).toBe(false);
    expect(browser.calls).toHaveLength(0);
    expect(db.txFor(TENANT).events).toHaveLength(0);
  });
});

describe("PF-05 trial.begin_provisioning gate", () => {
  it("BROWSER with placeholder fails closed and leaves the trial in REQUESTED", async () => {
    const db = new MemoryDb();
    const bus = new CommandBus(db);
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    const browser = new FakeBrowserPort();
    registerTrialCommands(bus, { opsPort: browser, secretsPort: CONFIGURED_SECRETS_PORT });
    registerProviderCommands(bus, { opsPort: browser, secretsPort: CONFIGURED_SECRETS_PORT });

    const personRes = await bus.execute<{ id: string }>(actor(), "person.register", { canonicalName: "Browser Trial" });
    expect(personRes.ok).toBe(true);
    if (!personRes.ok) throw new Error("person setup failed");
    const trialRes = await bus.execute<{ id: string | null; status: string }>(actor(), "trial.request", {
      personId: personRes.data.id,
      durationMinutes: 60,
    });
    expect(trialRes.ok).toBe(true);
    if (!trialRes.ok || trialRes.data.id === null) throw new Error("trial setup failed");
    const trialId = trialRes.data.id;

    const provisioned = await bus.execute(actor(), "trial.begin_provisioning", { trialId });
    expect(provisioned.ok).toBe(false);
    if (!provisioned.ok) {
      expect(provisioned.code).toBe("precondition_failed");
    }
    expect(browser.calls).toHaveLength(0);
    // No provider operation was persisted for the failed gate.
    const tx = db.txFor(TENANT);
    const providerRequested = tx.events.filter((e) => e.event_type === "provider.operation_requested.v1");
    expect(providerRequested).toHaveLength(0);
    expect(dumped(tx.events)).not.toContain("infisical://");
    expect(dumped(tx.events)).not.toContain("wave4://");
  });
});

/** SEC-REVIEW fixes: restrictive contract, safe output, capability wins, no pre-gate creation. */
function probeTrialMemory(db: MemoryDb) {
  const ctx = {
    tx: db.txFor(TENANT),
    tenantId: TENANT,
    actor: actor(),
    commandId: "probe",
    correlationId: "probe",
    causationId: null,
  } as unknown as CommandHandlerContext;
  const mem = trialMemoryOf(ctx);
  if (mem === null) throw new Error("no trial memory available");
  return mem;
}

function seedTrialAccount(db: MemoryDb): string {
  const mem = probeTrialMemory(db);
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
  return accountId;
}

function markUnavailable(db: MemoryDb) {  db.txFor(TENANT).capabilities.set("provider.cinevision", {
    key: "provider.cinevision",
    ownerContext: "provider",
    availability: "UNAVAILABLE",
    certificationStatus: "UNCERTIFIED",
    riskLevel: "R2",
    mvpPhase: "wave-0",
    manualEquivalent: "manual",
    policyFamily: "provider.cinevision",
    degradation: "manual",
    permissions: [],
  });
}

/** Secret-requiring port that leaks secret material in its result. */
class ContaminatedBrowserPort implements ProviderOpsPort {
  readonly name = "browser";
  readonly requiresSecretRef = true;
  readonly calls: ProviderOperationRequest[] = [];

  async requestOperation(input: ProviderOperationRequest): Promise<AdapterResult> {
    this.calls.push(input);
    return {
      outcome: "SUCCEEDED",
      detail: `leaked infisical://production/SUPERSECRET token=abc secretRef=${input.secretRef ?? "none"}`,
      externalRef: "infisical://production/SUPERSECRET",
    };
  }
}

describe("PF05-SECRETREF-02 (a) nested/alias payload rejected without side effects", () => {
  const cases: Array<{ name: string; action: string; entityType: string; payload: Record<string, unknown> }> = [
    {
      name: "nested secret_ref object",
      action: "trial.provision",
      entityType: "trial",
      payload: { duration_minutes: 60, metadata: { secret_ref: "infisical://production/X" } },
    },
    {
      name: "cased alias key",
      action: "trial.provision",
      entityType: "trial",
      payload: { duration_minutes: 60, SecretRef: "smuggled" },
    },
    {
      name: "deeply nested token",
      action: "trial.provision",
      entityType: "trial",
      payload: { outer: { nested: { token: "abc123" } } },
    },
    {
      name: "array with credentials",
      action: "trial.provision",
      entityType: "trial",
      payload: { duration_minutes: 60, items: [{ credentials: "x" }] },
    },
    {
      name: "ref-like string value",
      action: "subscription.provision",
      entityType: "subscription",
      payload: { plan_key: "infisical://production/KEY" },
    },
    {
      name: "action alias casing",
      action: "Trial.Provision",
      entityType: "trial",
      payload: {},
    },
    {
      name: "unknown action",
      action: "browser.exec",
      entityType: "trial",
      payload: {},
    },
    {
      name: "entity mismatch",
      action: "trial.provision",
      entityType: "subscription",
      payload: {},
    },
    {
      name: "unknown top-level field",
      action: "trial.provision",
      entityType: "trial",
      payload: { duration_minutes: 60, plan: "basic" },
    },
  ];

  for (const [index, tc] of cases.entries()) {
    it(`rejects ${tc.name}`, async () => {
      const db = new MemoryDb();
      seedTrialAccount(db);
      const browser = new FakeBrowserPort();
      const bus = new CommandBus(db);
      registerProviderCommands(bus, {
        opsPort: browser,
        secretsPort: CONFIGURED_SECRETS_PORT,
        loadSecretRef: async () => VALID_REF,
      });
      const result = await bus.execute(actor(), "provider.request_operation", {
        action: tc.action,
        entityType: tc.entityType,
        entityId: "99999999-9999-4999-8999-999999999999",
        idempotencyKey: `secret-shape-${index}`,
        payload: tc.payload,
      });
      expect(result.ok).toBe(false);
      expect(browser.calls).toHaveLength(0);
      const tx = db.txFor(TENANT);
      expect(tx.events).toHaveLength(0);
      const mem = probeTrialMemory(db);
      expect(mem.providerOperations.size).toBe(0);
      expect(dumped(result)).not.toContain("infisical://");
      expect(dumped(result)).not.toContain("SUPERSECRET");
    });
  }
});

describe("PF05-SECRETREF-02 (b) contaminated port output never persisted/emitted", () => {
  it("demotes SUCCEEDED with bad externalRef to VERIFYING with safe surfaces", async () => {
    const db = new MemoryDb();
    seedTrialAccount(db);
    const browser = new ContaminatedBrowserPort();
    const bus = new CommandBus(db);
    registerProviderCommands(bus, {
      opsPort: browser,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
    });
    const entityId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const result = await bus.execute<{ id: string; status: string }>(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId,
      idempotencyKey: "contaminated-1",
      payload: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // Ambiguous effect is retained, not confirmed.
    expect(result.data.status).toBe("VERIFYING");
    expect(browser.calls).toHaveLength(1);

    const tx = db.txFor(TENANT);
    const dumpedAll = dumped({ events: tx.events, audits: tx.audits, response: result });
    expect(dumpedAll).not.toContain("SUPERSECRET");
    expect(dumpedAll).not.toContain("infisical://");
    expect(dumpedAll).not.toContain("leaked");
    expect(dumpedAll).not.toContain("token=abc");

    const mem = probeTrialMemory(db);
    const op = [...mem.providerOperations.values()].find((row) => row.id === result.data.id);
    expect(op).toBeDefined();
    expect(dumped(op?.resultSummary ?? {})).not.toContain("SUPERSECRET");
    expect(dumped(op?.resultSummary ?? {})).not.toContain("infisical://");
    expect(dumped(op?.resultSummary ?? {})).not.toContain("leaked");
    expect(dumped(op?.requestedPayload ?? {})).not.toContain("infisical://");
  });
});

describe("PF05-SECRETREF-02 (c) capability UNAVAILABLE blocks injected secret port", () => {
  it("provider.request_operation creates nothing and calls nothing", async () => {
    const db = new MemoryDb();
    markUnavailable(db);
    const browser = new FakeBrowserPort({ outcome: "MANUAL", detail: "browser: parked", externalRef: null });
    const bus = new CommandBus(db);
    registerProviderCommands(bus, {
      opsPort: browser,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
    });
    const result = await bus.execute(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      idempotencyKey: "unavailable-blocked-1",
      payload: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("precondition_failed");
    expect(browser.calls).toHaveLength(0);
    expect(db.txFor(TENANT).events).toHaveLength(0);
    expect(probeTrialMemory(db).providerOperations.size).toBe(0);
  });

  it("trial.begin_provisioning leaves the trial REQUESTED with no operation", async () => {
    const db = new MemoryDb();
    const bus = new CommandBus(db);
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    const browser = new FakeBrowserPort();
    registerTrialCommands(bus, { opsPort: browser, secretsPort: CONFIGURED_SECRETS_PORT });
    registerProviderCommands(bus, { opsPort: browser, secretsPort: CONFIGURED_SECRETS_PORT });

    const personRes = await bus.execute<{ id: string }>(actor(), "person.register", { canonicalName: "Blocked Trial" });
    expect(personRes.ok).toBe(true);
    if (!personRes.ok) throw new Error("person setup failed");
    const trialRes = await bus.execute<{ id: string | null; status: string }>(actor(), "trial.request", {
      personId: personRes.data.id,
      durationMinutes: 60,
    });
    expect(trialRes.ok).toBe(true);
    if (!trialRes.ok || trialRes.data.id === null) throw new Error("trial setup failed");
    const trialId = trialRes.data.id;

    markUnavailable(db);
    const provisioned = await bus.execute(actor(), "trial.begin_provisioning", { trialId });
    expect(provisioned.ok).toBe(false);
    expect(browser.calls).toHaveLength(0);
    const mem = probeTrialMemory(db);
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("REQUESTED");
    const tx = db.txFor(TENANT);
    expect(tx.events.filter((e) => e.event_type === "provider.operation_requested.v1")).toHaveLength(0);
  });
});

describe("PF05-SECRETREF-02 (d) no account creation before the secret gate", () => {
  it("provider.request_operation without account fails without creating one", async () => {
    const db = new MemoryDb();
    const browser = new FakeBrowserPort();
    const bus = new CommandBus(db);
    registerProviderCommands(bus, {
      opsPort: browser,
      secretsPort: CONFIGURED_SECRETS_PORT,
    });
    expect(probeTrialMemory(db).providerAccounts.size).toBe(0);
    const result = await bus.execute(actor(), "provider.request_operation", {
      action: "trial.provision",
      entityType: "trial",
      entityId: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
      idempotencyKey: "no-precreate-1",
      payload: {},
    });
    expect(result.ok).toBe(false);
    expect(browser.calls).toHaveLength(0);
    expect(probeTrialMemory(db).providerAccounts.size).toBe(0);
    expect(probeTrialMemory(db).providerOperations.size).toBe(0);
    expect(db.txFor(TENANT).events).toHaveLength(0);
  });

  it("trial.begin_provisioning without account fails without creating one", async () => {
    const db = new MemoryDb();
    const bus = new CommandBus(db);
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    const browser = new FakeBrowserPort();
    registerTrialCommands(bus, { opsPort: browser, secretsPort: CONFIGURED_SECRETS_PORT });
    registerProviderCommands(bus, { opsPort: browser, secretsPort: CONFIGURED_SECRETS_PORT });

    const personRes = await bus.execute<{ id: string }>(actor(), "person.register", { canonicalName: "No Precreate" });
    expect(personRes.ok).toBe(true);
    if (!personRes.ok) throw new Error("person setup failed");
    const trialRes = await bus.execute<{ id: string | null; status: string }>(actor(), "trial.request", {
      personId: personRes.data.id,
      durationMinutes: 60,
    });
    expect(trialRes.ok).toBe(true);
    if (!trialRes.ok || trialRes.data.id === null) throw new Error("trial setup failed");
    const trialId = trialRes.data.id;

    expect(probeTrialMemory(db).providerAccounts.size).toBe(0);
    const provisioned = await bus.execute(actor(), "trial.begin_provisioning", { trialId });
    // Default memory account carries the wave4 placeholder → gate rejects.
    expect(provisioned.ok).toBe(false);
    expect(browser.calls).toHaveLength(0);
    expect(probeTrialMemory(db).providerAccounts.size).toBe(0);
    expect(probeTrialMemory(db).trials.get(trialId)?.lifecycleStatus).toBe("REQUESTED");
  });
});

/** MVP-PF05-SECRETREF-03: inconclusive reconcile, evidence projection, cancel provenance. */
const READBACK_SENTINEL = "sentinel-R3C0NC1L3-9f8e7d";
const CONTAMINATED_READBACK_EVIDENCE = `readback leaked infisical://dev/browser-worker/CINEVISION_PASSWORD ${READBACK_SENTINEL}`;

/** Readback port that returns conclusive proof carrying secret material in its free-form evidence. */
class ContaminatedReadback implements ProviderReadbackPort {
  async verify(): Promise<ReadbackResult> {
    return { effectApplied: true, evidence: CONTAMINATED_READBACK_EVIDENCE, conclusive: true };
  }
}

function setupEchoTrialBus() {
  const db = new MemoryDb();
  const bus = new CommandBus(db);
  registerHumanReviewCommands(bus);
  registerPolicyCommands(bus);
  registerCrmCommands(bus);
  const echo = new EchoProviderOpsAdapter();
  registerTrialCommands(bus, { opsPort: echo });
  registerProviderCommands(bus, { opsPort: echo });
  return { db, bus };
}

async function requestEchoTrial(
  bus: CommandBus,
  canonicalName: string,
): Promise<{ trialId: string; operationId: string }> {
  const personRes = await bus.execute<{ id: string }>(actor(), "person.register", { canonicalName });
  expect(personRes.ok).toBe(true);
  if (!personRes.ok) throw new Error("person setup failed");
  const trialRes = await bus.execute<{ id: string | null; status: string }>(actor(), "trial.request", {
    personId: personRes.data.id,
    durationMinutes: 60,
  });
  expect(trialRes.ok).toBe(true);
  if (!trialRes.ok || trialRes.data.id === null) throw new Error("trial setup failed");
  const provisioned = await bus.execute<{ status: string; operationId: string; effectUncertain: boolean }>(
    actor(),
    "trial.begin_provisioning",
    { trialId: trialRes.data.id, echoOutcome: "unknown" },
  );
  expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING", effectUncertain: true } });
  if (!provisioned.ok) throw new Error("expected VERIFYING park");
  return { trialId: trialRes.data.id, operationId: provisioned.data.operationId };
}

describe("PF05-SECRETREF-03 (a) inconclusive readback preserves VERIFYING/UNKNOWN", () => {
  it("unset env keeps VERIFYING/UNKNOWN with zero terminal side effects; explicit NOT_APPLIED still resolves", async () => {
    const { db, bus } = setupEchoTrialBus();
    const { trialId, operationId } = await requestEchoTrial(bus, "Reconcile Hold");

    delete process.env["PROVIDER_READBACK_EFFECT"];
    try {
      const reconciled = await bus.execute<{
        status: string;
        effectCertainty: string;
        effectApplied: boolean;
        resumedTrial: boolean;
      }>(actor(), "provider.reconcile", { operationId });
      expect(reconciled).toMatchObject({
        ok: true,
        data: { status: "VERIFYING", effectCertainty: "UNKNOWN", effectApplied: false, resumedTrial: false },
      });
      const mem = probeTrialMemory(db);
      expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
      const op = mem.providerOperations.get(operationId);
      expect(op?.status).toBe("VERIFYING");
      expect(op?.effectCertainty).toBe("UNKNOWN");
      expect(op?.completedAt).toBeNull();
      const types = db.txFor(TENANT).events.map((e) => e.event_type);
      expect(types).not.toContain("provider.operation_succeeded.v1");
      expect(types).not.toContain("provider.operation_failed.v1");
      expect(types).not.toContain("trial.activated.v1");
      expect(types).not.toContain("trial.provisioning_failed.v1");
    } finally {
      delete process.env["PROVIDER_READBACK_EFFECT"];
    }

    // The explicit NOT_APPLIED branch still resolves FAILED and resumes the trial.
    process.env["PROVIDER_READBACK_EFFECT"] = "NOT_APPLIED";
    try {
      const resolved = await bus.execute<{ status: string; effectCertainty: string; resumedTrial: boolean }>(
        actor(),
        "provider.reconcile",
        { operationId },
      );
      expect(resolved).toMatchObject({
        ok: true,
        data: { status: "FAILED", effectCertainty: "KNOWN_NOT_APPLIED", resumedTrial: true },
      });
      expect(probeTrialMemory(db).trials.get(trialId)?.lifecycleStatus).toBe("REQUESTED");
      expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("trial.provisioning_failed.v1");
    } finally {
      delete process.env["PROVIDER_READBACK_EFFECT"];
    }
  });
});

describe("PF05-SECRETREF-03 (b) contaminated readback evidence never persisted/emitted", () => {
  it("conclusive APPLIED projects only fixed codes; the ref/sentinel reach no surface", async () => {
    const db = new MemoryDb();
    const bus = new CommandBus(db);
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    const echo = new EchoProviderOpsAdapter();
    registerTrialCommands(bus, { opsPort: echo });
    registerProviderCommands(bus, { opsPort: echo, readbackPort: new ContaminatedReadback() });

    const personRes = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Contaminated Readback",
    });
    expect(personRes.ok).toBe(true);
    if (!personRes.ok) throw new Error("person setup failed");
    const trialRes = await bus.execute<{ id: string | null; status: string }>(actor(), "trial.request", {
      personId: personRes.data.id,
      durationMinutes: 60,
    });
    expect(trialRes.ok).toBe(true);
    if (!trialRes.ok || trialRes.data.id === null) throw new Error("trial setup failed");
    const provisioned = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", {
      trialId: trialRes.data.id,
      echoOutcome: "unknown",
    });
    if (!provisioned.ok) throw new Error("expected VERIFYING park");

    const reconciled = await bus.execute<{ id: string; status: string }>(actor(), "provider.reconcile", {
      operationId: provisioned.data.operationId,
    });
    expect(reconciled).toMatchObject({ ok: true, data: { status: "SUCCEEDED" } });

    const tx = db.txFor(TENANT);
    const mem = probeTrialMemory(db);
    const op = mem.providerOperations.get(provisioned.data.operationId);
    const dumpedAll = dumped({ events: tx.events, audits: tx.audits, op, response: reconciled });
    expect(dumpedAll).not.toContain("infisical://");
    expect(dumpedAll).not.toContain("CINEVISION_PASSWORD");
    expect(dumpedAll).not.toContain(READBACK_SENTINEL);
    expect(dumpedAll).not.toContain("leaked");
    expect(op?.resultSummary).toMatchObject({ reconcile_outcome: "APPLIED", effect_applied: true });
    expect(dumped(op?.resultSummary ?? {})).not.toContain('"reconcile_evidence":');
  });
});

function setupSecretTrialBus(outcome: AdapterResult) {
  const db = new MemoryDb();
  seedTrialAccount(db);
  const browser = new FakeBrowserPort(outcome);
  const bus = new CommandBus(db);
  registerHumanReviewCommands(bus);
  registerPolicyCommands(bus);
  registerCrmCommands(bus);
  registerTrialCommands(bus, {
    opsPort: browser,
    secretsPort: CONFIGURED_SECRETS_PORT,
    loadSecretRef: async () => VALID_REF,
  });
  registerProviderCommands(bus, {
    opsPort: browser,
    secretsPort: CONFIGURED_SECRETS_PORT,
    loadSecretRef: async () => VALID_REF,
  });
  return { db, bus, browser };
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

describe("PF05-SECRETREF-03 (c) trial.cancel provenance gate", () => {
  it("secret-required HUMAN_REQUIRED after the port call keeps UNKNOWN (no auto KNOWN_NOT_APPLIED)", async () => {
    const { db, bus, browser } = setupSecretTrialBus({
      outcome: "MANUAL",
      detail: "browser: parked for operator",
      externalRef: null,
    });
    const trialId = await requestSecretTrial(bus, "Secret Cancel Hold");
    const provisioned = await bus.execute<{ status: string; operationId: string }>(
      actor(),
      "trial.begin_provisioning",
      { trialId },
    );
    expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING" } });
    if (!provisioned.ok) throw new Error("expected secret park");
    expect(browser.calls).toHaveLength(1);

    const cancelled = await bus.execute<{ status: string; cancelledOperations: string[] }>(
      actor(),
      "trial.cancel",
      { trialId, reason: "customer changed mind" },
    );
    expect(cancelled).toMatchObject({ ok: true, data: { status: "CANCELLED", cancelledOperations: [] } });

    // The operation that already called its port is NOT concluded automatically.
    const op = probeTrialMemory(db).providerOperations.get(provisioned.data.operationId);
    expect(op?.status).toBe("HUMAN_REQUIRED");
    expect(op?.effectCertainty).toBe("UNKNOWN");
    expect(dumped({ op, events: db.txFor(TENANT).events })).not.toContain("infisical://");
  });

  it("pure manual HUMAN_REQUIRED still auto-cancels per the existing contract", async () => {
    const db = new MemoryDb();
    const bus = new CommandBus(db);
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    const manual = new ManualProviderOpsAdapter();
    registerTrialCommands(bus, { opsPort: manual });
    registerProviderCommands(bus, { opsPort: manual });

    const personRes = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Manual Cancel",
    });
    expect(personRes.ok).toBe(true);
    if (!personRes.ok) throw new Error("person setup failed");
    const trialRes = await bus.execute<{ id: string | null; status: string }>(actor(), "trial.request", {
      personId: personRes.data.id,
      durationMinutes: 60,
    });
    expect(trialRes.ok).toBe(true);
    if (!trialRes.ok || trialRes.data.id === null) throw new Error("trial setup failed");
    const trialId = trialRes.data.id;
    const provisioned = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", { trialId });
    if (!provisioned.ok) throw new Error("expected manual park");

    const cancelled = await bus.execute<{ status: string; cancelledOperations: string[] }>(
      actor(),
      "trial.cancel",
      { trialId },
    );
    expect(cancelled).toMatchObject({ ok: true, data: { status: "CANCELLED" } });
    if (!cancelled.ok) throw new Error("expected cancel ok");
    expect(cancelled.data.cancelledOperations).toEqual([provisioned.data.operationId]);
    const op = probeTrialMemory(db).providerOperations.get(provisioned.data.operationId);
    expect(op?.status).toBe("CANCELLED");
    expect(op?.effectCertainty).toBe("KNOWN_NOT_APPLIED");
  });

  it("pre-gate blocked trial stays cancelable with no operation and no port call", async () => {
    const db = new MemoryDb();
    seedTrialAccount(db);
    const browser = new FakeBrowserPort();
    const bus = new CommandBus(db);
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    // No loadSecretRef override: the seeded wave4 placeholder fails the gate.
    registerTrialCommands(bus, { opsPort: browser, secretsPort: CONFIGURED_SECRETS_PORT });
    registerProviderCommands(bus, { opsPort: browser, secretsPort: CONFIGURED_SECRETS_PORT });

    const trialId = await requestSecretTrial(bus, "Pre-gate Cancel");
    const provisioned = await bus.execute(actor(), "trial.begin_provisioning", { trialId });
    expect(provisioned.ok).toBe(false);
    expect(browser.calls).toHaveLength(0);
    expect(probeTrialMemory(db).providerOperations.size).toBe(0);
    expect(probeTrialMemory(db).trials.get(trialId)?.lifecycleStatus).toBe("REQUESTED");

    const cancelled = await bus.execute<{ status: string; cancelledOperations: string[] }>(
      actor(),
      "trial.cancel",
      { trialId },
    );
    expect(cancelled).toMatchObject({ ok: true, data: { status: "CANCELLED", cancelledOperations: [] } });
  });
});

describe("PF05-SECRETREF-04 (1) post-effect port throw parks VERIFYING/UNKNOWN", () => {
  /** Secret-requiring port that records its effect and THEN throws (post-effect crash shape). */
  class EffectThenThrowPort implements ProviderOpsPort {
    readonly name = "browser";
    readonly requiresSecretRef = true;
    readonly calls: ProviderOperationRequest[] = [];
    async requestOperation(input: ProviderOperationRequest): Promise<AdapterResult> {
      this.calls.push(input);
      throw new Error("infisical://production/BOOM leaked ref=super-secret-999");
    }
  }

  function setupThrowBus() {
    const db = new MemoryDb();
    seedTrialAccount(db);
    const port = new EffectThenThrowPort();
    const bus = new CommandBus(db);
    registerProviderCommands(bus, {
      opsPort: port,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
    });
    return { db, bus, port };
  }

  it("provider.request_operation converts the throw to VERIFYING with the fixed code", async () => {
    const { db, bus, port } = setupThrowBus();
    const entityId = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
    const result = await bus.execute<{ id: string; status: string; effectCertainty: string }>(
      actor(),
      "provider.request_operation",
      {
        action: "trial.provision",
        entityType: "trial",
        entityId,
        idempotencyKey: "post-effect-throw-1",
        payload: {},
      },
    );
    expect(result).toMatchObject({ ok: true, data: { status: "VERIFYING", effectCertainty: "UNKNOWN" } });
    expect(port.calls).toHaveLength(1);
    if (!result.ok) throw new Error("expected VERIFYING park");

    const tx = db.txFor(TENANT);
    const types = tx.events.map((e) => e.event_type);
    expect(types).toEqual(["provider.operation_requested.v1"]);
    expect(types).not.toContain("provider.operation_succeeded.v1");
    expect(types).not.toContain("provider.operation_failed.v1");

    const mem = probeTrialMemory(db);
    const op = mem.providerOperations.get(result.data.id);
    expect(op?.status).toBe("VERIFYING");
    expect(op?.effectCertainty).toBe("UNKNOWN");
    expect(op?.completedAt).toBeNull();
    expect(op?.adapterVersion).toBe(SECRET_REQUIRED_ADAPTER_VERSION);
    expect(op?.resultSummary).toEqual({ error_code: PROVIDER_CALL_UNCERTAIN_CODE });

    const dumpedAll = dumped({ events: tx.events, audits: tx.audits, op, response: result });
    expect(dumpedAll).not.toContain("super-secret-999");
    expect(dumpedAll).not.toContain("infisical://");
    expect(dumpedAll).not.toContain("BOOM");
  });

  it("trial.begin_provisioning converts the throw and keeps the trial PROVISIONING", async () => {
    const db = new MemoryDb();
    seedTrialAccount(db);
    const port = new EffectThenThrowPort();
    const bus = new CommandBus(db);
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    registerTrialCommands(bus, {
      opsPort: port,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
    });
    registerProviderCommands(bus, {
      opsPort: port,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
    });

    const personRes = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Post-effect Throw Trial",
    });
    expect(personRes.ok).toBe(true);
    if (!personRes.ok) throw new Error("person setup failed");
    const trialRes = await bus.execute<{ id: string | null; status: string }>(actor(), "trial.request", {
      personId: personRes.data.id,
      durationMinutes: 60,
    });
    expect(trialRes.ok).toBe(true);
    if (!trialRes.ok || trialRes.data.id === null) throw new Error("trial setup failed");
    const trialId = trialRes.data.id;

    const provisioned = await bus.execute<{ status: string; operationId: string; effectUncertain: boolean }>(
      actor(),
      "trial.begin_provisioning",
      { trialId },
    );
    expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING", effectUncertain: true } });
    expect(port.calls).toHaveLength(1);
    if (!provisioned.ok) throw new Error("expected PROVISIONING park");

    const mem = probeTrialMemory(db);
    expect(mem.trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
    const op = mem.providerOperations.get(provisioned.data.operationId);
    expect(op?.status).toBe("VERIFYING");
    expect(op?.effectCertainty).toBe("UNKNOWN");
    expect(op?.completedAt).toBeNull();
    expect(op?.resultSummary).toEqual({ error_code: PROVIDER_CALL_UNCERTAIN_CODE });
    const types = db.txFor(TENANT).events.map((e) => e.event_type);
    expect(types).not.toContain("provider.operation_succeeded.v1");
    expect(types).not.toContain("provider.operation_failed.v1");
    expect(types).not.toContain("trial.activated.v1");
    expect(types).not.toContain("trial.provisioning_failed.v1");
    const dumpedAll = dumped({ events: db.txFor(TENANT).events, op, response: provisioned });
    expect(dumpedAll).not.toContain("super-secret-999");
    expect(dumpedAll).not.toContain("infisical://");
  });
});

describe("PF05-SECRETREF-04 (2) disguised secret ports never read as synthetic", () => {
  /** Secret-requiring port wearing a synthetic name — must never inherit synthetic treatment. */
  class DisguisedSecretPort implements ProviderOpsPort {
    readonly requiresSecretRef = true;
    readonly calls: ProviderOperationRequest[] = [];
    constructor(
      readonly name: string,
      private readonly outcome: AdapterResult,
    ) {}
    async requestOperation(input: ProviderOperationRequest): Promise<AdapterResult> {
      this.calls.push(input);
      return this.outcome;
    }
  }

  function setupDisguisedTrialBus(name: string, outcome: AdapterResult) {
    const db = new MemoryDb();
    seedTrialAccount(db);
    const port = new DisguisedSecretPort(name, outcome);
    const bus = new CommandBus(db);
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    registerTrialCommands(bus, {
      opsPort: port,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
    });
    registerProviderCommands(bus, {
      opsPort: port,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
    });
    return { db, bus, port };
  }

  it("manual-named secret port: cancel does not auto-release the uncertain operation", async () => {
    const { db, bus, port } = setupDisguisedTrialBus("manual", {
      outcome: "MANUAL",
      detail: "disguised: parked",
      externalRef: null,
    });
    const trialId = await requestSecretTrial(bus, "Disguised Manual Cancel");
    const provisioned = await bus.execute<{ status: string; operationId: string }>(
      actor(),
      "trial.begin_provisioning",
      { trialId },
    );
    expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING" } });
    if (!provisioned.ok) throw new Error("expected secret park");
    expect(port.calls).toHaveLength(1);

    const mem = probeTrialMemory(db);
    const op = mem.providerOperations.get(provisioned.data.operationId);
    // Branch-derived provenance survives the disguised port name.
    expect(op?.adapterVersion).toBe(SECRET_REQUIRED_ADAPTER_VERSION);
    expect(op?.adapterVersion).not.toBe("manual-v1");

    const cancelled = await bus.execute<{ status: string; cancelledOperations: string[] }>(
      actor(),
      "trial.cancel",
      { trialId },
    );
    expect(cancelled).toMatchObject({ ok: true, data: { status: "CANCELLED", cancelledOperations: [] } });
    const held = probeTrialMemory(db).providerOperations.get(provisioned.data.operationId);
    expect(held?.status).toBe("HUMAN_REQUIRED");
    expect(held?.effectCertainty).toBe("UNKNOWN");
  });

  it("echo-named secret port: explicit APPLIED readback stays INCONCLUSIVE", async () => {
    const { db, bus } = setupDisguisedTrialBus("echo", {
      outcome: "UNKNOWN",
      detail: "disguised: effect unknown",
      externalRef: null,
    });
    const trialId = await requestSecretTrial(bus, "Disguised Echo Readback");
    const provisioned = await bus.execute<{ status: string; operationId: string }>(
      actor(),
      "trial.begin_provisioning",
      { trialId },
    );
    expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING" } });
    if (!provisioned.ok) throw new Error("expected secret VERIFYING park");

    process.env["PROVIDER_READBACK_EFFECT"] = "APPLIED";
    try {
      const reconciled = await bus.execute<{ status: string; effectCertainty: string; resumedTrial: boolean }>(
        actor(),
        "provider.reconcile",
        { operationId: provisioned.data.operationId },
      );
      expect(reconciled).toMatchObject({
        ok: true,
        data: { status: "VERIFYING", effectCertainty: "UNKNOWN", resumedTrial: false },
      });
      const op = probeTrialMemory(db).providerOperations.get(provisioned.data.operationId);
      expect(op?.status).toBe("VERIFYING");
      expect(op?.completedAt).toBeNull();
      expect(db.txFor(TENANT).events.map((e) => e.event_type)).not.toContain("provider.operation_succeeded.v1");
    } finally {
      delete process.env["PROVIDER_READBACK_EFFECT"];
    }
  });

  it("genuine echo/manual operations still resolve (no over-blocking)", async () => {
    const { db, bus } = setupEchoTrialBus();
    const { operationId } = await requestEchoTrial(bus, "Genuine Still Green");
    process.env["PROVIDER_READBACK_EFFECT"] = "APPLIED";
    try {
      const reconciled = await bus.execute<{ status: string }>(actor(), "provider.reconcile", { operationId });
      expect(reconciled).toMatchObject({ ok: true, data: { status: "SUCCEEDED" } });
    } finally {
      delete process.env["PROVIDER_READBACK_EFFECT"];
    }
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("provider.operation_succeeded.v1");
  });
});

describe("PF05-SECRETREF-04 (3) public echo/manual payload frontier rejects", () => {
  class CountingEchoPort extends EchoProviderOpsAdapter {
    calls = 0;
    override async requestOperation(
      input: ProviderOperationRequest,
    ): Promise<AdapterResult> {
      this.calls += 1;
      return super.requestOperation(input);
    }
  }

  function setupPublicBus() {
    const db = new MemoryDb();
    const echo = new CountingEchoPort();
    const bus = new CommandBus(db);
    registerProviderCommands(bus, { opsPort: echo });
    return { db, bus, echo };
  }

  const rejected: Array<{ name: string; payload: Record<string, unknown> }> = [
    { name: "nested metadata.secret_ref", payload: { metadata: { secret_ref: "x" } } },
    { name: "nested credentials.token", payload: { credentials: { token: "abc" } } },
    { name: "case alias Password", payload: { Password: "hunter2" } },
    { name: "separator alias api-key", payload: { "api-key": "abc" } },
    { name: "array with secret key", payload: { items: [{ clientSecret: "x" }] } },
    { name: "infisical ref string", payload: { note: "see infisical://production/KEY" } },
    { name: "wave4 ref string", payload: { note: "wave4://no-real-credential" } },
    { name: "deep nesting abuse", payload: { a: { b: { c: { d: { e: { f: 1 } } } } } } },
  ];

  for (const [index, tc] of rejected.entries()) {
    it(`rejects ${tc.name} with zero side effects`, async () => {
      const { db, bus, echo } = setupPublicBus();
      const result = await bus.execute(actor(), "provider.request_operation", {
        action: "custom.ping",
        entityType: "trial",
        entityId: "e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4",
        idempotencyKey: `public-frontier-${index}`,
        payload: tc.payload,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("validation_failed");
      expect(dumped(result)).not.toContain("infisical://");
      expect(echo.calls).toBe(0);
      const tx = db.txFor(TENANT);
      expect(tx.events).toHaveLength(0);
      expect(probeTrialMemory(db).providerOperations.size).toBe(0);
    });
  }

  it("normal synthetic payloads still pass", async () => {
    const { bus } = setupPublicBus();
    const result = await bus.execute<{ id: string; status: string }>(actor(), "provider.request_operation", {
      action: "custom.ping",
      entityType: "trial",
      entityId: "f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5",
      idempotencyKey: "public-frontier-ok",
      payload: { duration_minutes: 60, note: "hello", config: { retries: 3 }, tags: ["a", "b"] },
    });
    expect(result).toMatchObject({ ok: true, data: { status: "SUCCEEDED" } });
  });
});
describe("PF05-SECRETREF-03 (d) synthetic stub cannot resolve secret-required operations", () => {
  it("explicit APPLIED env leaves a browser VERIFYING operation inconclusive", async () => {
    const { db, bus } = setupSecretTrialBus({
      outcome: "UNKNOWN",
      detail: "browser: effect unknown",
      externalRef: null,
    });
    const trialId = await requestSecretTrial(bus, "Secret Reconcile Hold");
    const provisioned = await bus.execute<{ status: string; operationId: string }>(
      actor(),
      "trial.begin_provisioning",
      { trialId },
    );
    expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING" } });
    if (!provisioned.ok) throw new Error("expected secret VERIFYING park");

    process.env["PROVIDER_READBACK_EFFECT"] = "APPLIED";
    try {
      const reconciled = await bus.execute<{
        status: string;
        effectCertainty: string;
        resumedTrial: boolean;
      }>(actor(), "provider.reconcile", { operationId: provisioned.data.operationId });
      expect(reconciled).toMatchObject({
        ok: true,
        data: { status: "VERIFYING", effectCertainty: "UNKNOWN", resumedTrial: false },
      });
      expect(probeTrialMemory(db).trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
      const op = probeTrialMemory(db).providerOperations.get(provisioned.data.operationId);
      expect(op?.status).toBe("VERIFYING");
      expect(op?.completedAt).toBeNull();
      const types = db.txFor(TENANT).events.map((e) => e.event_type);
      expect(types).not.toContain("provider.operation_succeeded.v1");
      expect(types).not.toContain("provider.operation_failed.v1");
    } finally {
      delete process.env["PROVIDER_READBACK_EFFECT"];
    }
  });
});

describe("PF05-SECRETREF-05 (1/HIGH) manual resolve can never terminalize a secret-required operation", () => {
  it("SUCCEEDED and FAILED on a secret-required VERIFYING op are rejected with zero state/event changes", async () => {
    const { db, bus } = setupSecretTrialBus({
      outcome: "UNKNOWN",
      detail: "browser: effect unknown",
      externalRef: null,
    });
    const trialId = await requestSecretTrial(bus, "Secret Resolve Block");
    const provisioned = await bus.execute<{ status: string; operationId: string }>(
      actor(),
      "trial.begin_provisioning",
      { trialId },
    );
    expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING" } });
    if (!provisioned.ok) throw new Error("expected secret VERIFYING park");
    const operationId = provisioned.data.operationId;
    const before = probeTrialMemory(db).providerOperations.get(operationId);
    expect(before?.adapterVersion).toBe(SECRET_REQUIRED_ADAPTER_VERSION);
    expect(before?.status).toBe("VERIFYING");
    const eventsBefore = db.txFor(TENANT).events.length;

    for (const outcome of ["SUCCEEDED", "FAILED"] as const) {
      const resolved = await bus.execute(actor(), "provider.resolve_operation", {
        operationId,
        outcome,
        note: "operator claims done",
      });
      expect(resolved.ok).toBe(false);
      if (resolved.ok) throw new Error(`manual ${outcome} on secret-required must be rejected`);
      expect(resolved.code).toBe("precondition_failed");
    }

    // A smuggled adapterVersion in request input never overrides the
    // persisted branch-derived provenance (zod strips it; the guard reads
    // only the stored row).
    const smuggled = await bus.execute(actor(), "provider.resolve_operation", {
      operationId,
      outcome: "SUCCEEDED",
      adapterVersion: "manual-v1",
    });
    expect(smuggled.ok).toBe(false);
    if (smuggled.ok) throw new Error("smuggled adapterVersion must not bypass the guard");
    expect(smuggled.code).toBe("precondition_failed");

    const after = probeTrialMemory(db).providerOperations.get(operationId);
    expect(after?.status).toBe("VERIFYING");
    expect(after?.effectCertainty).toBe("UNKNOWN");
    expect(after?.completedAt).toBeNull();
    expect(db.txFor(TENANT).events.length).toBe(eventsBefore);
    const types = db.txFor(TENANT).events.map((e) => e.event_type);
    expect(types).not.toContain("provider.operation_succeeded.v1");
    expect(types).not.toContain("provider.operation_failed.v1");
    expect(types).not.toContain("trial.activated.v1");
    expect(types).not.toContain("trial.provisioning_failed.v1");
    expect(probeTrialMemory(db).trials.get(trialId)?.lifecycleStatus).toBe("PROVISIONING");
    expect(dumped({ after, response: smuggled })).not.toContain("infisical://");
  });

  it("request/resolve inputs carry no adapterVersion field to override", () => {
    expect("adapterVersion" in requestOperationInput.shape).toBe(false);
    expect("adapterVersion" in resolveOperationInput.shape).toBe(false);
  });

  it("UNKNOWN resolve still parks VERIFYING and pure manual/echo workflows still resolve", async () => {
    const db = new MemoryDb();
    const bus = new CommandBus(db);
    const manual = new ManualProviderOpsAdapter();
    registerProviderCommands(bus, { opsPort: manual });

    const entityA = "a6a6a6a6-a6a6-4a6a-8a6a-a6a6a6a6a6a6";
    const requested = await bus.execute<{ id: string; status: string }>(actor(), "provider.request_operation", {
      action: "custom.ping",
      entityType: "trial",
      entityId: entityA,
      idempotencyKey: "secretref05-manual-ok",
      payload: {},
    });
    expect(requested).toMatchObject({ ok: true, data: { status: "HUMAN_REQUIRED" } });
    if (!requested.ok) throw new Error("expected manual park");
    const resolved = await bus.execute<{ status: string }>(actor(), "provider.resolve_operation", {
      operationId: requested.data.id,
      outcome: "SUCCEEDED",
    });
    expect(resolved).toMatchObject({ ok: true, data: { status: "SUCCEEDED" } });
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("provider.operation_succeeded.v1");

    const entityB = "b6b6b6b6-b6b6-4b6b-8b6b-b6b6b6b6b6b6";
    const requestedB = await bus.execute<{ id: string }>(actor(), "provider.request_operation", {
      action: "custom.ping",
      entityType: "trial",
      entityId: entityB,
      idempotencyKey: "secretref05-manual-unknown",
      payload: {},
    });
    if (!requestedB.ok) throw new Error("expected manual park");
    const parked = await bus.execute<{ status: string }>(actor(), "provider.resolve_operation", {
      operationId: requestedB.data.id,
      outcome: "UNKNOWN",
    });
    expect(parked).toMatchObject({ ok: true, data: { status: "VERIFYING" } });
  });
});

describe("PF05-SECRETREF-05 (2/MEDIUM) synthetic/pure-manual provenance requires exact pairs", () => {
  it("isSyntheticReadbackSubject: only (echo,echo-v1) and (manual,manual-v1) are synthetic", () => {
    expect(isSyntheticReadbackSubject({ adapter: "echo", adapterVersion: "echo-v1" })).toBe(true);
    expect(isSyntheticReadbackSubject({ adapter: "manual", adapterVersion: "manual-v1" })).toBe(true);
    // Case-insensitive exact pairs still match (internally written lowercase).
    expect(isSyntheticReadbackSubject({ adapter: "Echo", adapterVersion: "Echo-V1" })).toBe(true);
    // Missing/blank version is ambiguous, never synthetic.
    expect(isSyntheticReadbackSubject({ adapter: "echo", adapterVersion: null })).toBe(false);
    expect(isSyntheticReadbackSubject({ adapter: "echo", adapterVersion: "" })).toBe(false);
    expect(isSyntheticReadbackSubject({ adapter: "manual", adapterVersion: undefined })).toBe(false);
    expect(isSyntheticReadbackSubject({ adapter: "manual", adapterVersion: "  " })).toBe(false);
    // Missing/unknown adapter is ambiguous, never synthetic.
    expect(isSyntheticReadbackSubject({ adapter: null, adapterVersion: "echo-v1" })).toBe(false);
    expect(isSyntheticReadbackSubject({ adapter: undefined, adapterVersion: "manual-v1" })).toBe(false);
    expect(isSyntheticReadbackSubject({ adapter: "browser", adapterVersion: "echo-v1" })).toBe(false);
    // Cross-mismatch is ambiguous, never synthetic.
    expect(isSyntheticReadbackSubject({ adapter: "echo", adapterVersion: "manual-v1" })).toBe(false);
    expect(isSyntheticReadbackSubject({ adapter: "manual", adapterVersion: "echo-v1" })).toBe(false);
    // Prefix/suffix spoofs and legacy variants are ambiguous, never synthetic.
    expect(isSyntheticReadbackSubject({ adapter: "echo", adapterVersion: "echo-v2" })).toBe(false);
    expect(isSyntheticReadbackSubject({ adapter: "echo", adapterVersion: "echo-v1-extra" })).toBe(false);
    expect(isSyntheticReadbackSubject({ adapter: "echo", adapterVersion: "xecho-v1" })).toBe(false);
    expect(isSyntheticReadbackSubject({ adapter: "manual", adapterVersion: "manual-v2" })).toBe(false);
    expect(isSyntheticReadbackSubject({ adapter: "manual", adapterVersion: "manual-v1x" })).toBe(false);
    expect(isSyntheticReadbackSubject({ adapter: "manual", adapterVersion: "manual-" })).toBe(false);
    // Reserved secret-required version is never synthetic, whatever the adapter name.
    expect(isSyntheticReadbackSubject({ adapter: "browser", adapterVersion: SECRET_REQUIRED_ADAPTER_VERSION })).toBe(
      false,
    );
    expect(isSyntheticReadbackSubject({ adapter: "manual", adapterVersion: SECRET_REQUIRED_ADAPTER_VERSION })).toBe(
      false,
    );
    expect(isSyntheticReadbackSubject({ adapter: "echo", adapterVersion: SECRET_REQUIRED_ADAPTER_VERSION })).toBe(
      false,
    );
  });

  it("trial.cancel auto-cancels only the exact (manual,manual-v1) pair; tampered provenance holds", async () => {
    async function setupManualTrialPark(canonicalName: string) {
      const db = new MemoryDb();
      const bus = new CommandBus(db);
      registerHumanReviewCommands(bus);
      registerPolicyCommands(bus);
      registerCrmCommands(bus);
      const manual = new ManualProviderOpsAdapter();
      registerTrialCommands(bus, { opsPort: manual });
      registerProviderCommands(bus, { opsPort: manual });
      const personRes = await bus.execute<{ id: string }>(actor(), "person.register", { canonicalName });
      expect(personRes.ok).toBe(true);
      if (!personRes.ok) throw new Error("person setup failed");
      const trialRes = await bus.execute<{ id: string | null; status: string }>(actor(), "trial.request", {
        personId: personRes.data.id,
        durationMinutes: 60,
      });
      expect(trialRes.ok).toBe(true);
      if (!trialRes.ok || trialRes.data.id === null) throw new Error("trial setup failed");
      const provisioned = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", {
        trialId: trialRes.data.id,
      });
      if (!provisioned.ok) throw new Error("expected manual park");
      return { db, bus, trialId: trialRes.data.id, operationId: provisioned.data.operationId };
    }

    // Exact pair keeps the existing contract: auto-cancel concludes KNOWN_NOT_APPLIED.
    {
      const { db, bus, trialId, operationId } = await setupManualTrialPark("Exact Pair Cancel");
      expect(probeTrialMemory(db).providerOperations.get(operationId)?.adapterVersion).toBe("manual-v1");
      const cancelled = await bus.execute<{ status: string; cancelledOperations: string[] }>(
        actor(),
        "trial.cancel",
        { trialId },
      );
      expect(cancelled).toMatchObject({ ok: true, data: { status: "CANCELLED" } });
      if (!cancelled.ok) throw new Error("expected cancel ok");
      expect(cancelled.data.cancelledOperations).toEqual([operationId]);
    }

    // Tampered/ambiguous provenance never auto-concludes: suffix spoof, blank, and mismatch all hold.
    for (const [index, tampered] of ["manual-v1-extra", "", "echo-v1"].entries()) {
      const { db, bus, trialId, operationId } = await setupManualTrialPark(`Tampered Cancel ${index}`);
      const mem = probeTrialMemory(db);
      const op = mem.providerOperations.get(operationId);
      if (op === undefined) throw new Error("expected parked operation");
      op.adapterVersion = tampered;
      const cancelled = await bus.execute<{ status: string; cancelledOperations: string[] }>(
        actor(),
        "trial.cancel",
        { trialId },
      );
      expect(cancelled).toMatchObject({ ok: true, data: { status: "CANCELLED", cancelledOperations: [] } });
      const held = probeTrialMemory(db).providerOperations.get(operationId);
      expect(held?.status).toBe("HUMAN_REQUIRED");
      expect(held?.effectCertainty).toBe("UNKNOWN");
    }
  });
});
