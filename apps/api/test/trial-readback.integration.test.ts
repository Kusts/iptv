import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, applyMigrations } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../src/commands/command-bus.js";
import { KyselyCommandDb } from "../src/commands/kysely-command-db.js";
import { registerCrmCommands } from "../src/crm/crm.commands.js";
import { registerPolicyCommands } from "../src/policy/policy.commands.js";
import { registerTrialCommands } from "../src/trial/trial.commands.js";
import { registerProviderCommands } from "../src/provider/provider.commands.js";
import { ProviderDispatcherService } from "../src/provider/provider-dispatcher.service.js";
import type {
  AdapterResult,
  ProviderOperationRequest,
  ProviderOpsPort,
  ProviderReadbackPort,
} from "../src/provider/provider-port.js";
import { FakeTrialReadback, fakeTrialExternalId } from "./fakes/trial-readback-fake.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

const VALID_REF = "infisical://dispatch-trial-readback/BROWSER_WORKER_KEY";

/**
 * FASE5-S6: suite-private per-action trial gate key. Every
 * `trial.provision` request/drain in this file revalidates this row
 * (arranged AVAILABLE in beforeAll); the SHARED
 * `provider.cinevision.trial` row is never touched.
 */
const TEST_TRIAL_CAPABILITY_KEY = "provider.cinevision-itest-trial-readback";

const CONFIGURED_SECRETS_PORT = {
  name: "infisical-test",
  async getSecret(): Promise<string> {
    throw new Error("must never be called by the dispatch path");
  },
};

/** Controllable BROWSER-shaped port (test-only): requires a secret, never a value. */
class FakeBrowserPort implements ProviderOpsPort {
  readonly name = "browser";
  readonly requiresSecretRef = true;
  readonly calls: ProviderOperationRequest[] = [];

  async requestOperation(input: ProviderOperationRequest): Promise<AdapterResult> {
    this.calls.push(input);
    return { outcome: "SUCCEEDED", detail: "browser: ok", externalRef: `op-${input.entityId.slice(0, 8)}` };
  }
}

