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
import { registerHumanReviewCommands } from "../src/human-review/human-review.commands.js";
import { registerPolicyCommands } from "../src/policy/policy.commands.js";
import { registerTrialCommands } from "../src/trial/trial.commands.js";
import { registerProviderCommands } from "../src/provider/provider.commands.js";
import { registerFulfillmentCommands } from "../src/fulfillment/fulfillment.commands.js";
import { registerLicenseCommands } from "../src/inventory/license.commands.js";
import { registerAppTrialCommands } from "../src/inventory/app-trial.commands.js";
import { registerSupplierCreditCommands } from "../src/inventory/supplier-credit.commands.js";
import { captureSupplierAppSnapshot } from "../src/inventory/supplier-app-catalog.store.js";
import { ProviderDispatcherService } from "../src/provider/provider-dispatcher.service.js";
import { applyTrialProvisionOutcome } from "../src/trial/trial.commands.js";
import { applySubscriptionProvisionOutcome } from "../src/fulfillment/fulfillment.commands.js";
import { applyAppLicensePurchaseOutcome } from "../src/inventory/license.commands.js";
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

const VALID_REF = "infisical://dispatch-multidomain/BROWSER_WORKER_KEY";

/**
 * CV-DSP-02-FIX2: suite-private capability key. All dispatcher drains in this
 * file run through a dispatcher bound to this row (arranged AVAILABLE in
 * beforeAll), so the transient UNAVAILABLE flips of other suites on the
 * GLOBAL `provider.cinevision` row can never park these drains. The GLOBAL row
 * itself stays AVAILABLE for the inline request gates and is never flipped
 * by this file.
 */
const TEST_DISPATCH_CAPABILITY_KEY = "provider.cinevision-itest-multidomain";

/**
 * FASE5-S4S5: suite-private per-action trial gate key. All real
 * `trial.provision` requests/drains in this file revalidate this row
 * (arranged AVAILABLE in beforeAll via the `trialCapabilityKey` seams), so
 * the SHARED `provider.cinevision.trial` row is never flipped here and
 * other suites never observe this suite's trial-gate state.
 */
