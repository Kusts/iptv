import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createDb, applyMigrations } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../src/commands/command-bus.js";
import { KyselyCommandDb } from "../src/commands/kysely-command-db.js";
import { registerCrmCommands } from "../src/crm/crm.commands.js";
import { registerPolicyCommands } from "../src/policy/policy.commands.js";
import { registerTrialCommands } from "../src/trial/trial.commands.js";
import { registerProviderCommands, applySecretPortOutcome } from "../src/provider/provider.commands.js";
import { ProviderDispatcherService } from "../src/provider/provider-dispatcher.service.js";
import { PROVIDER_CALL_UNCERTAIN_CODE } from "../src/provider/provider-secret-gate.js";
import type {
  AdapterResult,
  ProviderOperationRequest,
  ProviderOpsPort,
} from "../src/provider/provider-port.js";
import { FakeTrialReadback } from "./fakes/trial-readback-fake.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

const VALID_REF = "infisical://dispatch-integration/BROWSER_WORKER_KEY";

/**
 * CV-DSP-02-FIX2: isolated capability key for this suite's UNAVAILABLE flips.
 * The GLOBAL `provider.cinevision` row is NEVER flipped by this file (it stays
 * AVAILABLE for the inline request gates); D4 flips ONLY this private row and
 * drains through a dispatcher bound to it, so parallel suites never observe
 * the transient UNAVAILABLE.
 */
const TEST_DISPATCH_CAPABILITY_KEY = "provider.cinevision-itest-provider";

/**
 * FASE5-S4S5: isolated per-action trial gate key for this suite's trial
 * writes. The SHARED `provider.cinevision.trial` row is NEVER flipped by
 * this file (it stays UNAVAILABLE); every trial-capability arrange lands on
 * this private row via the `trialCapabilityKey` seams (handler deps +
 * dispatcher overrides), so parallel suites never observe each other's
 * trial-gate flips.
 */
const TEST_TRIAL_CAPABILITY_KEY = "provider.cinevision-itest-provider-trial";

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
  mode: "success" | "manual" | "hang" = "success";

  async requestOperation(input: ProviderOperationRequest): Promise<AdapterResult> {
    this.calls.push(input);
    if (this.mode === "hang") {
      return new Promise<AdapterResult>(() => undefined);
    }
    if (this.mode === "manual") {
      return { outcome: "MANUAL", detail: "browser: parked", externalRef: null };
    }
    return { outcome: "SUCCEEDED", detail: "browser: ok", externalRef: `op-${input.entityId.slice(0, 8)}` };
  }
}

function dumped(value: unknown): string {
  return JSON.stringify(value ?? null);
}

