/**
 * Sigma subscription end-to-end (requires TEST_DATABASE_URL, skipped without it).
 * Fake HTTP fetch only — no live Sigma calls, no token, no purchase.
 * Covers Cenário A (create), B (renew via existing binding, no duplicate),
 * C (uncertain -> VERIFYING -> GET-only reconcile converges) and idempotency
 * (repeat fulfillment never creates a second client).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { ProviderDispatcherService } from "../src/provider/provider-dispatcher.service.js";
import { SIGMA_BASE_URL, SigmaHttpAdapter, SigmaReadback } from "../src/provider/provider-sigma.js";
import type { ProviderOpsPort } from "../src/provider/provider-port.js";
import type { ProviderReadbackPort } from "../src/provider/provider-port.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

const VALID_REF = "infisical://sigma-itest/CINEVISION_USER";
const CONFIGURED_SECRETS_PORT = {
  name: "infisical-test",
  async getSecret(): Promise<string> {
    throw new Error("must never be called by the dispatch path");
  },
};
const TEST_DISPATCH_CAPABILITY_KEY = "provider.cinevision-itest-sigma";
const TEST_TRIAL_CAPABILITY_KEY = "provider.cinevision-itest-sigma-trial";

function dumped(value: unknown): string {
  return JSON.stringify(value ?? null);
}

describe.skipIf(!hasDb)("Sigma subscription end-to-end (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });
  const commandDb = new KyselyCommandDb(db);
  const bus = new CommandBus(commandDb);
  const dispatcher = new ProviderDispatcherService(db, commandDb, TEST_DISPATCH_CAPABILITY_KEY, TEST_TRIAL_CAPABILITY_KEY);
  const suffix = newId().replace(/-/g, "").slice(-12);

  type FakeCall = { url: string; init?: RequestInit };
  const calls: FakeCall[] = [];
  let createSucceeds = true;
  let confirmSucceeds = false;

  function fakeFetch(): typeof fetch {
    return (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const u = String(url);
      if (u === `${SIGMA_BASE_URL}/customers` && init?.method === "POST") {
        if (!createSucceeds) return new Response(JSON.stringify({ message: "down" }), { status: 503, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ data: { id: "cust-sigma-1", server_id: "srv-1", package_id: "pkg-1", status: "ACTIVE" } }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (u === `${SIGMA_BASE_URL}/customers/cust-sigma-1/renew` && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { id: "cust-sigma-1" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u === `${SIGMA_BASE_URL}/customers/cust-sigma-1`) {
        if (!confirmSucceeds) return new Response(JSON.stringify({ message: "down" }), { status: 503, headers: { "content-type": "application/json" } });
        const renewed = calls.some((c) => c.url.endsWith("/renew"));
        return new Response(JSON.stringify({ data: { id: "cust-sigma-1", server_id: "srv-1", package_id: "pkg-1", status: "ACTIVE", expires_at: renewed ? "2027-06-01T00:00:00Z" : "2026-06-01T00:00:00Z" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "unexpected" }), { status: 500, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  }

  const sigma: ProviderOpsPort = new SigmaHttpAdapter(async () => "tok-test", fakeFetch());
  const tokenResolver = async () => "tok-test";

  function actor(tenantId: string): CommandActor {
    return { userId: newId(), isPlatformAdmin: true, tenantId, roleKeys: [], permissions: [], actorType: "human" };
  }

  function overrides() {
    return {
      opsPort: sigma,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      trialCapabilityKey: TEST_TRIAL_CAPABILITY_KEY,
    };
  }

  async function seedTenant(tag: string): Promise<{ tenantId: string; accountId: string }> {
    const tenantId = newId();
    await db.insertInto("control.tenants").values({
      id: tenantId, slug: `sigma-${tag}-${suffix}-${newId().slice(0, 8)}`, name: `Sigma ${tag}`,
      status: "ACTIVE", default_currency: "BRL", timezone: "America/Sao_Paulo", created_at: new Date(), updated_at: new Date(),
    }).execute();
    let provider = await db.selectFrom("provider.providers").select(["id"]).where("provider_key", "=", "cinevision").executeTakeFirst();
    if (provider === undefined) {
      provider = await db.insertInto("provider.providers").values({
        id: newId(), provider_key: "cinevision", name: "CINEVISION", provider_type: "FULFILLMENT", status: "ACTIVE", created_at: new Date(),
      }).returning(["id"]).executeTakeFirstOrThrow();
    }
    const account = await db.insertInto("provider.provider_accounts").values({
      id: newId(), tenant_id: tenantId, provider_id: provider.id, name: `Sigma account ${tag}`,
      status: "ACTIVE", secret_ref: VALID_REF, environment: "SANDBOX", connection_status: "NOT_CONFIGURED",
      version: 1, settings_json: { synthetic: true }, created_at: new Date(), updated_at: new Date(),
    }).returning(["id"]).executeTakeFirstOrThrow();
    return { tenantId, accountId: account.id };
  }

  async function makeSubscription(tenantId: string): Promise<string> {
    const person = await bus.execute<{ id: string }>(actor(tenantId), "person.register", { canonicalName: `Sigma sub ${newId().slice(0, 8)}` });
    if (!person.ok) throw new Error(`person.register failed: ${dumped(person)}`);
    const customerId = newId();
    await db.insertInto("crm.customers").values({
      id: customerId, tenant_id: tenantId, person_id: person.data.id, status: "ACTIVE",
      customer_since: new Date(), last_reactivated_at: null, created_at: new Date(), updated_at: new Date(),
    }).execute();
    const productId = newId();
    await db.insertInto("catalog.products").values({
      id: productId, tenant_id: tenantId, product_key: `svc-${suffix}-${newId().slice(0, 6)}`, name: "Sigma Service",
      product_type: "SERVICE", status: "ACTIVE", metadata_json: {}, created_at: new Date(), updated_at: new Date(),
    }).execute();
    const planId = newId();
    await db.insertInto("catalog.plans").values({
      id: planId, tenant_id: tenantId, product_id: productId, plan_key: `monthly-${suffix}-${newId().slice(0, 6)}`,
      name: "Sigma Monthly", billing_interval_unit: "MONTH", billing_interval_count: 1, status: "ACTIVE",
      metadata_json: { sigma_server_id: "srv-1", sigma_package_id: "pkg-1" }, created_at: new Date(), updated_at: new Date(),
    }).execute();
    const subscriptionId = newId();
    const start = new Date();
    await db.insertInto("subscription.subscriptions").values({
      id: subscriptionId, tenant_id: tenantId, customer_id: customerId, plan_id: planId, originating_order_id: null,
      status: "PENDING_ACTIVATION", started_at: null, current_period_start: start,
      current_period_end: new Date(start.getTime() + 30 * 86_400_000), cancel_at_period_end: false, cancelled_at: null,
      created_at: new Date(), updated_at: new Date(),
    }).execute();
    await db.insertInto("subscription.subscription_cycles").values({
      id: newId(), tenant_id: tenantId, subscription_id: subscriptionId, cycle_no: 1, starts_at: start,
      ends_at: new Date(start.getTime() + 30 * 86_400_000), renewal_order_id: null, status: "PENDING",
      base_revenue_minor: "0", currency: "BRL", created_at: new Date(),
    }).execute();
    return subscriptionId;
  }

  async function getOp(tenantId: string, id: string) {
    return db.selectFrom("provider.provider_operations").select(["id", "tenant_id", "status", "effect_certainty", "result_summary_json"]).where("tenant_id", "=", tenantId).where("id", "=", id).executeTakeFirstOrThrow();
  }
  async function getSubStatus(tenantId: string, id: string) {
    const r = await db.selectFrom("subscription.subscriptions").select(["status"]).where("tenant_id", "=", tenantId).where("id", "=", id).executeTakeFirstOrThrow();
    return r.status;
  }
  async function getBinding(tenantId: string, accountId: string, subscriptionId: string) {
    return db.selectFrom("provider.provider_bindings").select(["external_id", "status"]).where("tenant_id", "=", tenantId).where("provider_account_id", "=", accountId).where("entity_type", "=", "subscription").where("entity_id", "=", subscriptionId).executeTakeFirst();
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    await db.updateTable("platform.capabilities").set({ availability: "AVAILABLE", certification_status: "CERTIFIED" }).where("key", "=", "provider.cinevision").execute();
    await db.insertInto("platform.capabilities").values({
      id: newId(), key: TEST_DISPATCH_CAPABILITY_KEY, owner_context: "provider", availability: "AVAILABLE",
      certification_status: "CERTIFIED", risk_level: "HIGH", mvp_phase: "W0",
      manual_equivalent: "Provider operator fulfills the operation manually (HITL) via provider.resolve_operation",
      policy_family: "provider-integration", degradation: "Isolated test gate; mirrors provider.cinevision", permissions: [], created_at: new Date(), updated_at: new Date(),
    }).onConflict((oc) => oc.column("key").doUpdateSet({ availability: "AVAILABLE", certification_status: "CERTIFIED", updated_at: new Date() })).execute();
    await db.insertInto("platform.capabilities").values({
      id: newId(), key: TEST_TRIAL_CAPABILITY_KEY, owner_context: "provider", availability: "AVAILABLE",
      certification_status: "CERTIFIED", risk_level: "HIGH", mvp_phase: "W0",
      manual_equivalent: "Provider operator fulfills the operation manually (HITL) via provider.resolve_operation",
      policy_family: "provider-integration", degradation: "Isolated per-action trial gate", permissions: [], created_at: new Date(), updated_at: new Date(),
    }).onConflict((oc) => oc.column("key").doUpdateSet({ availability: "AVAILABLE", certification_status: "CERTIFIED", updated_at: new Date() })).execute();
    process.env["PROVIDER_DISPATCH_MODE"] = "durable";
    delete process.env["PROVIDER_READBACK_EFFECT"];
    registerHumanReviewCommands(bus);
    registerPolicyCommands(bus);
    registerCrmCommands(bus);
    registerTrialCommands(bus, { opsPort: sigma, secretsPort: CONFIGURED_SECRETS_PORT, loadSecretRef: async () => VALID_REF, trialCapabilityKey: TEST_TRIAL_CAPABILITY_KEY });
    registerProviderCommands(bus, { opsPort: sigma, secretsPort: CONFIGURED_SECRETS_PORT, loadSecretRef: async () => VALID_REF, trialCapabilityKey: TEST_TRIAL_CAPABILITY_KEY });
    registerFulfillmentCommands(bus, { opsPort: sigma, secretsPort: CONFIGURED_SECRETS_PORT, loadSecretRef: async () => VALID_REF });
  }, 180_000);

  afterAll(async () => {
    delete process.env["PROVIDER_DISPATCH_MODE"];
    await db.destroy().catch(() => undefined);
  });

  it("A) create: durable QUEUED then Sigma POST+GET confirm activates with binding", async () => {
    createSucceeds = true;
    confirmSucceeds = true;
    const { tenantId, accountId } = await seedTenant("create");
    const subscriptionId = await makeSubscription(tenantId);
    const callsBefore = calls.length;
    const requested = await bus.execute<{ operationId: string; status: string }>(actor(tenantId), "fulfillment.request_for_subscription", { subscriptionId, adapter: "sigma" });
    expect(requested).toMatchObject({ ok: true });
    if (!requested.ok) throw new Error(`fulfillment failed: ${dumped(requested)}`);
    expect(requested.data.status).toBe("QUEUED");
    expect(calls.length).toBe(callsBefore);
    const drained = await dispatcher.drainOnce(10, overrides());
    expect(drained.operationIds).toContain(requested.data.operationId);
    expect(drained.succeeded).toBeGreaterThanOrEqual(1);
    expect(await getOp(tenantId, requested.data.operationId).then((r) => r.status)).toBe("SUCCEEDED");
    expect(await getSubStatus(tenantId, subscriptionId)).toBe("ACTIVE");
    expect(await getBinding(tenantId, accountId, subscriptionId).then((r) => r?.external_id)).toBe("cust-sigma-1");
    const postCreate = calls.slice(callsBefore).filter((c) => c.url === `${SIGMA_BASE_URL}/customers` && c.init?.method === "POST");
    expect(postCreate).toHaveLength(1);
    expect(dumped(await getOp(tenantId, requested.data.operationId))).not.toContain("tok-test");
  });

  it("B) renew: existing binding renews (no duplicate create)", async () => {
    const { tenantId, accountId } = await seedTenant("renew");
    const subscriptionId = await makeSubscription(tenantId);
    await db.insertInto("provider.provider_bindings").values({
      id: newId(), tenant_id: tenantId, provider_account_id: accountId, entity_type: "subscription", entity_id: subscriptionId,
      external_id: "cust-sigma-1", external_secondary_id: null, status: "ACTIVE", metadata_json: {}, last_verified_at: new Date(), created_at: new Date(), updated_at: new Date(),
    }).execute();
    calls.length = 0;
    confirmSucceeds = true;
    createSucceeds = true;
    const requested = await bus.execute<{ operationId: string; status: string }>(actor(tenantId), "fulfillment.request_for_subscription", { subscriptionId, adapter: "sigma" });
    expect(requested).toMatchObject({ ok: true });
    if (!requested.ok) throw new Error(`fulfillment failed: ${dumped(requested)}`);
    const drained = await dispatcher.drainOnce(10, overrides());
    expect(drained.operationIds).toContain(requested.data.operationId);
    expect(await getOp(tenantId, requested.data.operationId).then((r) => r.status)).toBe("SUCCEEDED");
    expect(await getSubStatus(tenantId, subscriptionId)).toBe("ACTIVE");
    expect(await getBinding(tenantId, accountId, subscriptionId).then((r) => r?.external_id)).toBe("cust-sigma-1");
    expect(calls.filter((c) => c.url === `${SIGMA_BASE_URL}/customers` && c.init?.method === "POST")).toHaveLength(0);
    expect(calls.some((c) => c.url.endsWith("/renew"))).toBe(true);
  });

  it("C) uncertain: confirm GET fails -> VERIFYING, subscription stays PENDING; reconcile converges via GET-only readback", async () => {
    const { tenantId, accountId } = await seedTenant("uncertain");
    const subscriptionId = await makeSubscription(tenantId);
    calls.length = 0;
    createSucceeds = true;
    confirmSucceeds = false;
    const requested = await bus.execute<{ operationId: string; status: string }>(actor(tenantId), "fulfillment.request_for_subscription", { subscriptionId, adapter: "sigma" });
    expect(requested).toMatchObject({ ok: true });
    if (!requested.ok) throw new Error(`fulfillment failed: ${dumped(requested)}`);
    const drained = await dispatcher.drainOnce(10, overrides());
    expect(drained.operationIds).toContain(requested.data.operationId);
    expect(await getOp(tenantId, requested.data.operationId).then((r) => r.status)).toBe("VERIFYING");
    expect(await getSubStatus(tenantId, subscriptionId)).toBe("PENDING_ACTIVATION");
    confirmSucceeds = true;
    const readback: ProviderReadbackPort = new SigmaReadback(tokenResolver, fakeFetch());
    const reconciled = await bus.execute<{ id: string; status: string; reconciliation?: string }>(actor(tenantId), "provider.reconcile", { operationId: requested.data.operationId });
    expect(reconciled).toMatchObject({ ok: true });
    if (!reconciled.ok) throw new Error(`reconcile failed: ${dumped(reconciled)}`);
    expect(reconciled.data.status).toBe("VERIFYING");
    expect(reconciled.data.reconciliation).toBe("scheduled");
    const callsBefore = calls.length;
    const summary = await dispatcher.reconcileOnce(10, { ...overrides(), readbackPort: readback, loadSecretRef: async () => VALID_REF });
    expect(summary.succeeded).toBeGreaterThanOrEqual(1);
    expect(await getOp(tenantId, requested.data.operationId).then((r) => r.status)).toBe("SUCCEEDED");
    expect(await getSubStatus(tenantId, subscriptionId)).toBe("ACTIVE");
    expect(await getBinding(tenantId, accountId, subscriptionId).then((r) => r?.external_id)).toBe("cust-sigma-1");
    const reconcileCalls = calls.slice(callsBefore);
    expect(reconcileCalls.every((c) => !c.init?.method || c.init.method === "GET")).toBe(true);
    expect(reconcileCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("D) idempotency: repeat fulfillment after SUCCEEDED does not create a second client", async () => {
    const { tenantId } = await seedTenant("idem");
    const subscriptionId = await makeSubscription(tenantId);
    calls.length = 0;
    createSucceeds = true;
    confirmSucceeds = true;
    const first = await bus.execute<{ operationId: string; status: string }>(actor(tenantId), "fulfillment.request_for_subscription", { subscriptionId, adapter: "sigma" });
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error(`first fulfillment failed: ${dumped(first)}`);
    const drained = await dispatcher.drainOnce(10, overrides());
    expect(drained.operationIds).toContain(first.data.operationId);
    const postCount = calls.filter((c) => c.url === `${SIGMA_BASE_URL}/customers` && c.init?.method === "POST").length;
    expect(postCount).toBe(1);
    const second = await bus.execute(actor(tenantId), "fulfillment.request_for_subscription", { subscriptionId, adapter: "sigma" });
    expect(second.ok).toBe(false);
    expect(calls.filter((c) => c.url === `${SIGMA_BASE_URL}/customers` && c.init?.method === "POST").length).toBe(1);
    const ops = await db.selectFrom("provider.provider_operations").select(["id"]).where("tenant_id", "=", tenantId).where("entity_id", "=", subscriptionId).execute();
    expect(ops).toHaveLength(1);
  });
});