function dumped(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * FASE5-FIX4-N1: controllable generic effect readback for `reconcileOnce`
 * (the dispatcher seam, outside any transaction). Production uses the stub
 * (always INCONCLUSIVE for secret-required rows); tests inject conclusive
 * answers here to prove each R3 branch.
 */
class ConclusiveGenericReadback implements ProviderReadbackPort {
  constructor(private readonly applied: boolean) {}
  async verify(): Promise<{ effectApplied: boolean; evidence: string; conclusive: boolean }> {
    return { effectApplied: this.applied, evidence: "itest:conclusive-generic", conclusive: true };
  }
}

describe.skipIf(!hasDb)("FASE5-S6 trial readback postcondition gate on Postgres (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });
  const commandDb = new KyselyCommandDb(db);
  const bus = new CommandBus(commandDb);
  const browser = new FakeBrowserPort();
  // Suite-shared readback fake: each test sets `readback.mode` before
  // draining (handlers + dispatcher both reference this instance).
  const readback = new FakeTrialReadback("satisfied");
  const dispatcher = new ProviderDispatcherService(db, commandDb, undefined, TEST_TRIAL_CAPABILITY_KEY);

  const suffix = newId().replace(/-/g, "").slice(-12);

  function actor(tenantId: string): CommandActor {
    return {
      userId: newId(),
      isPlatformAdmin: true,
      tenantId,
      roleKeys: [],
      permissions: [],
      actorType: "human",
    };
  }

  afterEach(() => {
    delete process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"];
  });

  function drainOverrides(accountId: string) {
    return {
      opsPort: browser as ProviderOpsPort,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      trialCapabilityKey: TEST_TRIAL_CAPABILITY_KEY,
      trialDisposableAccountId: accountId,
      trialReadbackPort: readback,
    };
  }

  async function seedTenant(tag: string): Promise<{ tenantId: string; accountId: string }> {
    const tenantId = newId();
    await db
      .insertInto("control.tenants")
      .values({
        id: tenantId,
        slug: `rb-${tag}-${suffix}`,
        name: `Readback ${tag}`,
        status: "ACTIVE",
        default_currency: "BRL",
        timezone: "America/Sao_Paulo",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    let provider = await db
      .selectFrom("provider.providers")
      .select(["id"])
      .where("provider_key", "=", "cinevision")
      .executeTakeFirst();
    if (provider === undefined) {
      provider = await db
        .insertInto("provider.providers")
        .values({
          id: newId(),
          provider_key: "cinevision",
          name: "CINEVISION",
          provider_type: "FULFILLMENT",
          status: "ACTIVE",
          created_at: new Date(),
        })
        .returning(["id"])
        .executeTakeFirstOrThrow();
    }
    const account = await db
      .insertInto("provider.provider_accounts")
      .values({
        id: newId(),
        tenant_id: tenantId,
        provider_id: provider.id,
        name: `Readback account ${tag}`,
        status: "ACTIVE",
        secret_ref: VALID_REF,
        settings_json: { synthetic: true },
        created_at: new Date(),
        updated_at: new Date(),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    return { tenantId, accountId: account.id };
  }

  async function parkTrialProvision(tag: string): Promise<{ tenantId: string; accountId: string; trialId: string; operationId: string }> {
    process.env["PROVIDER_DISPATCH_MODE"] = "durable";
    const { tenantId, accountId } = await seedTenant(tag);
    // The request-handler designation rides on the env (per-test account,
    // cleared in afterEach so designations never leak between tests).
    process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"] = accountId;
    const person = await bus.execute<{ id: string }>(actor(tenantId), "person.register", {
      canonicalName: `Readback ${tag} ${suffix}`,
    });
    if (!person.ok) throw new Error(`person.register failed: ${dumped(person)}`);
    const trial = await bus.execute<{ id: string | null }>(actor(tenantId), "trial.request", {
      personId: person.data.id,
      durationMinutes: 60,
    });
    if (!trial.ok || trial.data.id === null) throw new Error(`trial.request failed: ${dumped(trial)}`);
    const trialId = trial.data.id;
    const provisioned = await bus.execute<{ operationId: string }>(actor(tenantId), "trial.begin_provisioning", {
      trialId,
    });
    if (!provisioned.ok) throw new Error(`begin_provisioning failed: ${dumped(provisioned)}`);
    return { tenantId, accountId, trialId, operationId: provisioned.data.operationId };
  }

  async function getOp(tenantId: string, id: string) {
    return db
      .selectFrom("provider.provider_operations")
      .select(["id", "status", "effect_certainty", "result_summary_json"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  }

  async function getTrial(tenantId: string, id: string) {
    return db
      .selectFrom("trial.trials")
      .select(["id", "lifecycle_status", "provider_binding_id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  }

  async function getBindings(tenantId: string, trialId: string) {
    return db
      .selectFrom("provider.provider_bindings")
      .select(["id", "external_id"])
      .where("tenant_id", "=", tenantId)
      .where("entity_type", "=", "trial")
      .where("entity_id", "=", trialId)
      .execute();
  }

  async function getReadbackEvidence(tenantId: string, operationId: string) {
    return db
      .selectFrom("provider.provider_evidence")
      .select(["evidence_type", "structured_json"])
      .where("tenant_id", "=", tenantId)
      .where("provider_operation_id", "=", operationId)
      .where("evidence_type", "=", "TRIAL_READBACK_POSTCONDITION")
      .execute();
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    await db
      .updateTable("platform.capabilities")
      .set({ availability: "AVAILABLE", certification_status: "CERTIFIED" })
      .where("key", "=", "provider.cinevision")
      .execute();
    await db
      .insertInto("platform.capabilities")
      .values({
        id: newId(),
        key: TEST_TRIAL_CAPABILITY_KEY,
        owner_context: "provider",
        availability: "AVAILABLE",
        certification_status: "CERTIFIED",
        risk_level: "HIGH",
        mvp_phase: "W0",
        manual_equivalent: "manual",
        policy_family: "provider-integration",
        degradation: "Isolated test gate (FASE5-S6); mirrors provider.cinevision.trial",
        permissions: [],
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          availability: "AVAILABLE",
          certification_status: "CERTIFIED",
          updated_at: new Date(),
        }),
      )
      .execute();
    process.env["PROVIDER_DISPATCH_MODE"] = "durable";
    delete process.env["PROVIDER_READBACK_EFFECT"];
    registerCrmCommands(bus);
    registerPolicyCommands(bus);
    registerTrialCommands(bus, {
      opsPort: browser as ProviderOpsPort,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      trialCapabilityKey: TEST_TRIAL_CAPABILITY_KEY,
      trialReadbackPort: readback,
    });
    registerProviderCommands(bus, {
      opsPort: browser as ProviderOpsPort,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      trialCapabilityKey: TEST_TRIAL_CAPABILITY_KEY,
      trialReadbackPort: readback,
    });
  });

  it("AC1: satisfied readback → ACTIVE + binding + KNOWN_APPLIED + evidência sanitizada", async () => {
    readback.mode = "satisfied";
    const callsBefore = browser.calls.length;
    const { tenantId, accountId, trialId, operationId } = await parkTrialProvision(`happy-${suffix}`);
    expect(browser.calls).toHaveLength(callsBefore);
    const drained = await dispatcher.drainOnce(10, drainOverrides(accountId));
    expect(drained.claimed).toBe(1);
    expect(drained.succeeded).toBe(1);
    expect(browser.calls).toHaveLength(callsBefore + 1);

    const op = await getOp(tenantId, operationId);
    expect(op.status).toBe("SUCCEEDED");
    expect(op.effect_certainty).toBe("KNOWN_APPLIED");
    expect(op.result_summary_json).toMatchObject({ readback: "conclusive", postcondition: "satisfied" });
    expect(dumped(op.result_summary_json)).not.toContain("infisical://");

    const trial = await getTrial(tenantId, trialId);
    expect(trial.lifecycle_status).toBe("ACTIVE");

    const bindings = await getBindings(tenantId, trialId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.external_id).toBe(fakeTrialExternalId(trialId));
    expect(trial.provider_binding_id).toBe(bindings[0]?.id);

    const evidence = await getReadbackEvidence(tenantId, operationId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.structured_json).toMatchObject({ readback: "conclusive", postcondition: "satisfied" });
    expect(dumped(evidence[0]?.structured_json)).not.toContain("infisical://");
    expect(dumped(evidence[0]?.structured_json)).not.toContain("fake:conclusive");
  });

  it("AC2: postcondition violada → HUMAN_REQUIRED + POSTCONDITION_MISMATCH, nunca ACTIVE, sem binding", async () => {
    readback.mode = "not-trial";
    const callsBefore = browser.calls.length;
    const { tenantId, accountId, trialId, operationId } = await parkTrialProvision(`violated-${suffix}`);
    const drained = await dispatcher.drainOnce(10, drainOverrides(accountId));
    expect(drained.claimed).toBe(1);
    expect(drained.humanRequired).toBe(1);
    // Exactly one POST; the mismatch never re-sends.
    expect(browser.calls).toHaveLength(callsBefore + 1);

    const op = await getOp(tenantId, operationId);
    expect(op.status).toBe("HUMAN_REQUIRED");
    expect(op.effect_certainty).toBe("UNKNOWN");
    expect(op.result_summary_json).toMatchObject({ error_code: "POSTCONDITION_MISMATCH", postcondition: "not_trial" });

    const trial = await getTrial(tenantId, trialId);
    expect(trial.lifecycle_status).toBe("PROVISIONING");
    expect(trial.provider_binding_id).toBeNull();
    expect(await getBindings(tenantId, trialId)).toHaveLength(0);

    const evidence = await getReadbackEvidence(tenantId, operationId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.structured_json).toMatchObject({ readback: "conclusive", postcondition: "not_trial" });
  });

  it("AC3+AC5: readback inconclusivo → VERIFYING; recovery não re-executa; reconcile agenda e recovery converge", async () => {
    readback.mode = "inconclusive";
    const callsBefore = browser.calls.length;
    const { tenantId, accountId, trialId, operationId } = await parkTrialProvision(`verifying-${suffix}`);
    const drained = await dispatcher.drainOnce(10, drainOverrides(accountId));
    expect(drained.claimed).toBe(1);
    expect(drained.verifying).toBe(1);
    expect(browser.calls).toHaveLength(callsBefore + 1);

    const parked = await getOp(tenantId, operationId);
    expect(parked.status).toBe("VERIFYING");
    expect(parked.effect_certainty).toBe("UNKNOWN");

    // Crash-after-send recovery: a post-send VERIFYING row is inert —
    // recoverOnce releases/parks nothing and never re-sends the POST.
    const recovered = await dispatcher.recoverOnce(100, drainOverrides(accountId));
    expect(recovered.released).toBe(0);
    expect(recovered.verifying).toBe(0);
    expect(browser.calls).toHaveLength(callsBefore + 1);
    expect((await getOp(tenantId, operationId)).status).toBe("VERIFYING");

    // S3 convergence owns the rest: reconcile only SCHEDULES (zero in-tx
    // I/O), and the dispatcher recovery converges inconclusive → HUMAN_REQUIRED.
    const scheduled = await bus.execute<{
      status: string;
      effectCertainty: string;
      reconciliation?: string;
    }>(actor(tenantId), "provider.reconcile", { operationId });
    expect(scheduled).toMatchObject({
      ok: true,
      data: { status: "VERIFYING", effectCertainty: "UNKNOWN", reconciliation: "scheduled" },
    });
    expect(browser.calls).toHaveLength(callsBefore + 1);
    expect((await getOp(tenantId, operationId)).status).toBe("VERIFYING");

    const reconciled = await dispatcher.reconcileOnce(100, drainOverrides(accountId));
    // Row-scoped asserts: the recovery sweep is GLOBAL by design (like
    // drainOnce), so parallel suites may contribute candidates — what
    // matters is OUR row converging with no re-send.
    expect(reconciled.operationIds).toContain(operationId);
    expect(reconciled.humanRequired).toBeGreaterThanOrEqual(1);
    expect(browser.calls).toHaveLength(callsBefore + 1);
    const converged = await getOp(tenantId, operationId);
    expect(converged.status).toBe("HUMAN_REQUIRED");
    expect(converged.effect_certainty).toBe("UNKNOWN");
    const trial = await getTrial(tenantId, trialId);
    expect(trial.lifecycle_status).toBe("PROVISIONING");
    expect(await getBindings(tenantId, trialId)).toHaveLength(0);
  });

  it("FIX4-AC2: conclusive snapshot WITHOUT customer → HUMAN_REQUIRED via recovery, repeat reconcile writes nothing", async () => {
    readback.mode = "inconclusive";
    const callsBefore = browser.calls.length;
    const { tenantId, accountId, trialId, operationId } = await parkTrialProvision(`nullcust-${suffix}`);
    const drained = await dispatcher.drainOnce(10, drainOverrides(accountId));
    expect(drained.claimed).toBe(1);
    expect(drained.verifying).toBe(1);
    expect((await getOp(tenantId, operationId)).status).toBe("VERIFYING");

    // N2: the READ_CUSTOMER snapshot is conclusive but carries no customer
    // — no proof either way, so recovery converges HUMAN_REQUIRED directly
    // instead of re-parking VERIFYING (no self-loop).
    readback.mode = "null-customer";
    const reconciled = await dispatcher.reconcileOnce(100, {
      ...drainOverrides(accountId),
      readbackPort: new ConclusiveGenericReadback(true),
    });
    // Row-scoped (global sweep under parallelism — see the S3 test above).
    expect(reconciled.operationIds).toContain(operationId);
    expect(reconciled.humanRequired).toBeGreaterThanOrEqual(1);
    expect(reconciled.verifying).toBe(0);
    expect(browser.calls).toHaveLength(callsBefore + 1);
    const converged = await getOp(tenantId, operationId);
    expect(converged.status).toBe("HUMAN_REQUIRED");
    expect(converged.effect_certainty).toBe("UNKNOWN");
    expect((await getTrial(tenantId, trialId)).lifecycle_status).toBe("PROVISIONING");
    expect(await getBindings(tenantId, trialId)).toHaveLength(0);

    const attemptsAfter = await db
      .selectFrom("provider.provider_operation_attempts")
      .select(["attempt_no"])
      .where("tenant_id", "=", tenantId)
      .where("provider_operation_id", "=", operationId)
      .execute();
    // A repeat reconcile only schedules (zero writes) and a repeat
    // recovery finds nothing left to do (row already converged).
    const scheduled = await bus.execute<{ status: string; reconciliation?: string }>(
      actor(tenantId),
      "provider.reconcile",
      { operationId },
    );
    expect(scheduled).toMatchObject({ ok: true, data: { status: "HUMAN_REQUIRED" } });
    expect(scheduled).not.toMatchObject({ data: { reconciliation: "scheduled" } });
    const attemptsAgain = await db
      .selectFrom("provider.provider_operation_attempts")
      .select(["attempt_no"])
      .where("tenant_id", "=", tenantId)
      .where("provider_operation_id", "=", operationId)
      .execute();
    expect(attemptsAgain).toHaveLength(attemptsAfter.length);
    const second = await dispatcher.reconcileOnce(100, {
      ...drainOverrides(accountId),
      readbackPort: new ConclusiveGenericReadback(true),
    });
    // Our converged row is never revisited (other suites' rows may be
    // swept — the sweep is global by design).
    expect(second.operationIds).not.toContain(operationId);
    expect(browser.calls).toHaveLength(callsBefore + 1);
  });

  it("FIX4-R3: reconcileOnce satisfied → SUCCEEDED/ACTIVE+binding (never bare 200)", async () => {
    readback.mode = "inconclusive";
    const callsBefore = browser.calls.length;
    const { tenantId, accountId, trialId, operationId } = await parkTrialProvision(`rec-sat-${suffix}`);
    expect((await dispatcher.drainOnce(10, drainOverrides(accountId))).verifying).toBe(1);

    readback.mode = "satisfied";
    const reconciled = await dispatcher.reconcileOnce(100, {
      ...drainOverrides(accountId),
      readbackPort: new ConclusiveGenericReadback(true),
    });
    expect(reconciled.operationIds).toContain(operationId);
    expect(reconciled.succeeded).toBeGreaterThanOrEqual(1);
    expect(browser.calls).toHaveLength(callsBefore + 1);
    const op = await getOp(tenantId, operationId);
    expect(op.status).toBe("SUCCEEDED");
    expect(op.effect_certainty).toBe("KNOWN_APPLIED");
    expect((await getTrial(tenantId, trialId)).lifecycle_status).toBe("ACTIVE");
    const bindings = await getBindings(tenantId, trialId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.external_id).toBe(fakeTrialExternalId(trialId));
  });

  it("FIX4-R3: reconcileOnce violated postcondition → HUMAN_REQUIRED/POSTCONDITION_MISMATCH, never ACTIVE", async () => {
    readback.mode = "inconclusive";
    const callsBefore = browser.calls.length;
    const { tenantId, accountId, trialId, operationId } = await parkTrialProvision(`rec-vio-${suffix}`);
    expect((await dispatcher.drainOnce(10, drainOverrides(accountId))).verifying).toBe(1);

    readback.mode = "not-trial";
    const reconciled = await dispatcher.reconcileOnce(100, {
      ...drainOverrides(accountId),
      readbackPort: new ConclusiveGenericReadback(true),
    });
    expect(reconciled.operationIds).toContain(operationId);
    expect(reconciled.humanRequired).toBeGreaterThanOrEqual(1);
    expect(browser.calls).toHaveLength(callsBefore + 1);
    const op = await getOp(tenantId, operationId);
    expect(op.status).toBe("HUMAN_REQUIRED");
    expect(op.result_summary_json).toMatchObject({ error_code: "POSTCONDITION_MISMATCH", postcondition: "not_trial" });
    expect((await getTrial(tenantId, trialId)).lifecycle_status).toBe("PROVISIONING");
    expect(await getBindings(tenantId, trialId)).toHaveLength(0);
  });

  it("FIX4-R3: reconcileOnce conclusive NOT_APPLIED → FAILED with the trial back in REQUESTED", async () => {
    readback.mode = "inconclusive";
    const callsBefore = browser.calls.length;
    const { tenantId, accountId, trialId, operationId } = await parkTrialProvision(`rec-na-${suffix}`);
    expect((await dispatcher.drainOnce(10, drainOverrides(accountId))).verifying).toBe(1);

    const reconciled = await dispatcher.reconcileOnce(100, {
      ...drainOverrides(accountId),
      readbackPort: new ConclusiveGenericReadback(false),
    });
    expect(reconciled.operationIds).toContain(operationId);
    expect(reconciled.failed).toBeGreaterThanOrEqual(1);
    expect(browser.calls).toHaveLength(callsBefore + 1);
    const op = await getOp(tenantId, operationId);
    expect(op.status).toBe("FAILED");
    expect(op.effect_certainty).toBe("KNOWN_NOT_APPLIED");
    expect((await getTrial(tenantId, trialId)).lifecycle_status).toBe("REQUESTED");
  });

  it("FIX5: hanging generic verify converges HUMAN_REQUIRED inside the budget (never wedges recovery)", async () => {
    readback.mode = "inconclusive";
    const callsBefore = browser.calls.length;
    const { tenantId, accountId, trialId, operationId } = await parkTrialProvision(`hang-gen-${suffix}`);
    expect((await dispatcher.drainOnce(10, drainOverrides(accountId))).verifying).toBe(1);

    // SPEC §35: a generic verify that never settles resolves to
    // inconclusive within the injected budget — no long sleep, no re-send,
    // scheduler tick / admin drain never stuck.
    const hangingGeneric: ProviderReadbackPort = {
      verify: () => new Promise<never>(() => undefined),
    };
    const reconciled = await dispatcher.reconcileOnce(100, {
      ...drainOverrides(accountId),
      readbackPort: hangingGeneric,
      genericReadbackTimeoutMs: 20,
    });
    expect(reconciled.operationIds).toContain(operationId);
    expect(reconciled.humanRequired).toBeGreaterThanOrEqual(1);
    expect(browser.calls).toHaveLength(callsBefore + 1);
    const op = await getOp(tenantId, operationId);
    expect(op.status).toBe("HUMAN_REQUIRED");
    expect(op.effect_certainty).toBe("UNKNOWN");
    expect((await getTrial(tenantId, trialId)).lifecycle_status).toBe("PROVISIONING");
    expect(await getBindings(tenantId, trialId)).toHaveLength(0);
  });

  it("AC5: segundo drain não duplica o binding (upsert idempotente)", async () => {
    readback.mode = "satisfied";
    const { tenantId, accountId, trialId, operationId } = await parkTrialProvision(`idempotent-${suffix}`);
    const first = await dispatcher.drainOnce(10, drainOverrides(accountId));
    expect(first.succeeded).toBe(1);
    expect(await getBindings(tenantId, trialId)).toHaveLength(1);
    // The terminal row is never reclaimed; the binding stays exactly one.
    const second = await dispatcher.drainOnce(10, drainOverrides(accountId));
    expect(second.claimed).toBe(0);
    expect(await getBindings(tenantId, trialId)).toHaveLength(1);
    expect((await getOp(tenantId, operationId)).status).toBe("SUCCEEDED");
    expect((await getTrial(tenantId, trialId)).lifecycle_status).toBe("ACTIVE");
  });
});