describe.skipIf(!hasDb)("CV-DSP-01 durable dispatch end-to-end (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });
  const commandDb = new KyselyCommandDb(db);
  const bus = new CommandBus(commandDb);
  const browser = new FakeBrowserPort();
  const dispatcher = new ProviderDispatcherService(db, commandDb, undefined, TEST_TRIAL_CAPABILITY_KEY);
  // FASE5-S6: the REAL `trial.provision` SUCCEEDED now gates on a conclusive
  // READ_CUSTOMER readback (StubTrialReadback is fail-closed INCONCLUSIVE →
  // VERIFYING). The suite default satisfies it so these drains keep proving
  // their original invariants (claim, lease, fencing, provenance, D3 no-tx,
  // isolation) with the readback step in place.
  const readback = new FakeTrialReadback("satisfied");
  // CV-DSP-02-FIX2: D4 drains through this instance, bound to the suite's
  // private capability row — the GLOBAL row is never flipped. FASE5-S4S5:
  // both instances also bind the suite-private TRIAL row (4th arg) — the
  // SHARED `provider.cinevision.trial` row is never flipped either.
  const isolatedDispatcher = new ProviderDispatcherService(
    db,
    commandDb,
    TEST_DISPATCH_CAPABILITY_KEY,
    TEST_TRIAL_CAPABILITY_KEY,
  );

  const suffix = newId().replace(/-/g, "").slice(-12);
  let tenantA = "";
  let tenantB = "";
  let accountA = "";
  let accountB = "";

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

  // FASE5-S4S5: restore the suite designation after every test, even on
  // failure — per-test designations (F1b/F1c) must never leak into the
  // tenantA tests that follow.
  afterEach(() => {
    process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"] = accountA;
  });

  function overrides() {
    return {
      opsPort: browser as ProviderOpsPort,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      // FASE5-S4S5: suite-private trial row (never the shared gate row);
      // the designation rides on `PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID`
      // (suite global = accountA, overridden per-test with restoration).
      trialCapabilityKey: TEST_TRIAL_CAPABILITY_KEY,
      // FASE5-S6: conclusive READ_CUSTOMER so SUCCEEDED terminalizes.
      trialReadbackPort: readback,
    };
  }

  async function requestDurableResult(
    tenantId: string,
    key: string,
  ): Promise<{
    trialId: string;
    result: { ok: boolean; code?: string; message?: string; data?: { id: string; status: string; effectCertainty: string } };
  }> {
    // FASE5-S3/AC4 (S2 gate): `provider.request_operation` with
    // `action=trial.provision` requires a real REQUESTED trial with a
    // persisted ALLOW — a synthetic entity id is refused with not_found
    // before any port call. Same proven pattern as
    // multidomain-dispatch.integration: a fresh person + trial per call.
    const person = await bus.execute<{ id: string }>(actor(tenantId), "person.register", {
      canonicalName: `Dispatch ${key}`,
    });
    if (!person.ok) throw new Error(`person.register failed: ${dumped(person)}`);
    const trial = await bus.execute<{ id: string | null }>(actor(tenantId), "trial.request", {
      personId: person.data.id,
      durationMinutes: 60,
    });
    if (!trial.ok || trial.data.id === null) throw new Error(`trial.request failed: ${dumped(trial)}`);
    const result = await bus.execute<{ id: string; status: string; effectCertainty: string }>(
      actor(tenantId),
      "provider.request_operation",
      {
        action: "trial.provision",
        entityType: "trial",
        entityId: trial.data.id,
        idempotencyKey: `${key}-${suffix}`,
        payload: { duration_minutes: 60 },
      },
    );
    if (!result.ok) {
      return { trialId: trial.data.id, result: { ok: false, code: result.code, message: result.message } };
    }
    return { trialId: trial.data.id, result: { ok: true, data: result.data } };
  }

  async function requestDurable(tenantId: string, key: string): Promise<{ id: string; status: string; effectCertainty: string }> {
    const { result } = await requestDurableResult(tenantId, key);
    if (!result.ok || result.data === undefined) throw new Error(`request failed: ${dumped(result)}`);
    return result.data;
  }

  async function getOp(tenantId: string, id: string) {
    return db
      .selectFrom("provider.provider_operations")
      .select([
        "id",
        "tenant_id",
        "status",
        "effect_certainty",
        "claimed_by",
        "lease_expires_at",
        "dispatch_started_at",
        "requested_payload_json",
        "result_summary_json",
      ])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  }

  async function getAttempts(tenantId: string, id: string) {
    return db
      .selectFrom("provider.provider_operation_attempts")
      .select(["attempt_no", "status", "error_code", "dispatch_started_at"])
      .where("tenant_id", "=", tenantId)
      .where("provider_operation_id", "=", id)
      .orderBy("attempt_no", "asc")
      .execute();
  }

  async function getEventTypes(tenantId: string, id: string): Promise<string[]> {
    const rows = await db
      .selectFrom("platform.domain_events")
      .select(["event_type"])
      .where("tenant_id", "=", tenantId)
      .where("aggregate_id", "=", id)
      .orderBy("aggregate_version", "asc")
      .execute();
    return rows.map((row) => row.event_type);
  }

  async function seedTenant(tag: string): Promise<{ tenantId: string; accountId: string }> {
    const tenantId = newId();
    await db
      .insertInto("control.tenants")
      .values({
        id: tenantId,
        slug: `disp-${tag}-${suffix}`,
        name: `Dispatch ${tag}`,
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
        name: `Dispatch account ${tag}`,
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

  async function ensureTestCapabilityKey(key: string, availability: "AVAILABLE" | "UNAVAILABLE"): Promise<void> {
    await db
      .insertInto("platform.capabilities")
      .values({
        id: newId(),
        key,
        owner_context: "provider",
        availability,
        certification_status: "CERTIFIED",
        risk_level: "HIGH",
        mvp_phase: "W0",
        manual_equivalent: "Provider operator fulfills the operation manually (HITL) via provider.resolve_operation",
        policy_family: "provider-integration",
        degradation: "Isolated test gate (CV-DSP-02-FIX2); mirrors provider.cinevision",
        permissions: [],
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          availability,
          certification_status: "CERTIFIED",
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  async function ensureTestCapability(availability: "AVAILABLE" | "UNAVAILABLE"): Promise<void> {
    await ensureTestCapabilityKey(TEST_DISPATCH_CAPABILITY_KEY, availability);
  }

  /**
   * FASE5-S4S5: arrange the suite-private per-action trial row the request
   * handlers (`trialCapabilityKey` dep) and the dispatcher (4th ctor arg /
   * `trialCapabilityKey` override) revalidate. The SHARED
   * `provider.cinevision.trial` row is never touched.
   */
  async function ensureTestTrialCapability(availability: "AVAILABLE" | "UNAVAILABLE"): Promise<void> {
    await ensureTestCapabilityKey(TEST_TRIAL_CAPABILITY_KEY, availability);
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    // The W0 fail-closed gate (migration 044) registers `provider.cinevision`
    // as UNAVAILABLE, which blocks every secret-required request. Durable
    // dispatch is the post-certification path, so this disposable DB fixture
    // flips the gate to AVAILABLE — production stays fail-closed until
    // real certification.
    // CV-DSP-02-FIX2: the GLOBAL row stays AVAILABLE for the whole suite (no
    // test flips it back); D4 proves UNAVAILABLE→HUMAN_REQUIRED on the private
    // TEST_DISPATCH_CAPABILITY_KEY row instead.
    await db
      .updateTable("platform.capabilities")
      .set({ availability: "AVAILABLE", certification_status: "CERTIFIED" })
      .where("key", "=", "provider.cinevision")
      .execute();
    await ensureTestCapability("AVAILABLE");
    // FASE5-S4S5: the suite-private trial row stays AVAILABLE for the whole
    // suite (the SHARED `provider.cinevision.trial` row is never flipped);
    // trial designation tests flip only the designation, never this row.
    await ensureTestTrialCapability("AVAILABLE");
    process.env["PROVIDER_DISPATCH_MODE"] = "durable";
    delete process.env["PROVIDER_READBACK_EFFECT"];
    registerCrmCommands(bus);
    registerPolicyCommands(bus);
    registerTrialCommands(bus, {
      opsPort: browser as ProviderOpsPort,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      // FASE5-S4S5: handlers revalidate the suite-private trial row; the
      // designation rides on the env (suite global = accountA below,
      // overridden per-test with restoration where the tenant changes).
      trialCapabilityKey: TEST_TRIAL_CAPABILITY_KEY,
    });
    registerProviderCommands(bus, {
      opsPort: browser as ProviderOpsPort,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      trialCapabilityKey: TEST_TRIAL_CAPABILITY_KEY,
    });
    const a = await seedTenant("a");
    tenantA = a.tenantId;
    accountA = a.accountId;
    const b = await seedTenant("b");
    tenantB = b.tenantId;
    accountB = b.accountId;
    void accountB;
    // FASE5-S4S5 suite designation: controlled trial writes target tenantA's
    // disposable account. Tests using another tenant either expect the
    // fail-closed refusal or override + restore this variable.
    process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"] = accountA;
  }, 120_000);

  afterAll(async () => {
    delete process.env["PROVIDER_DISPATCH_MODE"];
    delete process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"];
    await db.destroy().catch(() => undefined);
  });

  it("inline secret trial.provision queues without executing (SPEC §41 parity with durable)", async () => {
    delete process.env["PROVIDER_DISPATCH_MODE"];
    browser.mode = "manual";
    try {
      const before = browser.calls.length;
      const data = await requestDurable(tenantA, "inline-default");
      // FASE5-S6-FIX2 (SPEC §41): the secret-required `trial.provision`
      // NEVER executes inline — zero port calls inside the command
      // transaction, same queue-only contract as the durable cut.
      expect(data.status).toBe("QUEUED");
      expect(data.effectCertainty).toBe("UNKNOWN");
      expect(browser.calls.length).toBe(before);
      const stored = await getOp(tenantA, data.id);
      expect(stored.status).toBe("REQUESTED");
      expect(stored.effect_certainty).toBe("UNKNOWN");
      // Tidy: the queued intent stays claimable — a later drain would pick
      // it up and break per-test claimed counts. Drain it here (manual
      // mode parks HUMAN_REQUIRED, inert to every later scan).
      const tidied = await dispatcher.drainOnce(10, overrides());
      expect(tidied.operationIds).toContain(data.id);
      expect((await getOp(tenantA, data.id)).status).toBe("HUMAN_REQUIRED");
    } finally {
      browser.mode = "success";
      process.env["PROVIDER_DISPATCH_MODE"] = "durable";
    }
  });

  it("durable returns QUEUED without effect; drain executes to terminal", async () => {
    browser.mode = "success";
    const before = browser.calls.length;
    const data = await requestDurable(tenantA, "durable-terminal");
    expect(data.status).toBe("QUEUED");
    expect(data.effectCertainty).toBe("UNKNOWN");
    expect(browser.calls.length).toBe(before);

    const stored = await getOp(tenantA, data.id);
    expect(stored.status).toBe("REQUESTED");
    expect(stored.effect_certainty).toBe("UNKNOWN");

    const drained = await dispatcher.drainOnce(10, overrides());
    expect(drained.claimed).toBe(1);
    expect(drained.succeeded).toBe(1);
    expect(browser.calls.length).toBe(before + 1);
    // The port receives the projected payload + the validated ref string only.
    const call = browser.calls[browser.calls.length - 1] as ProviderOperationRequest;
    expect(call.secretRef).toBe(VALID_REF);
    expect(dumped(call.payload)).not.toContain("infisical://");

    const terminal = await getOp(tenantA, data.id);
    expect(terminal.status).toBe("SUCCEEDED");
    expect(terminal.effect_certainty).toBe("KNOWN_APPLIED");
    expect(terminal.claimed_by).toBeNull();
    expect(terminal.lease_expires_at).toBeNull();
    expect(terminal.dispatch_started_at).not.toBeNull();

    const attempts = await getAttempts(tenantA, data.id);
    expect(attempts.map((a) => [Number(a.attempt_no), a.status])).toEqual([
      [1, "STARTED"],
      [2, "SUCCEEDED"],
    ]);
    expect(attempts[0]?.dispatch_started_at).not.toBeNull();

    expect(await getEventTypes(tenantA, data.id)).toEqual([
      "provider.operation_requested.v1",
      "provider.operation_succeeded.v1",
    ]);

    const leakScan = dumped({
      requested: terminal.requested_payload_json,
      summary: terminal.result_summary_json,
      events: await db
        .selectFrom("platform.domain_events")
        .select(["event_type"])
        .where("tenant_id", "=", tenantA)
        .where("aggregate_id", "=", data.id)
        .execute(),
    });
    expect(leakScan).not.toContain("infisical://");
  });

  it("concurrent drains never double-claim (SKIP LOCKED)", async () => {
    browser.mode = "success";
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await requestDurable(tenantA, `double-claim-${i}`)).id);
    }
    const [first, second] = await Promise.all([dispatcher.drainOnce(10, overrides()), dispatcher.drainOnce(10, overrides())]);
    const claimed = [...first.operationIds, ...second.operationIds].sort();
    expect(claimed).toEqual([...ids].sort());
    expect(first.claimed + second.claimed).toBe(3);
    for (const id of ids) {
      const attempts = await getAttempts(tenantA, id);
      expect(attempts.filter((a) => a.status === "STARTED")).toHaveLength(1);
      expect((await getOp(tenantA, id)).status).toBe("SUCCEEDED");
    }
    // Nothing left to claim.
    expect((await dispatcher.drainOnce(10, overrides())).claimed).toBe(0);
  });

  it("pre-send lease expiry releases to REQUESTED and re-executes", async () => {
    browser.mode = "success";
    const before = browser.calls.length;
    const data = await requestDurable(tenantA, "pre-send-crash");
    await db
      .updateTable("provider.provider_operations")
      .set({
        status: "QUEUED",
        claimed_by: "crashed-worker",
        claimed_at: new Date(),
        lease_expires_at: sql`now() - make_interval(secs => 60)`,
        dispatch_started_at: null,
      })
      .where("tenant_id", "=", tenantA)
      .where("id", "=", data.id)
      .execute();

    const recovered = await dispatcher.recoverOnce(10);
    expect(recovered.released).toBe(1);
    expect(browser.calls.length).toBe(before);
    const released = await getOp(tenantA, data.id);
    expect(released.status).toBe("REQUESTED");
    expect(released.effect_certainty).toBe("UNKNOWN");
    expect(released.claimed_by).toBeNull();

    const drained = await dispatcher.drainOnce(10, overrides());
    expect(drained.succeeded).toBe(1);
    expect(browser.calls.length).toBe(before + 1);
    expect((await getOp(tenantA, data.id)).status).toBe("SUCCEEDED");
  });

  it("post-send lease expiry parks VERIFYING/UNKNOWN and never re-executes", async () => {
    browser.mode = "success";
    const data = await requestDurable(tenantA, "post-send-crash");
    // Simulate a crash AFTER the send frontier was committed.
    await db
      .updateTable("provider.provider_operations")
      .set({
        status: "RUNNING",
        claimed_by: "crashed-worker",
        claimed_at: new Date(),
        lease_expires_at: sql`now() - make_interval(secs => 60)`,
        dispatch_started_at: new Date(),
      })
      .where("tenant_id", "=", tenantA)
      .where("id", "=", data.id)
      .execute();
    const callsBefore = browser.calls.length;

    const recovered = await dispatcher.recoverOnce(10);
    expect(recovered.verifying).toBe(1);
    expect(browser.calls.length).toBe(callsBefore);
    const parked = await getOp(tenantA, data.id);
    expect(parked.status).toBe("VERIFYING");
    expect(parked.effect_certainty).toBe("UNKNOWN");
    expect(parked.claimed_by).toBeNull();
    const attempts = await getAttempts(tenantA, data.id);
    expect(attempts.map((a) => a.status)).toContain("VERIFYING");
    expect(attempts.find((a) => a.status === "VERIFYING")?.error_code).toBe(PROVIDER_CALL_UNCERTAIN_CODE);

    // The dispatcher never picks a VERIFYING row back up.
    expect((await dispatcher.drainOnce(10, overrides())).claimed).toBe(0);
    expect(browser.calls.length).toBe(callsBefore);

    // FASE5-FIX4-N1 (§12/§41): `provider.reconcile` only SCHEDULES a real
    // trial reconciliation (zero in-tx I/O, row stays VERIFYING) — the
    // durable dispatcher recovery owns resolution from here: the
    // secret-required stub stays INCONCLUSIVE, so `reconcileOnce` converges
    // the op to HUMAN_REQUIRED with no retry and no second send.
    const scheduled = await bus.execute<{ status: string; effectCertainty: string; reconciliation?: string }>(
      actor(tenantA),
      "provider.reconcile",
      { operationId: data.id },
    );
    expect(scheduled).toMatchObject({
      ok: true,
      data: { status: "VERIFYING", effectCertainty: "UNKNOWN", reconciliation: "scheduled" },
    });
    expect((await getOp(tenantA, data.id)).status).toBe("VERIFYING");
    expect(browser.calls.length).toBe(callsBefore);

    const reconciled = await dispatcher.reconcileOnce(100, overrides());
    // Row-scoped: the recovery sweep is GLOBAL by design (like drainOnce),
    // so parallel suites may contribute candidates.
    expect(reconciled.operationIds).toContain(data.id);
    expect(reconciled.humanRequired).toBeGreaterThanOrEqual(1);
    expect(browser.calls.length).toBe(callsBefore);
    const converged = await getOp(tenantA, data.id);
    expect(converged.status).toBe("HUMAN_REQUIRED");
    expect(converged.effect_certainty).toBe("UNKNOWN");
  });

  it("a hanging port parks VERIFYING/UNKNOWN via the send timeout (never FAILED)", async () => {
    browser.mode = "hang";
    try {
      const data = await requestDurable(tenantA, "dispatch-timeout");
      const drained = await dispatcher.drainOnce(10, { ...overrides(), timeoutMs: 20 });
      expect(drained.verifying).toBe(1);
      const parked = await getOp(tenantA, data.id);
      expect(parked.status).toBe("VERIFYING");
      expect(parked.effect_certainty).toBe("UNKNOWN");
      expect(parked.claimed_by).toBeNull();
      // The frontier marker was committed before the timeout fired.
      expect(parked.dispatch_started_at).not.toBeNull();
      const attempts = await getAttempts(tenantA, data.id);
      expect(attempts.map((a) => a.status)).toEqual(["STARTED", "VERIFYING"]);
    } finally {
      browser.mode = "success";
    }
  });

  it("a hanging READ_CUSTOMER parks VERIFYING/UNKNOWN via the readback budget (never FAILED, never a re-send)", async () => {
    browser.mode = "success";
    // FASE5-S6-FIX2 (SPEC §35): the readback carries the same finite-budget
    // contract as the port call — a fake that never resolves, with a tiny
    // override budget (no long sleeps in tests).
    const hangingReadback = { readTrialCustomer: () => new Promise<never>(() => undefined) };
    const callsBefore = browser.calls.length;
    const data = await requestDurable(tenantA, "readback-timeout");
    const drained = await dispatcher.drainOnce(10, {
      ...overrides(),
      trialReadbackPort: hangingReadback,
      trialReadbackTimeoutMs: 20,
    });
    expect(drained.verifying).toBe(1);
    const parked = await getOp(tenantA, data.id);
    expect(parked.status).toBe("VERIFYING");
    expect(parked.effect_certainty).toBe("UNKNOWN");
    expect(parked.claimed_by).toBeNull();
    // Exactly one send: the readback timeout never re-sends the POST.
    expect(browser.calls.length).toBe(callsBefore + 1);
    const attempts = await getAttempts(tenantA, data.id);
    expect(attempts.map((a) => a.status)).toEqual(["STARTED", "VERIFYING"]);
  });

  it("tenant isolation: designated tenant dispatches; other tenants fail closed at request", async () => {
    browser.mode = "success";
    const opA = await requestDurable(tenantA, "isolation-a");
    // FASE5-S4S5: tenantB holds no disposable designation (the suite
    // designates tenantA's account), so the REQUEST itself refuses
    // fail-closed — no row, no port call, nothing for the drain to touch.
    const refusedB = await requestDurableResult(tenantB, "isolation-b");
    expect(refusedB.result.ok).toBe(false);
    if (refusedB.result.ok) throw new Error("non-designated tenant must fail closed");
    expect(refusedB.result.code).toBe("precondition_failed");
    const drained = await dispatcher.drainOnce(10, overrides());
    expect(drained.operationIds).toContain(opA.id);
    const rowA = await getOp(tenantA, opA.id);
    expect(rowA.status).toBe("SUCCEEDED");
    expect(rowA.tenant_id).toBe(tenantA);
    expect(await getEventTypes(tenantA, opA.id)).toEqual([
      "provider.operation_requested.v1",
      "provider.operation_succeeded.v1",
    ]);
    // The refused trial left zero operation rows behind.
    const strayB = await db
      .selectFrom("provider.provider_operations")
      .select(["id"])
      .where("tenant_id", "=", tenantB)
      .where("entity_id", "=", refusedB.trialId)
      .execute();
    expect(strayB).toHaveLength(0);
  });

  it("D1: stale pre-send requeue never clears a concurrent frontier marker", async () => {
    browser.mode = "success";
    const data = await requestDurable(tenantA, "d1-stale-frontier");
    const staleToken = "crashed-worker";
    // SELECT-time snapshot: expired lease, pre-send.
    await db
      .updateTable("provider.provider_operations")
      .set({
        status: "QUEUED",
        claimed_by: staleToken,
        claimed_at: new Date(),
        lease_expires_at: sql`now() - make_interval(secs => 60)`,
        dispatch_started_at: null,
      })
      .where("tenant_id", "=", tenantA)
      .where("id", "=", data.id)
      .execute();
    // Interleaving: the dispatcher promotes + commits the frontier BEFORE
    // recovery's UPDATE runs (same claim, lease still expired).
    const frontier = new Date();
    await db
      .updateTable("provider.provider_operations")
      .set({ status: "RUNNING", dispatch_started_at: frontier })
      .where("tenant_id", "=", tenantA)
      .where("id", "=", data.id)
      .execute();
    // Recovery's pre-send statement revalidates the snapshot: zero rows, the
    // send marker is preserved (no duplicate write without readback).
    const attempted = await db
      .updateTable("provider.provider_operations")
      .set({
        status: "REQUESTED",
        effect_certainty: "UNKNOWN",
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        dispatch_started_at: null,
      })
      .where("tenant_id", "=", tenantA)
      .where("id", "=", data.id)
      .where("status", "in", ["QUEUED", "RUNNING"])
      .where("dispatch_started_at", "is", null)
      .where("claimed_by", "is not", null)
      .where(sql<boolean>`lease_expires_at <= now()`)
      .executeTakeFirst();
    expect(Number(attempted.numUpdatedRows ?? 0)).toBe(0);
    const kept = await getOp(tenantA, data.id);
    expect(kept.status).toBe("RUNNING");
    expect(kept.dispatch_started_at).not.toBeNull();
    // The real recovery follows the CURRENT state: post-send parks VERIFYING.
    const recovered = await dispatcher.recoverOnce(10);
    expect(recovered.operationIds).toContain(data.id);
    expect(recovered.verifying).toBe(1);
    expect((await getOp(tenantA, data.id)).status).toBe("VERIFYING");
  });

  it("D1: recovery never overwrites a terminal outcome", async () => {
    const data = await requestDurable(tenantA, "d1-terminal");
    // Realistic terminal row carrying a stale claim + expired lease (a late
    // recovery racing a just-terminalized operation).
    await db
      .updateTable("provider.provider_operations")
      .set({
        status: "SUCCEEDED",
        effect_certainty: "KNOWN_APPLIED",
        completed_at: new Date(),
        claimed_by: "stale-worker",
        claimed_at: new Date(),
        lease_expires_at: sql`now() - make_interval(secs => 60)`,
        dispatch_started_at: new Date(),
      })
      .where("tenant_id", "=", tenantA)
      .where("id", "=", data.id)
      .execute();
    const attemptsBefore = await getAttempts(tenantA, data.id);
    const recovered = await dispatcher.recoverOnce(10);
    expect(recovered.operationIds).not.toContain(data.id);
    expect(recovered.released).toBe(0);
    expect(recovered.verifying).toBe(0);
    expect((await getOp(tenantA, data.id)).status).toBe("SUCCEEDED");
    expect(await getAttempts(tenantA, data.id)).toHaveLength(attemptsBefore.length);
    // Tidy: clear the planted stale claim so no later scan trips on it.
    await db
      .updateTable("provider.provider_operations")
      .set({ claimed_by: null, claimed_at: null, lease_expires_at: null })
      .where("tenant_id", "=", tenantA)
      .where("id", "=", data.id)
      .execute();
  });

  it("D1: promotion with a reclaimed token affects zero rows", async () => {
    const data = await requestDurable(tenantA, "d1-token");
    const owner = `owner-${newId()}`;
    const reclaimer = `reclaimer-${newId()}`;
    await db
      .updateTable("provider.provider_operations")
      .set({
        status: "QUEUED",
        claimed_by: owner,
        claimed_at: new Date(),
        lease_expires_at: sql`now() + make_interval(secs => 300)`,
        dispatch_started_at: null,
      })
      .where("tenant_id", "=", tenantA)
      .where("id", "=", data.id)
      .execute();
    // A stale worker reclaiming with its own fresh token cannot satisfy the
    // owner's fencing predicate — even with a valid lease.
    const wrong = await db
      .updateTable("provider.provider_operations")
      .set({ status: "RUNNING", dispatch_started_at: new Date() })
      .where("tenant_id", "=", tenantA)
      .where("id", "=", data.id)
      .where("claimed_by", "=", reclaimer)
      .where("status", "=", "QUEUED")
      .where(sql<boolean>`lease_expires_at > now()`)
      .executeTakeFirst();
    expect(Number(wrong.numUpdatedRows ?? 0)).toBe(0);
    // The true owner's promotion succeeds.
    const right = await db
      .updateTable("provider.provider_operations")
      .set({ status: "RUNNING", dispatch_started_at: new Date() })
      .where("tenant_id", "=", tenantA)
      .where("id", "=", data.id)
      .where("claimed_by", "=", owner)
      .where("status", "=", "QUEUED")
      .where(sql<boolean>`lease_expires_at > now()`)
      .executeTakeFirst();
    expect(Number(right.numUpdatedRows ?? 0)).toBe(1);
    // Tidy: terminalize so later recovery scans never see this row.
    await db
      .updateTable("provider.provider_operations")
      .set({
        status: "SUCCEEDED",
        effect_certainty: "KNOWN_APPLIED",
        completed_at: new Date(),
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
      })
      .where("tenant_id", "=", tenantA)
      .where("id", "=", data.id)
      .execute();
  });

  it("D2: secret-required op with env=echo and no override parks HUMAN_REQUIRED with zero port effect", async () => {
    const prevAdapter = process.env["PROVIDER_OPS_ADAPTER"];
    process.env["PROVIDER_OPS_ADAPTER"] = "echo";
    try {
      const data = await requestDurable(tenantA, "d2-echo-failclosed");
      // No opsPort override: the dispatcher resolves the env default (echo,
      // synthetic). Provenance must fail closed — never a synthetic SUCCEEDED.
      // FASE5-S4S5: the suite-private trial row + designation ride along so
      // the park comes from the port seam (0c), not the trial gate (0b2).
      const drained = await dispatcher.drainOnce(10, {
        secretsPort: CONFIGURED_SECRETS_PORT,
        loadSecretRef: async () => VALID_REF,
        trialCapabilityKey: TEST_TRIAL_CAPABILITY_KEY,
        trialDisposableAccountId: accountA,
      });
      expect(drained.operationIds).toContain(data.id);
      expect(drained.succeeded).toBe(0);
      expect(drained.humanRequired).toBeGreaterThanOrEqual(1);
      const parked = await getOp(tenantA, data.id);
      expect(parked.status).toBe("HUMAN_REQUIRED");
      expect(parked.dispatch_started_at).toBeNull();
      expect(dumped(parked.result_summary_json)).not.toContain("echo-");
      expect(await getEventTypes(tenantA, data.id)).toEqual(["provider.operation_requested.v1"]);
    } finally {
      if (prevAdapter === undefined) {
        delete process.env["PROVIDER_OPS_ADAPTER"];
      } else {
        process.env["PROVIDER_OPS_ADAPTER"] = prevAdapter;
      }
    }
  });

  it("D3: the port call happens with no DB transaction open", async () => {
    browser.mode = "success";
    const data = await requestDurable(tenantA, "d3-no-tx");
    const events: string[] = [];
    let portDepth = -1;
    let depth = 0;
    const trackingCommandDb = {
      withTransaction: async <T>(tenantId: string, fn: (tx: never) => Promise<T>): Promise<T> => {
        depth += 1;
        events.push("enter");
        try {
          return await commandDb.withTransaction(tenantId, fn as never);
        } finally {
          depth -= 1;
          events.push("exit");
        }
      },
      claimIdempotency: (input: never) => commandDb.claimIdempotency(input as never),
      finishIdempotency: (input: never) => commandDb.finishIdempotency(input as never),
    };
    const trackingPort: ProviderOpsPort = {
      name: "browser",
      requiresSecretRef: true,
      requestOperation: async (input: ProviderOperationRequest): Promise<AdapterResult> => {
        portDepth = depth;
        events.push("port");
        return browser.requestOperation(input);
      },
    };
    const trackingDispatcher = new ProviderDispatcherService(
      db,
      trackingCommandDb as unknown as typeof commandDb,
      undefined,
      TEST_TRIAL_CAPABILITY_KEY,
    );
    const drained = await trackingDispatcher.drainOnce(10, {
      opsPort: trackingPort,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      // FASE5-S4S5: suite-private trial row + designation so the send
      // reaches the port seam (the trial gate must not park it first).
      trialCapabilityKey: TEST_TRIAL_CAPABILITY_KEY,
      trialDisposableAccountId: accountA,
      // FASE5-S6: conclusive READ_CUSTOMER so SUCCEEDED terminalizes.
      trialReadbackPort: readback,
    });
    expect(drained.operationIds).toContain(data.id);
    expect(drained.succeeded).toBeGreaterThanOrEqual(1);
    // The port ran at depth 0: strictly before the Phase-3 transaction
    // opened (promotion uses a separate short tx that already committed).
    expect(portDepth).toBe(0);
    expect(events).toEqual(["port", "enter", "exit"]);
    expect((await getOp(tenantA, data.id)).status).toBe("SUCCEEDED");
  });

  it("D4: AVAILABLE→UNAVAILABLE between request and drain parks HUMAN_REQUIRED without send", async () => {
    browser.mode = "success";
    const data = await requestDurable(tenantA, "d4-flip");
    // CV-DSP-02-FIX2: flip ONLY the suite-private row; the GLOBAL
    // `provider.cinevision` row stays AVAILABLE so parallel suites never see
    // this transient UNAVAILABLE.
    await ensureTestCapability("UNAVAILABLE");
    const callsBefore = browser.calls.length;
    try {
      const drained = await isolatedDispatcher.drainOnce(10, overrides());
      expect(drained.operationIds).toContain(data.id);
      const parked = await getOp(tenantA, data.id);
      expect(parked.status).toBe("HUMAN_REQUIRED");
      expect(parked.dispatch_started_at).toBeNull();
      expect(browser.calls.length).toBe(callsBefore);
    } finally {
      await ensureTestCapability("AVAILABLE");
    }
  });

  it("F1a: fenced applier via the REAL path rejects a lost claim, then applies for the owner", async () => {
    browser.mode = "success";
    const data = await requestDurable(tenantA, `f1a-fence-${newId().slice(0, 8)}`);
    const fields = await db
      .selectFrom("provider.provider_operations")
      .select(["action", "entity_type", "entity_id"])
      .where("tenant_id", "=", tenantA)
      .where("id", "=", data.id)
      .executeTakeFirstOrThrow();
    const tokenA = `owner-${newId()}`;
    const tokenB = `stale-${newId()}`;
    await db
      .updateTable("provider.provider_operations")
      .set({
        status: "RUNNING",
        claimed_by: tokenA,
        claimed_at: new Date(),
        lease_expires_at: sql`now() + make_interval(secs => 300)`,
        dispatch_started_at: new Date(),
      })
      .where("tenant_id", "=", tenantA)
      .where("id", "=", data.id)
      .execute();
    const attemptsBefore = await getAttempts(tenantA, data.id);
    const eventsBefore = await getEventTypes(tenantA, data.id);

    // Lost fence through the REAL applier: zero rows, null, no side effects.
    // FASE5-S6: the owner/lost SUCCEEDED both carry the conclusive readback
    // (lost still returns null via the fence; owner terminalizes).
    const lostReadback = {
      conclusive: true as const,
      customer: {
        exists: true,
        externalId: "ext-f1a",
        isTrial: "1",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      evidence: "test:conclusive",
    };
    const lost = await commandDb.withTransaction(tenantA, async (tx) => {
      return applySecretPortOutcome(
        {
          actor: {
            userId: "provider-dispatcher",
            isPlatformAdmin: true,
            tenantId: tenantA,
            roleKeys: [],
            permissions: [],
            actorType: "system",
          },
          tenantId: tenantA,
          commandId: newId(),
          correlationId: newId(),
          causationId: null,
          tx,
        },
        {
          operationId: data.id,
          action: fields.action,
          entityType: fields.entity_type,
          entityId: fields.entity_id,
          raw: { outcome: "SUCCEEDED", detail: "f1a lost fence", externalRef: "ext-f1a" },
          trialReadback: lostReadback,
        },
        { claimedBy: tokenB },
      );
    });
    expect(lost).toBeNull();
    const kept = await getOp(tenantA, data.id);
    expect(kept.status).toBe("RUNNING");
    expect(kept.claimed_by).toBe(tokenA);
    expect(kept.lease_expires_at).not.toBeNull();
    expect(await getAttempts(tenantA, data.id)).toHaveLength(attemptsBefore.length);
    expect(await getEventTypes(tenantA, data.id)).toEqual(eventsBefore);

    // Owner fence through the REAL applier: terminalizes normally.
    const applied = await commandDb.withTransaction(tenantA, async (tx) => {
      return applySecretPortOutcome(
        {
          actor: {
            userId: "provider-dispatcher",
            isPlatformAdmin: true,
            tenantId: tenantA,
            roleKeys: [],
            permissions: [],
            actorType: "system",
          },
          tenantId: tenantA,
          commandId: newId(),
          correlationId: newId(),
          causationId: null,
          tx,
        },
        {
          operationId: data.id,
          action: fields.action,
          entityType: fields.entity_type,
          entityId: fields.entity_id,
          raw: { outcome: "SUCCEEDED", detail: "f1a owner fence", externalRef: "ext-f1a" },
          trialReadback: lostReadback,
        },
        { claimedBy: tokenA },
      );
    });
    expect(applied).toEqual({ status: "SUCCEEDED", effectCertainty: "KNOWN_APPLIED" });
    const terminal = await getOp(tenantA, data.id);
    expect(terminal.status).toBe("SUCCEEDED");
    expect(terminal.effect_certainty).toBe("KNOWN_APPLIED");
    expect(terminal.claimed_by).toBeNull();
    expect(terminal.lease_expires_at).toBeNull();
    const attempts = await getAttempts(tenantA, data.id);
    expect(attempts.map((a) => a.status)).toContain("SUCCEEDED");
    expect(await getEventTypes(tenantA, data.id)).toEqual([
      "provider.operation_requested.v1",
      "provider.operation_succeeded.v1",
    ]);
  });

  it("F1b: recoverOnce REAL over the full state matrix (no SQL replays)", async () => {
    browser.mode = "success";
    const seeded = await seedTenant(`f1b-${newId().replace(/-/g, "").slice(-8)}`);
    const tenant = seeded.tenantId;
    async function makeDurable(key: string): Promise<string> {
      return (await requestDurable(tenant, `${key}-${newId().replace(/-/g, "").slice(-8)}`)).id;
    }
    // FASE5-S4S5: this test's trials run against its own disposable account
    // (the afterEach hook restores the suite designation afterwards,
    // even on failure).
    process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"] = seeded.accountId;
    const f1bIds: { preQueued: string; preRunning: string; postRunning: string; postQueuedSpoof: string; liveLease: string; terminal: string } = {
      preQueued: await makeDurable("f1b-pre-queued"),
      preRunning: await makeDurable("f1b-pre-running"),
      postRunning: await makeDurable("f1b-post-running"),
      postQueuedSpoof: await makeDurable("f1b-post-queued-spoof"),
      liveLease: await makeDurable("f1b-live"),
      terminal: await makeDurable("f1b-terminal"),
    };
    const { preQueued, preRunning, postRunning, postQueuedSpoof, liveLease, terminal } = f1bIds;
    async function plant(id: string, patch: Record<string, unknown>): Promise<void> {
      await db
        .updateTable("provider.provider_operations")
        .set(patch as never)
        .where("tenant_id", "=", tenant)
        .where("id", "=", id)
        .execute();
    }
    await plant(preQueued, {
      status: "QUEUED",
      claimed_by: "crashed-worker",
      claimed_at: new Date(),
      lease_expires_at: sql`now() - make_interval(secs => 60)`,
      dispatch_started_at: null,
    });
    await plant(preRunning, {
      status: "RUNNING",
      claimed_by: "crashed-worker",
      claimed_at: new Date(),
      lease_expires_at: sql`now() - make_interval(secs => 60)`,
      dispatch_started_at: null,
    });
    await plant(postRunning, {
      status: "RUNNING",
      claimed_by: "crashed-worker",
      claimed_at: new Date(),
      lease_expires_at: sql`now() - make_interval(secs => 60)`,
      dispatch_started_at: new Date(),
    });
    // QUEUED with a frontier marker is invalid (promotion flips to RUNNING
    // with the marker). The service parks it VERIFYING — never requeues.
    await plant(postQueuedSpoof, {
      status: "QUEUED",
      claimed_by: "crashed-worker",
      claimed_at: new Date(),
      lease_expires_at: sql`now() - make_interval(secs => 60)`,
      dispatch_started_at: new Date(),
    });
    await plant(liveLease, {
      status: "QUEUED",
      claimed_by: "live-worker",
      claimed_at: new Date(),
      lease_expires_at: sql`now() + make_interval(secs => 300)`,
      dispatch_started_at: null,
    });
    await plant(terminal, {
      status: "SUCCEEDED",
      effect_certainty: "KNOWN_APPLIED",
      completed_at: new Date(),
      claimed_by: "stale-worker",
      claimed_at: new Date(),
      lease_expires_at: sql`now() - make_interval(secs => 60)`,
      dispatch_started_at: new Date(),
    });
    const attemptsBefore = await getAttempts(tenant, terminal);
    const callsBefore = browser.calls.length;

    const recovered = await dispatcher.recoverOnce(50);

    expect(recovered.operationIds).toContain(preQueued);
    expect(recovered.operationIds).toContain(preRunning);
    expect(recovered.operationIds).toContain(postRunning);
    expect(recovered.operationIds).toContain(postQueuedSpoof);
    expect(recovered.operationIds).not.toContain(liveLease);
    expect(recovered.operationIds).not.toContain(terminal);
    // Recovery never calls a port.
    expect(browser.calls.length).toBe(callsBefore);

    const releasedPreQueued = await getOp(tenant, preQueued);
    expect(releasedPreQueued.status).toBe("REQUESTED");
    expect(releasedPreQueued.claimed_by).toBeNull();
    expect(releasedPreQueued.lease_expires_at).toBeNull();
    expect(releasedPreQueued.dispatch_started_at).toBeNull();
    const releasedPreRunning = await getOp(tenant, preRunning);
    expect(releasedPreRunning.status).toBe("REQUESTED");
    expect(releasedPreRunning.claimed_by).toBeNull();
    expect(releasedPreRunning.dispatch_started_at).toBeNull();

    const parkedRunning = await getOp(tenant, postRunning);
    expect(parkedRunning.status).toBe("VERIFYING");
    expect(parkedRunning.effect_certainty).toBe("UNKNOWN");
    expect(parkedRunning.claimed_by).toBeNull();
    const parkedSpoof = await getOp(tenant, postQueuedSpoof);
    expect(parkedSpoof.status).toBe("VERIFYING");
    expect(parkedSpoof.effect_certainty).toBe("UNKNOWN");
    expect(parkedSpoof.claimed_by).toBeNull();
    for (const id of [postRunning, postQueuedSpoof]) {
      const attempts = await getAttempts(tenant, id);
      expect(attempts.map((a) => a.status)).toContain("VERIFYING");
      expect(attempts.find((a) => a.status === "VERIFYING")?.error_code).toBe(
        PROVIDER_CALL_UNCERTAIN_CODE,
      );
    }

    const keptLive = await getOp(tenant, liveLease);
    expect(keptLive.status).toBe("QUEUED");
    expect(keptLive.claimed_by).toBe("live-worker");
    const keptTerminal = await getOp(tenant, terminal);
    expect(keptTerminal.status).toBe("SUCCEEDED");
    expect(keptTerminal.effect_certainty).toBe("KNOWN_APPLIED");
    expect(await getAttempts(tenant, terminal)).toHaveLength(attemptsBefore.length);

    // Tidy: terminalize the released/live rows so later drains never see them.
    // (VERIFYING rows are inert to drainOnce by status and stay as evidence.)
    for (const id of [preQueued, preRunning, liveLease]) {
      await db
        .updateTable("provider.provider_operations")
        .set({
          status: "SUCCEEDED",
          effect_certainty: "KNOWN_APPLIED",
          completed_at: new Date(),
          claimed_by: null,
          claimed_at: null,
          lease_expires_at: null,
        })
        .where("tenant_id", "=", tenant)
        .where("id", "=", id)
        .execute();
    }
    await db
      .updateTable("provider.provider_operations")
      .set({ claimed_by: null, claimed_at: null, lease_expires_at: null })
      .where("tenant_id", "=", tenant)
      .where("id", "=", terminal)
      .execute();
  });

  it("F1c: drainOnce REAL claims only secret-required-v1 (synthetics + spoofs ignored)", async () => {
    browser.mode = "success";
    const seeded = await seedTenant(`f1c-${newId().replace(/-/g, "").slice(-8)}`);
    const tenant = seeded.tenantId;
    // FASE5-S4S5: this test's trials run against its own disposable account
    // (the afterEach hook restores the suite designation afterwards,
    // even on failure).
    process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"] = seeded.accountId;
    const tag = newId().replace(/-/g, "").slice(-8);
    const good = (await requestDurable(tenant, `f1c-good-${tag}`)).id;
    const echoExact = (await requestDurable(tenant, `f1c-echo-${tag}`)).id;
    const echoSpoof = (await requestDurable(tenant, `f1c-spoof-${tag}`)).id;
    await db
      .updateTable("provider.provider_operations")
      .set({ adapter_version: "echo-v1" })
      .where("tenant_id", "=", tenant)
      .where("id", "=", echoExact)
      .execute();
    await db
      .updateTable("provider.provider_operations")
      .set({ adapter_version: "echo-v2" })
      .where("tenant_id", "=", tenant)
      .where("id", "=", echoSpoof)
      .execute();
    const callsBefore = browser.calls.length;

    const drained = await dispatcher.drainOnce(10, overrides());

    expect(drained.operationIds).toContain(good);
    expect(drained.operationIds).not.toContain(echoExact);
    expect(drained.operationIds).not.toContain(echoSpoof);
    expect(browser.calls.length).toBe(callsBefore + 1);
    expect((await getOp(tenant, good)).status).toBe("SUCCEEDED");
    for (const id of [echoExact, echoSpoof]) {
      const kept = await getOp(tenant, id);
      expect(kept.status).toBe("REQUESTED");
      expect(kept.claimed_by).toBeNull();
    }
  });

  it("F2: Phase-3 failure after the port responded parks VERIFYING via recoverOnce (no second send)", async () => {
    browser.mode = "success";
    const data = await requestDurable(tenantA, `f2-phase3-${newId().replace(/-/g, "").slice(-8)}`);
    // Deterministic Phase-3 failure WITHOUT deleting the row: Phase-1 uses
    // the Kysely db directly, Phase-3 uses the command DbPort, so a DbPort
    // that throws only breaks the result-application transaction. Deleting
    // the row instead would cascade to attempts and leave recovery with
    // nothing to park — irrecuperável, therefore rejected for this proof.
    const failingCommandDb = {
      withTransaction: async <T>(): Promise<T> => {
        throw new Error("injected phase-3 failure");
      },
      claimIdempotency: (input: never) => commandDb.claimIdempotency(input as never),
      finishIdempotency: (input: never) => commandDb.finishIdempotency(input as never),
    };
    const failingDispatcher = new ProviderDispatcherService(
      db,
      failingCommandDb as unknown as typeof commandDb,
      undefined,
      TEST_TRIAL_CAPABILITY_KEY,
    );
    const eventsBefore = await getEventTypes(tenantA, data.id);
    const callsBefore = browser.calls.length;

    const drained = await failingDispatcher.drainOnce(10, overrides());
    expect(drained.operationIds).toContain(data.id);
    expect(drained.claimed).toBe(1);
    expect(drained.succeeded).toBe(0);
    expect(drained.skipped).toBe(1);
    // The port responded exactly once; only persistence failed.
    expect(browser.calls.length).toBe(callsBefore + 1);

    const inflight = await getOp(tenantA, data.id);
    expect(inflight.status).toBe("RUNNING");
    expect(inflight.dispatch_started_at).not.toBeNull();
    expect(inflight.claimed_by).not.toBeNull();
    expect(inflight.lease_expires_at).not.toBeNull();
    const inflightAttempts = await getAttempts(tenantA, data.id);
    expect(inflightAttempts.map((a) => a.status)).toEqual(["STARTED"]);
    // No terminal write, no terminal event: the REQUESTED event stands alone.
    expect(await getEventTypes(tenantA, data.id)).toEqual(eventsBefore);

    // Lease lapse with the frontier marker held: the REAL recovery parks it.
    await db
      .updateTable("provider.provider_operations")
      .set({ lease_expires_at: sql`now() - make_interval(secs => 60)` })
      .where("tenant_id", "=", tenantA)
      .where("id", "=", data.id)
      .execute();
    const recovered = await dispatcher.recoverOnce(10);
    expect(recovered.operationIds).toContain(data.id);
    expect(recovered.verifying).toBe(1);

    const parked = await getOp(tenantA, data.id);
    expect(parked.status).toBe("VERIFYING");
    expect(parked.effect_certainty).toBe("UNKNOWN");
    expect(parked.claimed_by).toBeNull();
    expect(parked.dispatch_started_at).not.toBeNull();
    const parkedAttempts = await getAttempts(tenantA, data.id);
    expect(parkedAttempts.map((a) => a.status)).toEqual(["STARTED", "VERIFYING"]);
    expect(parkedAttempts.find((a) => a.status === "VERIFYING")?.error_code).toBe(
      PROVIDER_CALL_UNCERTAIN_CODE,
    );
    // Still a single port call, still no terminal event — never re-executed.
    expect(browser.calls.length).toBe(callsBefore + 1);
    expect(await getEventTypes(tenantA, data.id)).toEqual(eventsBefore);
    expect((await dispatcher.drainOnce(10, overrides())).claimed).toBe(0);
    expect(browser.calls.length).toBe(callsBefore + 1);
  });
});