const TEST_TRIAL_CAPABILITY_KEY = "provider.cinevision-itest-multidomain-trial";

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
  mode: "success" | "unknown" | "manual" = "success";

  async requestOperation(input: ProviderOperationRequest): Promise<AdapterResult> {
    this.calls.push(input);
    if (this.mode === "unknown") {
      return { outcome: "UNKNOWN", detail: "browser: uncertain", externalRef: null };
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

describe.skipIf(!hasDb)("CV-DSP-02 multi-domain durable dispatch (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });
  const commandDb = new KyselyCommandDb(db);
  const bus = new CommandBus(commandDb);
  const browser = new FakeBrowserPort();
  // CV-DSP-02-FIX2: bound to the suite-private capability row (see above).
  // FASE5-S4S5: also bound to the suite-private TRIAL row (4th arg) — the
  // SHARED `provider.cinevision.trial` row is never flipped by this file.
  const dispatcher = new ProviderDispatcherService(db, commandDb, TEST_DISPATCH_CAPABILITY_KEY, TEST_TRIAL_CAPABILITY_KEY);
  // FASE5-S6: the REAL `trial.provision` SUCCEEDED now gates on a conclusive
  // READ_CUSTOMER readback (StubTrialReadback is fail-closed INCONCLUSIVE →
  // VERIFYING). The suite default satisfies it so trial drains keep proving
  // their original invariants (ACTIVE terminalization, F5 fencing) with the
  // readback step in place. Fulfillment/license paths never consult it.
  const readback = new FakeTrialReadback("satisfied");
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

  function overrides() {
    return {
      opsPort: browser as ProviderOpsPort,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      // FASE5-S4S5: suite-private trial row (never the shared gate row);
      // the designation rides on `PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID`,
      // set per trial test (each test seeds its own disposable account).
      trialCapabilityKey: TEST_TRIAL_CAPABILITY_KEY,
      // FASE5-S6: conclusive READ_CUSTOMER so trial SUCCEEDED terminalizes.
      trialReadbackPort: readback,
    };
  }

  // FASE5-S4S5: per-trial-test designations must never leak between tests —
  // every trial test sets its own right after seeding, and this hook clears
  // leftovers even on failure (fulfillment/license tests never read it).
  afterEach(() => {
    delete process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"];
  });

  function dispatcherCtx(tenantId: string, tx: unknown) {
    return {
      actor: {
        userId: "provider-dispatcher",
        isPlatformAdmin: true,
        tenantId,
        roleKeys: [],
        permissions: [],
        actorType: "system",
      },
      tenantId,
      commandId: newId(),
      correlationId: newId(),
      causationId: null,
      tx,
    } as never;
  }

  async function getTrialStatus(tenantId: string, trialId: string): Promise<string> {
    const row = await db
      .selectFrom("trial.trials")
      .select(["lifecycle_status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", trialId)
      .executeTakeFirstOrThrow();
    return row.lifecycle_status;
  }

  async function getSubscriptionStatus(tenantId: string, subscriptionId: string): Promise<string> {
    const row = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .executeTakeFirstOrThrow();
    return row.status;
  }

  async function seedTenant(tag: string): Promise<{ tenantId: string; accountId: string }> {
    const tenantId = newId();
    // CV-DSP-02-FIX fixture: unique slug per CALL (not per file) — fixed
    // tags reused across seeds collided on `tenants_slug_unique` (W1-06
    // drive-by pattern: random UUID tail, never a fixed string).
    const callId = newId().replace(/-/g, "").slice(-8);
    await db
      .insertInto("control.tenants")
      .values({
        id: tenantId,
        slug: `dsp2-${tag}-${suffix}-${callId}`,
        name: `Dispatch2 ${tag}`,
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
        name: `Dispatch2 account ${tag}`,
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

  async function getOp(tenantId: string, id: string) {
    return db
      .selectFrom("provider.provider_operations")
      .select(["id", "tenant_id", "status", "effect_certainty", "claimed_by", "lease_expires_at", "dispatch_started_at", "result_summary_json"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  }

  async function getAttempts(tenantId: string, id: string) {
    return db
      .selectFrom("provider.provider_operation_attempts")
      .select(["attempt_no", "status", "error_code"])
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

  async function makeTrial(tenantId: string, name: string): Promise<string> {
    const person = await bus.execute<{ id: string }>(actor(tenantId), "person.register", { canonicalName: name });
    if (!person.ok) throw new Error(`person.register failed: ${dumped(person)}`);
    const trial = await bus.execute<{ id: string | null }>(actor(tenantId), "trial.request", {
      personId: person.data.id,
      durationMinutes: 60,
    });
    if (!trial.ok || trial.data.id === null) throw new Error(`trial.request failed: ${dumped(trial)}`);
    return trial.data.id;
  }

  async function makeSubscription(tenantId: string, name: string): Promise<string> {
    const person = await bus.execute<{ id: string }>(actor(tenantId), "person.register", { canonicalName: name });
    if (!person.ok) throw new Error(`person.register failed: ${dumped(person)}`);
    const customerId = newId();
    await db
      .insertInto("crm.customers")
      .values({
        id: customerId,
        tenant_id: tenantId,
        person_id: person.data.id,
        status: "ACTIVE",
        customer_since: new Date(),
        last_reactivated_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const productId = newId();
    await db
      .insertInto("catalog.products")
      .values({
        id: productId,
        tenant_id: tenantId,
        product_key: `svc-${suffix}-${name.replace(/[^a-z]/gi, "").slice(0, 8)}`,
        name: "Dispatch2 Service",
        product_type: "SERVICE",
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const planId = newId();
    await db
      .insertInto("catalog.plans")
      .values({
        id: planId,
        tenant_id: tenantId,
        product_id: productId,
        plan_key: `monthly-${suffix}-${name.replace(/[^a-z]/gi, "").slice(0, 8)}`,
        name: "Dispatch2 Monthly",
        billing_interval_unit: "MONTH",
        billing_interval_count: 1,
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const subscriptionId = newId();
    const start = new Date();
    await db
      .insertInto("subscription.subscriptions")
      .values({
        id: subscriptionId,
        tenant_id: tenantId,
        customer_id: customerId,
        plan_id: planId,
        originating_order_id: null,
        status: "PENDING_ACTIVATION",
        started_at: null,
        current_period_start: start,
        current_period_end: new Date(start.getTime() + 30 * 86_400_000),
        cancel_at_period_end: false,
        cancelled_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto("subscription.subscription_cycles")
      .values({
        id: newId(),
        tenant_id: tenantId,
        subscription_id: subscriptionId,
        cycle_no: 1,
        starts_at: start,
        ends_at: new Date(start.getTime() + 30 * 86_400_000),
        renewal_order_id: null,
        status: "PENDING",
        base_revenue_minor: "0",
        currency: "BRL",
        created_at: new Date(),
      })
      .execute();
    return subscriptionId;
  }

  interface ReadyProcurement {
    tenantId: string;
    customerId: string;
    procurementOrderId: string;
    reservationId: string;
  }

  async function makeReadyProcurement(): Promise<ReadyProcurement> {
    const tenantId = (await seedTenant(`lic-${newId().replace(/-/g, "").slice(-8)}`)).tenantId;
    const personId = newId();
    await db
      .insertInto("identity.persons")
      .values({
        id: personId,
        tenant_id: tenantId,
        status: "ACTIVE",
        canonical_name: "Dispatch2 License Person",
        locale: null,
        timezone: null,
        created_at: new Date(),
        updated_at: new Date(),
        anonymized_at: null,
      })
      .execute();
    const customerId = newId();
    await db
      .insertInto("crm.customers")
      .values({
        id: customerId,
        tenant_id: tenantId,
        person_id: personId,
        status: "ACTIVE",
        customer_since: new Date(),
        last_reactivated_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const supplierId = newId();
    await db
      .insertInto("inventory.suppliers")
      .values({
        id: supplierId,
        tenant_id: tenantId,
        name: "Dispatch2 Supplier",
        supplier_type: "APP_CATALOG",
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await captureSupplierAppSnapshot(db, {
      tenantId,
      supplierId,
      items: [
        { externalId: "app-pro-01", name: "Pro App", lifetimePriceMinor: "2000", currency: "BRL", availability: "AVAILABLE" },
      ],
    });
    const requested = await bus.execute<{ id: string }>(actor(tenantId), "inventory.request_app_trial", {
      personId,
      customerId,
      supplierId,
      supplierAppExternalId: "app-pro-01",
    });
    if (!requested.ok) throw new Error(`trial request failed: ${dumped(requested)}`);
    const validated = await bus.execute(actor(tenantId), "inventory.validate_app_trial", {
      trialId: requested.data.id,
      outcome: "VALIDATED",
    });
    if (!validated.ok) throw new Error(`trial validate failed: ${dumped(validated)}`);
    const orderId = newId();
    await db
      .insertInto("commerce.orders")
      .values({
        id: orderId,
        tenant_id: tenantId,
        person_id: personId,
        customer_id: customerId,
        source_offer_id: null,
        order_type: "APP",
        status: "SETTLED",
        currency: "BRL",
        gross_amount_minor: "2000",
        discount_amount_minor: "0",
        reward_amount_minor: "0",
        net_amount_minor: "2000",
        settled_amount_minor: "2000",
        created_at: new Date(),
        awaiting_payment_at: new Date(),
        settled_at: new Date(),
        cancelled_at: null,
        expires_at: null,
      })
      .execute();
    const refreshed = await bus.execute(actor(tenantId), "inventory.refresh_supplier_balance", {
      supplierId,
      adapter: "manual",
      balanceMinor: "100000",
      currency: "BRL",
      evidenceRef: `test:fixture:${supplierId}`,
    });
    if (!refreshed.ok) throw new Error(`balance refresh failed: ${dumped(refreshed)}`);
    const reserved = await bus.execute<{ id: string; procurementOrderId: string }>(
      actor(tenantId),
      "inventory.reserve_app_credit",
      {
        supplierId,
        commerceOrderId: orderId,
        appTrialId: requested.data.id,
        amountMinor: "2000",
        currency: "BRL",
        idempotencyKey: `dsp2-${newId()}`,
      },
    );
    if (!reserved.ok) throw new Error(`reserve failed: ${dumped(reserved)}`);
    return { tenantId, customerId, procurementOrderId: reserved.data.procurementOrderId, reservationId: reserved.data.id };
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    // GLOBAL gate for the inline request handlers (trial/fulfillment/license):
    // stays AVAILABLE for the whole suite and is NEVER flipped by this file.
    await db
      .updateTable("platform.capabilities")
      .set({ availability: "AVAILABLE", certification_status: "CERTIFIED" })
      .where("key", "=", "provider.cinevision")
      .execute();
    // CV-DSP-02-FIX2: arrange the suite-private row the dispatcher revalidates.
    await db
      .insertInto("platform.capabilities")
      .values({
        id: newId(),
        key: TEST_DISPATCH_CAPABILITY_KEY,
        owner_context: "provider",
        availability: "AVAILABLE",
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
          availability: "AVAILABLE",
          certification_status: "CERTIFIED",
          updated_at: new Date(),
        }),
      )
      .execute();
    // FASE5-S4S5: arrange the suite-private per-action trial row the
    // request handlers (`trialCapabilityKey` dep) and the dispatcher
    // revalidate. The SHARED `provider.cinevision.trial` row is never
    // touched by this file.
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
        manual_equivalent: "Provider operator fulfills the operation manually (HITL) via provider.resolve_operation",
        policy_family: "provider-integration",
        degradation: "Isolated per-action trial gate (FASE5-S4S5); mirrors provider.cinevision.trial",
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
    delete process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"];
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    registerTrialCommands(bus, {
      opsPort: browser as ProviderOpsPort,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      // FASE5-S4S5: handlers revalidate the suite-private trial row; the
      // designation rides on the env, set per trial test (each test seeds
      // its own disposable account).
      trialCapabilityKey: TEST_TRIAL_CAPABILITY_KEY,
    });
    registerProviderCommands(bus, {
      opsPort: browser as ProviderOpsPort,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      trialCapabilityKey: TEST_TRIAL_CAPABILITY_KEY,
    });
    registerFulfillmentCommands(bus, {
      opsPort: browser as ProviderOpsPort,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
    });
    registerAppTrialCommands(bus);
    registerSupplierCreditCommands(bus);
    registerLicenseCommands(bus);
  }, 180_000);

  afterAll(async () => {
    delete process.env["PROVIDER_DISPATCH_MODE"];
    delete process.env["PROVIDER_READBACK_EFFECT"];
    delete process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"];
    await db.destroy().catch(() => undefined);
  });

  it("trial: durable QUEUED with zero effect, then dispatcher terminalizes to ACTIVE", async () => {
    browser.mode = "success";
    const { tenantId, accountId } = await seedTenant("trial-happy");
    // FASE5-S4S5: this test's trials run against its own disposable account.
    process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"] = accountId;
    const trialId = await makeTrial(tenantId, "Dispatch2 Trial Happy");
    const callsBefore = browser.calls.length;
    const provisioned = await bus.execute<{ status: string; operationId: string; effectUncertain: boolean }>(
      actor(tenantId),
      "trial.begin_provisioning",
      { trialId },
    );
    expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING", effectUncertain: true } });
    if (!provisioned.ok) throw new Error(`begin_provisioning failed: ${dumped(provisioned)}`);
    expect(browser.calls.length).toBe(callsBefore);
    expect((await getOp(tenantId, provisioned.data.operationId)).status).toBe("REQUESTED");

    const drained = await dispatcher.drainOnce(10, overrides());
    expect(drained.operationIds).toContain(provisioned.data.operationId);
    expect(drained.succeeded).toBeGreaterThanOrEqual(1);
    expect(browser.calls.length).toBe(callsBefore + 1);
    expect(browser.calls[browser.calls.length - 1]?.secretRef).toBe(VALID_REF);

    const terminal = await getOp(tenantId, provisioned.data.operationId);
    expect(terminal.status).toBe("SUCCEEDED");
    expect(terminal.effect_certainty).toBe("KNOWN_APPLIED");
    expect(terminal.claimed_by).toBeNull();
    expect(terminal.lease_expires_at).toBeNull();
    expect(terminal.dispatch_started_at).not.toBeNull();
    const trial = await db
      .selectFrom("trial.trials")
      .select(["lifecycle_status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", trialId)
      .executeTakeFirstOrThrow();
    expect(trial.lifecycle_status).toBe("ACTIVE");
    expect(await getEventTypes(tenantId, provisioned.data.operationId)).toEqual([
      "provider.operation_requested.v1",
      "provider.operation_succeeded.v1",
    ]);
    const attempts = await getAttempts(tenantId, provisioned.data.operationId);
    expect(attempts.map((a) => a.status)).toEqual(["STARTED", "SUCCEEDED"]);
    expect(dumped(terminal.result_summary_json)).not.toContain("infisical://");
    delete process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"];
  });

  it("trial: uncertain outcome parks VERIFYING with no second execution", async () => {
    browser.mode = "unknown";
    try {
      const { tenantId, accountId } = await seedTenant("trial-unknown");
      // FASE5-S4S5: this test's trials run against its own disposable account.
      process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"] = accountId;
      const trialId = await makeTrial(tenantId, "Dispatch2 Trial Unknown");
      const provisioned = await bus.execute<{ status: string; operationId: string }>(
        actor(tenantId),
        "trial.begin_provisioning",
        { trialId },
      );
      if (!provisioned.ok) throw new Error(`begin_provisioning failed: ${dumped(provisioned)}`);
      const callsBefore = browser.calls.length;
      const drained = await dispatcher.drainOnce(10, overrides());
      expect(drained.operationIds).toContain(provisioned.data.operationId);
      expect(drained.verifying).toBeGreaterThanOrEqual(1);
      expect(browser.calls.length).toBe(callsBefore + 1);
      const parked = await getOp(tenantId, provisioned.data.operationId);
      expect(parked.status).toBe("VERIFYING");
      expect(parked.effect_certainty).toBe("UNKNOWN");
      expect(parked.claimed_by).toBeNull();
      // The dispatcher never picks a VERIFYING row back up: no second execution.
      expect((await dispatcher.drainOnce(10, overrides())).claimed).toBe(0);
      expect(browser.calls.length).toBe(callsBefore + 1);
      const trial = await db
        .selectFrom("trial.trials")
        .select(["lifecycle_status"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", trialId)
        .executeTakeFirstOrThrow();
      expect(trial.lifecycle_status).toBe("PROVISIONING");
    } finally {
      browser.mode = "success";
      delete process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"];
    }
  });

  it("fulfillment: durable QUEUED with zero effect, then dispatcher activates with binding", async () => {
    browser.mode = "success";
    const { tenantId } = await seedTenant("fulfill-happy");
    const subscriptionId = await makeSubscription(tenantId, "fulfillhappy");
    const callsBefore = browser.calls.length;
    const requested = await bus.execute<{ operationId: string; status: string; subscriptionStatus: string; already: boolean }>(
      actor(tenantId),
      "fulfillment.request_for_subscription",
      { subscriptionId },
    );
    expect(requested).toMatchObject({
      ok: true,
      data: { status: "QUEUED", subscriptionStatus: "PENDING_ACTIVATION", already: false },
    });
    if (!requested.ok) throw new Error(`fulfillment request failed: ${dumped(requested)}`);
    expect(browser.calls.length).toBe(callsBefore);

    const drained = await dispatcher.drainOnce(10, overrides());
    expect(drained.operationIds).toContain(requested.data.operationId);
    expect(drained.succeeded).toBeGreaterThanOrEqual(1);
    expect(browser.calls.length).toBe(callsBefore + 1);

    const terminal = await getOp(tenantId, requested.data.operationId);
    expect(terminal.status).toBe("SUCCEEDED");
    expect(terminal.effect_certainty).toBe("KNOWN_APPLIED");
    expect(terminal.claimed_by).toBeNull();
    const subscription = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .executeTakeFirstOrThrow();
    expect(subscription.status).toBe("ACTIVE");
    const binding = await db
      .selectFrom("provider.provider_bindings")
      .select(["external_id"])
      .where("tenant_id", "=", tenantId)
      .where("entity_type", "=", "subscription")
      .where("entity_id", "=", subscriptionId)
      .executeTakeFirst();
    expect(binding?.external_id).toBe(`op-${subscriptionId.slice(0, 8)}`);
    const evidence = await db
      .selectFrom("provider.provider_evidence")
      .select(["evidence_type"])
      .where("tenant_id", "=", tenantId)
      .where("provider_operation_id", "=", requested.data.operationId)
      .execute();
    expect(evidence.map((row) => row.evidence_type)).toContain("ACTIVATION_POSTCONDITION");
  });

  it("fulfillment: uncertain outcome parks VERIFYING with no binding and no second execution", async () => {
    browser.mode = "unknown";
    try {
      const { tenantId } = await seedTenant("fulfill-unknown");
      const subscriptionId = await makeSubscription(tenantId, "fulfillunknown");
      const requested = await bus.execute<{ operationId: string }>(
        actor(tenantId),
        "fulfillment.request_for_subscription",
        { subscriptionId },
      );
      if (!requested.ok) throw new Error(`fulfillment request failed: ${dumped(requested)}`);
      const callsBefore = browser.calls.length;
      const drained = await dispatcher.drainOnce(10, overrides());
      expect(drained.operationIds).toContain(requested.data.operationId);
      expect(drained.verifying).toBeGreaterThanOrEqual(1);
      expect(browser.calls.length).toBe(callsBefore + 1);
      const parked = await getOp(tenantId, requested.data.operationId);
      expect(parked.status).toBe("VERIFYING");
      expect(parked.effect_certainty).toBe("UNKNOWN");
      const binding = await db
        .selectFrom("provider.provider_bindings")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("entity_type", "=", "subscription")
        .where("entity_id", "=", subscriptionId)
        .executeTakeFirst();
      expect(binding).toBeUndefined();
      expect((await dispatcher.drainOnce(10, overrides())).claimed).toBe(0);
      expect(browser.calls.length).toBe(callsBefore + 1);
    } finally {
      browser.mode = "success";
    }
  });

  it("license: echo success charges and applies (durable mode changes nothing on this path)", async () => {
    const fx = await makeReadyProcurement();
    const intent = await bus.execute<Record<string, unknown>>(actor(fx.tenantId), "inventory.purchase_app_license", {
      procurementOrderId: fx.procurementOrderId,
      customerId: fx.customerId,
    });
    if (!intent.ok) throw new Error(`purchase intent failed: ${dumped(intent)}`);
    const licenseId = intent.data["id"] as string;
    const charged = await bus.execute<Record<string, unknown>>(
      actor(fx.tenantId),
      "inventory.execute_app_license_charge",
      { licenseId, adapter: "echo", echoOutcome: "success" },
    );
    expect(charged).toMatchObject({ ok: true, data: { effectCertainty: "KNOWN_APPLIED" } });
    if (!charged.ok) throw new Error(`charge failed: ${dumped(charged)}`);
    const operationId = charged.data["operationId"] as string;
    const op = await getOp(fx.tenantId, operationId);
    expect(op.status).toBe("SUCCEEDED");
    expect(op.effect_certainty).toBe("KNOWN_APPLIED");
    const procurement = await db
      .selectFrom("inventory.procurement_orders")
      .select(["status"])
      .where("tenant_id", "=", fx.tenantId)
      .where("id", "=", fx.procurementOrderId)
      .executeTakeFirstOrThrow();
    expect(procurement.status).toBe("PURCHASED");
    const reservation = await db
      .selectFrom("inventory.credit_reservations")
      .select(["status"])
      .where("tenant_id", "=", fx.tenantId)
      .where("id", "=", fx.reservationId)
      .executeTakeFirstOrThrow();
    expect(reservation.status).toBe("CONSUMED");
  });

  it("license: unknown parks VERIFYING with the finding OPEN and never re-charges", async () => {
    const fx = await makeReadyProcurement();
    const intent = await bus.execute<Record<string, unknown>>(actor(fx.tenantId), "inventory.purchase_app_license", {
      procurementOrderId: fx.procurementOrderId,
      customerId: fx.customerId,
    });
    if (!intent.ok) throw new Error(`purchase intent failed: ${dumped(intent)}`);
    const licenseId = intent.data["id"] as string;
    const parked = await bus.execute<Record<string, unknown>>(
      actor(fx.tenantId),
      "inventory.execute_app_license_charge",
      { licenseId, adapter: "echo", echoOutcome: "unknown" },
    );
    expect(parked).toMatchObject({ ok: true, data: { effectCertainty: "UNKNOWN", status: "VERIFYING" } });
    if (!parked.ok) throw new Error(`charge park failed: ${dumped(parked)}`);
    const operationId = parked.data["operationId"] as string;
    expect((await getOp(fx.tenantId, operationId)).status).toBe("VERIFYING");
    const attemptsBefore = await getAttempts(fx.tenantId, operationId);

    // Inconclusive readback: the retry reconciles FIRST and performs no second charge.
    process.env["PROVIDER_READBACK_EFFECT"] = "UNKNOWN";
    try {
      const retried = await bus.execute<Record<string, unknown>>(
        actor(fx.tenantId),
        "inventory.execute_app_license_charge",
        { licenseId, adapter: "echo", echoOutcome: "success" },
      );
      expect(retried).toMatchObject({ ok: true, data: { effectCertainty: "UNKNOWN", conclusive: false, retried: false } });
    } finally {
      delete process.env["PROVIDER_READBACK_EFFECT"];
    }
    expect((await getOp(fx.tenantId, operationId)).status).toBe("VERIFYING");
    expect(await getAttempts(fx.tenantId, operationId)).toHaveLength(attemptsBefore.length);
    const finding = await db
      .selectFrom("inventory.reconciliation_findings")
      .select(["status"])
      .where("tenant_id", "=", fx.tenantId)
      .where("entity_type", "=", "app_license")
      .where("entity_id", "=", licenseId)
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    expect(finding?.status).toBe("OPEN");
  });

  it("F1: durable port payloads carry certified fields only (no domain metadata, no bookkeeping)", async () => {
    browser.mode = "success";
    const { tenantId, accountId } = await seedTenant(`f1-payload-${newId().replace(/-/g, "").slice(-8)}`);
    // FASE5-S4S5: this test's trial runs against its own disposable account
    // (the subscription half is not governed by the trial gate).
    process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"] = accountId;
    const trialId = await makeTrial(tenantId, "F1 Payload Trial");
    const subscriptionId = await makeSubscription(tenantId, "f1payload");
    const provisioned = await bus.execute<{ operationId: string }>(actor(tenantId), "trial.begin_provisioning", {
      trialId,
    });
    if (!provisioned.ok) throw new Error(`begin_provisioning failed: ${dumped(provisioned)}`);
    const requested = await bus.execute<{ operationId: string }>(
      actor(tenantId),
      "fulfillment.request_for_subscription",
      { subscriptionId },
    );
    if (!requested.ok) throw new Error(`fulfillment request failed: ${dumped(requested)}`);
    const callsBefore = browser.calls.length;
    const drained = await dispatcher.drainOnce(10, overrides());
    expect(drained.operationIds).toContain(provisioned.data.operationId);
    expect(drained.operationIds).toContain(requested.data.operationId);
    expect(browser.calls.length).toBe(callsBefore + 2);
    const trialCall = browser.calls.slice(callsBefore).find((c) => c.entityId === trialId);
    const subCall = browser.calls.slice(callsBefore).find((c) => c.entityId === subscriptionId);
    // Certified shapes only — the persisted `trial_kind`/`customer_id` extras
    // plus `adapter`/`capability` bookkeeping never reach the wire, so the
    // durable payload equals the inline one (unit parity in trial-dispatch).
    expect(trialCall?.payload).toEqual({ duration_minutes: 60, adult_content_enabled: false });
    expect(Object.keys(subCall?.payload ?? {}).sort()).toEqual(["plan_id", "plan_key"]);
    expect(trialCall?.secretRef).toBe(VALID_REF);
    expect(subCall?.secretRef).toBe(VALID_REF);
    delete process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"];
  });

  it("F5: trial applier fencing — wrong token writes nothing, owner applies, terminal stays", async () => {
    browser.mode = "success";
    const { tenantId, accountId } = await seedTenant(`f5-trial-${newId().replace(/-/g, "").slice(-8)}`);
    // FASE5-S4S5: this test's trial runs against its own disposable account.
    process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"] = accountId;
    const trialId = await makeTrial(tenantId, "F5 Trial Fence");
    const provisioned = await bus.execute<{ operationId: string }>(actor(tenantId), "trial.begin_provisioning", {
      trialId,
    });
    if (!provisioned.ok) throw new Error(`begin_provisioning failed: ${dumped(provisioned)}`);
    const operationId = provisioned.data.operationId;
    // Plant a dispatcher-style claim (QUEUED→RUNNING + owner token + live lease).
    const owner = `owner-${newId()}`;
    const stale = `stale-${newId()}`;
    await db
      .updateTable("provider.provider_operations")
      .set({
        status: "RUNNING",
        claimed_by: owner,
        claimed_at: new Date(),
        lease_expires_at: sql`now() + make_interval(secs => 300)`,
        dispatch_started_at: new Date(),
      })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", operationId)
      .execute();
    const attemptsBefore = await getAttempts(tenantId, operationId);
    const opEventsBefore = await getEventTypes(tenantId, operationId);
    const trialEventsBefore = await getEventTypes(tenantId, trialId);

    // Wrong token through the REAL applier: null, zero side effects.
    // FASE5-S6: SUCCEEDED now gates on the conclusive readback — both calls
    // carry it (lost still returns null via the fence; owner terminalizes).
    const f5Readback = {
      conclusive: true as const,
      customer: {
        exists: true,
        externalId: "ext-f5",
        isTrial: "1",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      evidence: "test:conclusive",
    };
    const lost = await commandDb.withTransaction(tenantId, async (tx) =>
      applyTrialProvisionOutcome(
        dispatcherCtx(tenantId, tx),
        { operationId, trialId, raw: { outcome: "SUCCEEDED", detail: "f5 lost fence", externalRef: "ext-f5" }, trialReadback: f5Readback },
        { claimedBy: stale },
      ),
    );
    expect(lost).toBeNull();
    const kept = await getOp(tenantId, operationId);
    expect(kept.status).toBe("RUNNING");
    expect(kept.claimed_by).toBe(owner);
    expect(kept.lease_expires_at).not.toBeNull();
    expect(await getAttempts(tenantId, operationId)).toHaveLength(attemptsBefore.length);
    expect(await getEventTypes(tenantId, operationId)).toEqual(opEventsBefore);
    expect(await getEventTypes(tenantId, trialId)).toEqual(trialEventsBefore);
    expect(await getTrialStatus(tenantId, trialId)).toBe("PROVISIONING");

    // Owner token through the REAL applier: terminalizes normally.
    const applied = await commandDb.withTransaction(tenantId, async (tx) =>
      applyTrialProvisionOutcome(
        dispatcherCtx(tenantId, tx),
        { operationId, trialId, raw: { outcome: "SUCCEEDED", detail: "f5 owner fence", externalRef: "ext-f5" }, trialReadback: f5Readback },
        { claimedBy: owner },
      ),
    );
    expect(applied?.status).toBe("SUCCEEDED");
    expect(await getTrialStatus(tenantId, trialId)).toBe("ACTIVE");
    const terminal = await getOp(tenantId, operationId);
    expect(terminal.status).toBe("SUCCEEDED");
    expect(terminal.claimed_by).toBeNull();

    // Already terminal: same fencing outcome (null, no duplicate events).
    const eventsAfter = await getEventTypes(tenantId, operationId);
    const again = await commandDb.withTransaction(tenantId, async (tx) =>
      applyTrialProvisionOutcome(
        dispatcherCtx(tenantId, tx),
        { operationId, trialId, raw: { outcome: "SUCCEEDED", detail: "f5 replay", externalRef: "ext-f5" }, trialReadback: f5Readback },
        { claimedBy: owner },
      ),
    );
    expect(again).toBeNull();
    expect(await getEventTypes(tenantId, operationId)).toEqual(eventsAfter);
    delete process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"];
  });

  it("F5: fulfillment applier fencing — wrong token writes nothing (no binding/activation), terminal stays", async () => {
    browser.mode = "success";
    const seeded = await seedTenant(`f5-fulfill-${newId().replace(/-/g, "").slice(-8)}`);
    const { tenantId, accountId } = seeded;
    const subscriptionId = await makeSubscription(tenantId, "f5fulfill");
    const requested = await bus.execute<{ operationId: string }>(
      actor(tenantId),
      "fulfillment.request_for_subscription",
      { subscriptionId },
    );
    if (!requested.ok) throw new Error(`fulfillment request failed: ${dumped(requested)}`);
    const operationId = requested.data.operationId;
    const owner = `owner-${newId()}`;
    const stale = `stale-${newId()}`;
    await db
      .updateTable("provider.provider_operations")
      .set({
        status: "RUNNING",
        claimed_by: owner,
        claimed_at: new Date(),
        lease_expires_at: sql`now() + make_interval(secs => 300)`,
        dispatch_started_at: new Date(),
      })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", operationId)
      .execute();
    const attemptsBefore = await getAttempts(tenantId, operationId);

    // Wrong token: null, zero attempts/events/binding/activation.
    const lost = await commandDb.withTransaction(tenantId, async (tx) =>
      applySubscriptionProvisionOutcome(
        dispatcherCtx(tenantId, tx),
        {
          operationId,
          subscriptionId,
          providerAccountId: accountId,
          raw: { outcome: "SUCCEEDED", detail: "f5 lost fence", externalRef: "ext-f5f" },
        },
        { claimedBy: stale },
      ),
    );
    expect(lost).toBeNull();
    expect((await getOp(tenantId, operationId)).status).toBe("RUNNING");
    expect(await getAttempts(tenantId, operationId)).toHaveLength(attemptsBefore.length);
    expect(await getSubscriptionStatus(tenantId, subscriptionId)).toBe("PENDING_ACTIVATION");
    expect(
      await db
        .selectFrom("provider.provider_bindings")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("entity_type", "=", "subscription")
        .where("entity_id", "=", subscriptionId)
        .executeTakeFirst(),
    ).toBeUndefined();

    // Owner token: activates with binding.
    const applied = await commandDb.withTransaction(tenantId, async (tx) =>
      applySubscriptionProvisionOutcome(
        dispatcherCtx(tenantId, tx),
        {
          operationId,
          subscriptionId,
          providerAccountId: accountId,
          raw: { outcome: "SUCCEEDED", detail: "f5 owner fence", externalRef: "ext-f5f" },
        },
        { claimedBy: owner },
      ),
    );
    expect(applied?.status).toBe("SUCCEEDED");
    expect(await getSubscriptionStatus(tenantId, subscriptionId)).toBe("ACTIVE");
    expect(
      (
        await db
          .selectFrom("provider.provider_bindings")
          .select(["external_id"])
          .where("tenant_id", "=", tenantId)
          .where("entity_type", "=", "subscription")
          .where("entity_id", "=", subscriptionId)
          .executeTakeFirstOrThrow()
      ).external_id,
    ).toBe("ext-f5f");

    // Already terminal: null, no duplicate binding.
    const bindingsBefore = await db
      .selectFrom("provider.provider_bindings")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("entity_type", "=", "subscription")
      .where("entity_id", "=", subscriptionId)
      .execute();
    const again = await commandDb.withTransaction(tenantId, async (tx) =>
      applySubscriptionProvisionOutcome(
        dispatcherCtx(tenantId, tx),
        {
          operationId,
          subscriptionId,
          providerAccountId: accountId,
          raw: { outcome: "SUCCEEDED", detail: "f5 replay", externalRef: "ext-f5f" },
        },
        { claimedBy: owner },
      ),
    );
    expect(again).toBeNull();
    expect(
      await db
        .selectFrom("provider.provider_bindings")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("entity_type", "=", "subscription")
        .where("entity_id", "=", subscriptionId)
        .execute(),
    ).toHaveLength(bindingsBefore.length);
  });

  it("F4: license applier honesty — failed domain finalization surfaces HUMAN_REQUIRED, never SUCCEEDED", async () => {
    const fx = await makeReadyProcurement();
    const intent = await bus.execute<Record<string, unknown>>(actor(fx.tenantId), "inventory.purchase_app_license", {
      procurementOrderId: fx.procurementOrderId,
      customerId: fx.customerId,
    });
    if (!intent.ok) throw new Error(`purchase intent failed: ${dumped(intent)}`);
    const licenseId = intent.data["id"] as string;
    const operationId = intent.data["operationId"] as string;
    // Plant a dispatcher-style claim so the fenced write can proceed.
    const owner = `owner-${newId()}`;
    await db
      .updateTable("provider.provider_operations")
      .set({
        status: "QUEUED",
        claimed_by: owner,
        claimed_at: new Date(),
        lease_expires_at: sql`now() + make_interval(secs => 300)`,
        dispatch_started_at: new Date(),
      })
      .where("tenant_id", "=", fx.tenantId)
      .where("id", "=", operationId)
      .execute();
    // Break the domain finalization out-of-band (simulates a concurrent
    // release/expire winner): the hold is no longer consumable.
    await db
      .updateTable("inventory.credit_reservations")
      .set({ status: "RELEASED" })
      .where("tenant_id", "=", fx.tenantId)
      .where("id", "=", fx.reservationId)
      .execute();
    const applied = await commandDb.withTransaction(fx.tenantId, async (tx) =>
      applyAppLicensePurchaseOutcome(
        dispatcherCtx(fx.tenantId, tx),
        { operationId, raw: { outcome: "SUCCEEDED", detail: "supplier: ok", externalRef: "lic-ext-1" } },
        { claimedBy: owner },
      ),
    );
    // The distinction: a SUCCEEDED port call with a failed finalization is
    // NOT reported as SUCCEEDED.
    expect(applied).toEqual({ status: "HUMAN_REQUIRED", effectCertainty: "UNKNOWN" });
    // The procurement is untouched (still RESERVED, never PURCHASED).
    const procurement = await db
      .selectFrom("inventory.procurement_orders")
      .select(["status"])
      .where("tenant_id", "=", fx.tenantId)
      .where("id", "=", fx.procurementOrderId)
      .executeTakeFirstOrThrow();
    expect(procurement.status).toBe("RESERVED");
    expect(licenseId).toBeTruthy();
  });
});
