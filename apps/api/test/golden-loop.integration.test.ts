import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createDb, applyMigrations } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";
import { CommandBus } from "../src/commands/command-bus.js";
import { KyselyCommandDb } from "../src/commands/kysely-command-db.js";
import { OutboxDrainer } from "../src/outbox/outbox-drainer.js";
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

/** Deterministic id tail: the UUIDv7 HEAD is a timestamp and collides. */
function suffix(): string {
  return newId().replace(/-/g, "").slice(-12);
}

function email(prefix: string): string {
  return `${prefix}-${suffix()}@example.com`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Union of the per-wave command permissions this journey drives. */
const PERMISSIONS = [
  "crm.person.read",
  "crm.lead.write",
  "conversation.reply",
  "trial.read",
  "trial.write",
  "provider.operation.read",
  "provider.operation.write",
  "billing.read",
  "commerce.order.write",
  "billing.charge.write",
  "subscription.read",
  "subscription.write",
  "support.ticket.read",
  "support.ticket.write",
  "agent.review.request",
  "agent.review.decide",
];

const ASAAS_SECRET = "golden-loop-asaas-secret";
const WAHA_SECRET = "golden-loop-waha-secret";
const SENDER = "5511999990777";

/**
 * Suite-private per-action trial gate: `platform.capabilities` is GLOBAL and
 * every integration file shares one TEST_DATABASE_URL, so the durable trial
 * leg revalidates a row only this file owns (same isolation trick as
 * trial-readback.integration.test.ts).
 */
const TRIAL_CAPABILITY_KEY = "provider.cinevision-itest-golden-loop";
const VALID_REF = "infisical://dispatch-golden-loop/BROWSER_WORKER_KEY";

/** BROWSER-shaped port: needs a validated secret REF, never a value. */
class FakeBrowserPort implements ProviderOpsPort {
  readonly name = "browser";
  readonly requiresSecretRef = true;
  readonly calls: ProviderOperationRequest[] = [];

  async requestOperation(input: ProviderOperationRequest): Promise<AdapterResult> {
    this.calls.push(input);
    return { outcome: "SUCCEEDED", detail: "browser: ok", externalRef: `op-${input.entityId.slice(-8)}` };
  }
}

/** Test-only secrets port: any lookup is a programming error on this path. */
const CONFIGURED_SECRETS_PORT = {
  name: "infisical-test",
  async getSecret(): Promise<string> {
    throw new Error("must never be called by the dispatch path");
  },
};

/** Conclusive generic effect readback for the reconcile convergence. */
class ConclusiveGenericReadback implements ProviderReadbackPort {
  constructor(private readonly applied: boolean) {}
  async verify(): Promise<{ effectApplied: boolean; evidence: string; conclusive: boolean }> {
    return { effectApplied: this.applied, evidence: "golden-loop:conclusive-generic", conclusive: true };
  }
}

describe.skipIf(!hasDb)("Golden Loop E2E (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let token = "";
  let tenantId = "";
  let userId = "";
  let bus: CommandBus;
  let drainer: OutboxDrainer;

  const wahaTenantKey = `waha-gl-${suffix()}`;
  /** Journey state shared by the ordered `it` blocks below (sequential in-file). */
  const journey = {
    personId: "",
    conversationId: "",
    trialId: "",
    trialOperationId: "",
    planId: "",
    planKey: "",
    orderId: "",
    subscriptionId: "",
    renewalOrderId: "",
    ticketId: "",
    inboundMessageId: "",
  };

  function actor(): CommandActor {
    return {
      userId,
      isPlatformAdmin: false,
      tenantId,
      roleKeys: ["tenant_owner"],
      permissions: PERMISSIONS,
      actorType: "human",
    };
  }

  function injectRaw(opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    headers?: Record<string, string>;
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
      headers["x-tenant-context-revision"] ??= "0";
    }
    const options: {
      method: "GET" | "POST";
      url: string;
      headers: Record<string, string>;
      payload?: Record<string, unknown>;
    } = { method: opts.method, url: opts.url, headers };
    if (opts.payload !== undefined) {
      options.payload = opts.payload;
    }
    return app.getHttpAdapter().getInstance().inject(options);
  }

  async function seedChannel(schema: "communication" | "billing", channel: "WHATSAPP" | "ASAAS", key: string, secret: string) {
    await db
      .insertInto(`${schema}.tenant_channels` as "communication.tenant_channels")
      .values({
        id: newId(),
        tenant_id: tenantId,
        channel,
        tenant_key: key,
        webhook_secret_hash: sha256Hex(secret),
        status: "ACTIVE",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
  }

  async function seedMonthlyPlan(): Promise<{ planId: string; planKey: string }> {
    const tail = suffix();
    const productId = newId();
    await db
      .insertInto("catalog.products")
      .values({
        id: productId,
        tenant_id: tenantId,
        product_key: `svc-${tail}`,
        name: "Golden Loop Service",
        product_type: "SERVICE",
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const planId = newId();
    const planKey = `monthly-${tail}`;
    await db
      .insertInto("catalog.plans")
      .values({
        id: planId,
        tenant_id: tenantId,
        product_id: productId,
        plan_key: planKey,
        name: "Golden Loop Monthly",
        billing_interval_unit: "MONTH",
        billing_interval_count: 1,
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto("catalog.prices")
      .values({
        id: newId(),
        tenant_id: tenantId,
        sellable_type: "PLAN",
        sellable_id: planId,
        amount_minor: "3000",
        currency: "BRL",
        starts_at: new Date(Date.now() - 60_000),
        ends_at: null,
        segment_key: null,
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
      })
      .execute();
    return { planId, planKey };
  }

  async function quoteAndSubmit(personId: string, planId: string): Promise<string> {
    const quoted = await bus.execute<{ id: string }>(actor(), "offer.quote", {
      personId,
      items: [{ sellableType: "PLAN", sellableId: planId, quantity: 1 }],
      orderType: "NEW_SUBSCRIPTION",
    });
    if (!quoted.ok) {
      throw new Error(`offer.quote failed: ${JSON.stringify(quoted)}`);
    }
    const submitted = await bus.execute(actor(), "order.submit", { orderId: quoted.data.id });
    if (!submitted.ok) {
      throw new Error(`order.submit failed: ${JSON.stringify(submitted)}`);
    }
    return quoted.data.id;
  }

  /** charge.create + authenticated Asaas PAYMENT_RECEIVED → order SETTLED. */
  async function settleOrder(orderId: string): Promise<void> {
    const tenantKey = `asaas-gl-${suffix()}`;
    await seedChannel("billing", "ASAAS", tenantKey, ASAAS_SECRET);
    // GAP-LOOP-1: charge.create auto-resolves the person's Asaas binding.
    const provisionOwner = await db
      .selectFrom("commerce.orders")
      .select(["person_id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", orderId)
      .executeTakeFirstOrThrow();
    const provisioned = await bus.execute(actor(), "billing.customer_provision", {
      personId: provisionOwner.person_id,
    });
    if (!provisioned.ok) {
      throw new Error(`customer.provision failed: ${JSON.stringify(provisioned)}`);
    }
    const created = await bus.execute<{ id: string; providerChargeId: string | null }>(actor(), "charge.create", {
      orderId,
    });
    if (!created.ok || created.data.providerChargeId === null) {
      throw new Error(`charge.create failed: ${JSON.stringify(created)}`);
    }
    const delivered = await injectRaw({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}`,
      headers: { "x-asaas-secret": ASAAS_SECRET },
      payload: {
        event: "PAYMENT_RECEIVED",
        id: `evt-gl-${suffix()}`,
        payment: { id: created.data.providerChargeId, value: 30.0, currency: "BRL" },
      },
    });
    expect(delivered.statusCode).toBe(202);
    const order = await db
      .selectFrom("commerce.orders")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", orderId)
      .executeTakeFirstOrThrow();
    expect(order.status).toBe("SETTLED");
  }

  /** Move the open cycle + subscription period so a renewal quote is due. */
  async function moveCycleEnd(subscriptionId: string, daysFromNow: number): Promise<void> {
    const end = new Date(Date.now() + daysFromNow * 86_400_000);
    const start = new Date(end.getTime() - 30 * 86_400_000);
    await db
      .updateTable("subscription.subscription_cycles")
      .set({ starts_at: start, ends_at: end })
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", subscriptionId)
      .where("status", "in", ["PENDING", "ACTIVE"])
      .execute();
    await db
      .updateTable("subscription.subscriptions")
      .set({ current_period_start: start, current_period_end: end })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .execute();
  }

  /** Claimable outbox rows for THIS tenant (mirror of the scheduler fixed point). */
  async function pendingOutbox(): Promise<number> {
    const rows = await db
      .selectFrom("platform.outbox_messages")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("state", "in", ["PENDING", "FAILED"])
      .where("next_attempt_at", "<=", new Date())
      .execute();
    return rows.length;
  }

  async function settleOutbox(): Promise<number> {
    let pending = await pendingOutbox();
    for (let tick = 0; pending > 0 && tick < 25; tick += 1) {
      const drained = await drainer.drain(50).catch(() => undefined);
      if (drained === undefined || drained.claimed === 0) {
        break;
      }
      pending = await pendingOutbox();
    }
    return pending;
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    // The W0 fail-closed gate (migration 044) registers `provider.cinevision`
    // as UNAVAILABLE, which blocks the durable browser trial leg and forces
    // fulfillment to MANUAL. This suite's arrange assumes a certified sandbox
    // gate, so upsert the global row AVAILABLE; each suite owns its arrange
    // (same pattern as subscription-fulfillment/trial-readback).
    await db
      .insertInto("platform.capabilities")
      .values({
        id: newId(),
        key: "provider.cinevision",
        owner_context: "provider",
        availability: "AVAILABLE",
        certification_status: "SANDBOX_CERTIFIED",
        risk_level: "HIGH",
        mvp_phase: "W0",
        manual_equivalent: "Provider operator fulfills the operation manually (HITL)",
        policy_family: "provider-integration",
        degradation: "Forced MANUAL: every operation parks in HUMAN_REQUIRED",
        permissions: [],
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          availability: "AVAILABLE",
          certification_status: "SANDBOX_CERTIFIED",
          updated_at: new Date(),
        }),
      )
      .execute();
    await db
      .insertInto("platform.capabilities")
      .values({
        id: newId(),
        key: TRIAL_CAPABILITY_KEY,
        owner_context: "provider",
        availability: "AVAILABLE",
        certification_status: "CERTIFIED",
        risk_level: "HIGH",
        mvp_phase: "W0",
        manual_equivalent: "manual",
        policy_family: "provider-integration",
        degradation: "Isolated golden-loop trial gate",
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
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    process.env["PROVIDER_DISPATCH_MODE"] = "durable";
    delete process.env["PROVIDER_OPS_ADAPTER"];
    delete process.env["PROVIDER_ECHO_OUTCOME"];
    delete process.env["PROVIDER_READBACK_EFFECT"];
    delete process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"];
    delete process.env["WAHA_BASE_URL"];
    delete process.env["WAHA_API_KEY"];
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);
    drainer = app.get(OutboxDrainer);

    const register = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("gl"), password: "correct-horse-8", tenantName: "Golden Loop Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;

    await seedChannel("communication", "WHATSAPP", wahaTenantKey, WAHA_SECRET);
  }, 120_000);

  afterAll(async () => {
    delete process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"];
    delete process.env["PROVIDER_READBACK_EFFECT"];
    delete process.env["PROVIDER_DISPATCH_MODE"];
    // Bounded hygiene drain (same shape as every sibling integration file).
    if (hasDb && drainer !== undefined) {
      const drainBudgetUntil = Date.now() + 6000;
      for (;;) {
        if (Date.now() >= drainBudgetUntil) break;
        const drained = await drainer.drain(50).catch(() => undefined);
        if (drained === undefined || drained.claimed === 0) break;
      }
    }
    await app?.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
  });

  it("legs a-b: inbound WhatsApp → lead/person/conversation → durable trial ACTIVE + binding", async () => {
    // (a1) An unmatched inbound is quarantined, never silently attached.
    const orphanId = `wamsg-gl-orphan-${suffix()}`;
    const orphan = await injectRaw({
      method: "POST",
      url: `/v1/webhooks/waha/${wahaTenantKey}`,
      headers: { "x-waha-secret": WAHA_SECRET },
      payload: {
        event: "message",
        session: "default",
        payload: { id: orphanId, from: `${SENDER}@c.us`, fromMe: false, body: "oi", timestamp: 1758912000 },
      },
    });
    expect(orphan.statusCode).toBe(202);
    const quarantined = await db
      .selectFrom("communication.exceptions")
      .select(["id", "status"])
      .where("tenant_id", "=", tenantId)
      .where("external_message_id", "=", orphanId)
      .execute();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.status).toBe("OPEN");

    // (a2) Lead + person + conversation, then the SAME inbound is ingested.
    const person = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Golden Loop Customer",
      identities: [{ identityType: "WHATSAPP", normalizedValue: SENDER }],
    });
    if (!person.ok) {
      throw new Error(`person.register failed: ${JSON.stringify(person)}`);
    }
    journey.personId = person.data.id;
    const lead = await bus.execute<{ id: string }>(actor(), "lead.capture", { personId: journey.personId });
    if (!lead.ok) {
      throw new Error(`lead.capture failed: ${JSON.stringify(lead)}`);
    }
    const conv = await bus.execute<{ id: string }>(actor(), "conversation.start_manual", {
      personId: journey.personId,
      channel: "WHATSAPP",
    });
    if (!conv.ok) {
      throw new Error(`conversation.start_manual failed: ${JSON.stringify(conv)}`);
    }
    journey.conversationId = conv.data.id;

    journey.inboundMessageId = `wamsg-gl-${suffix()}`;
    const inbound = await injectRaw({
      method: "POST",
      url: `/v1/webhooks/waha/${wahaTenantKey}`,
      headers: { "x-waha-secret": WAHA_SECRET },
      payload: {
        event: "message",
        session: "default",
        payload: {
          id: journey.inboundMessageId,
          from: `${SENDER}@c.us`,
          fromMe: false,
          body: "quero um teste de 1 hora",
          timestamp: 1758912100,
        },
      },
    });
    expect(inbound.statusCode).toBe(202);
    const landed = await db
      .selectFrom("communication.messages")
      .select(["id", "direction", "conversation_id", "person_id"])
      .where("tenant_id", "=", tenantId)
      .where("external_message_id", "=", journey.inboundMessageId)
      .execute();
    expect(landed).toHaveLength(1);
    expect(landed[0]?.direction).toBe("INBOUND");
    expect(landed[0]?.conversation_id).toBe(journey.conversationId);
    expect(landed[0]?.person_id).toBe(journey.personId);

    // (b) Durable trial provisioning on the REAL dispatch path: the request
    // commits PROVISIONING without calling the port, drainOnce sends and parks
    // VERIFYING on an inconclusive readback, and the reconcile convergence
    // (explicit APPLIED + conclusive READ_CUSTOMER) is the ONLY route to
    // ACTIVE + binding (mirrors trial-readback.integration.test.ts).
    const commandDb = new KyselyCommandDb(db);
    const trialBus = new CommandBus(commandDb);
    const browser = new FakeBrowserPort();
    const readback = new FakeTrialReadback("inconclusive");
    const dispatcher = new ProviderDispatcherService(db, commandDb, undefined, TRIAL_CAPABILITY_KEY);
    const trialActor: CommandActor = {
      userId: "golden-loop-trial",
      isPlatformAdmin: true,
      tenantId,
      roleKeys: [],
      permissions: [],
      actorType: "human",
    };
    const deps = {
      opsPort: browser as ProviderOpsPort,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      trialCapabilityKey: TRIAL_CAPABILITY_KEY,
      trialReadbackPort: readback,
    };
    registerCrmCommands(trialBus);
    registerPolicyCommands(trialBus);
    registerTrialCommands(trialBus, deps);
    registerProviderCommands(trialBus, { ...deps, readbackPort: new ConclusiveGenericReadback(false) });

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
    const accountId = (
      await db
        .insertInto("provider.provider_accounts")
        .values({
          id: newId(),
          tenant_id: tenantId,
          provider_id: provider.id,
          name: "Golden Loop disposable account",
          status: "ACTIVE",
          secret_ref: VALID_REF,
          settings_json: { synthetic: true },
          created_at: new Date(),
          updated_at: new Date(),
        })
        .returning(["id"])
        .executeTakeFirstOrThrow()
    ).id;
    process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"] = accountId;
    const drainOverrides = {
      opsPort: browser as ProviderOpsPort,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      trialCapabilityKey: TRIAL_CAPABILITY_KEY,
      trialDisposableAccountId: accountId,
      trialReadbackPort: readback,
    };

    const trial = await trialBus.execute<{ id: string | null }>(trialActor, "trial.request", {
      personId: journey.personId,
      durationMinutes: 60,
    });
    if (!trial.ok || trial.data.id === null) {
      throw new Error(`trial.request failed: ${JSON.stringify(trial)}`);
    }
    journey.trialId = trial.data.id;
    const parked = await trialBus.execute<{ operationId: string; status: string }>(
      trialActor,
      "trial.begin_provisioning",
      { trialId: journey.trialId },
    );
    if (!parked.ok) {
      throw new Error(`begin_provisioning failed: ${JSON.stringify(parked)}`);
    }
    expect(parked.data.status).toBe("PROVISIONING");
    journey.trialOperationId = parked.data.operationId;
    // Durable: the port is NOT called inside the request transaction.
    expect(browser.calls).toHaveLength(0);

    const drained = await dispatcher.drainOnce(10, drainOverrides);
    expect(drained.claimed).toBe(1);
    expect(drained.verifying).toBe(1);
    expect(browser.calls).toHaveLength(1);
    const parkedOp = await db
      .selectFrom("provider.provider_operations")
      .select(["status", "effect_certainty"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", journey.trialOperationId)
      .executeTakeFirstOrThrow();
    expect(parkedOp.status).toBe("VERIFYING");
    expect(parkedOp.effect_certainty).toBe("UNKNOWN");

    // Converge: conclusive generic APPLIED + conclusive READ_CUSTOMER.
    readback.mode = "satisfied";
    const reconciled = await dispatcher.reconcileOnce(100, {
      ...drainOverrides,
      readbackPort: new ConclusiveGenericReadback(true),
    });
    expect(reconciled.operationIds).toContain(journey.trialOperationId);
    expect(reconciled.succeeded).toBeGreaterThanOrEqual(1);
    // The POST is never re-sent by the convergence.
    expect(browser.calls).toHaveLength(1);

    const converged = await db
      .selectFrom("provider.provider_operations")
      .select(["status", "effect_certainty"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", journey.trialOperationId)
      .executeTakeFirstOrThrow();
    expect(converged.status).toBe("SUCCEEDED");
    expect(converged.effect_certainty).toBe("KNOWN_APPLIED");

    const active = await injectRaw({ method: "GET", url: `/v1/trials/${journey.trialId}`, token });
    expect(active.statusCode).toBe(200);
    expect(active.json<{ lifecycleStatus: string }>().lifecycleStatus).toBe("ACTIVE");
    const trialRow = await db
      .selectFrom("trial.trials")
      .select(["person_id", "provider_binding_id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", journey.trialId)
      .executeTakeFirstOrThrow();
    // The trial belongs to the SAME person the inbound WhatsApp created.
    expect(trialRow.person_id).toBe(journey.personId);
    const bindings = await db
      .selectFrom("provider.provider_bindings")
      .select(["id", "external_id"])
      .where("tenant_id", "=", tenantId)
      .where("entity_type", "=", "trial")
      .where("entity_id", "=", journey.trialId)
      .execute();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.external_id).toBe(fakeTrialExternalId(journey.trialId));
    expect(trialRow.provider_binding_id).toBe(bindings[0]?.id);
  }, 60_000);

  it("legs c-f: offer → order → settled charge → entitlement ACTIVE → renewal → support ticket", async () => {
    // (c) Offer/order bound to the trial's person: the only linkage the
    // commerce slice carries is `commerce.orders.person_id`.
    const plan = await seedMonthlyPlan();
    journey.planId = plan.planId;
    journey.planKey = plan.planKey;
    journey.orderId = await quoteAndSubmit(journey.personId, journey.planId);
    await settleOrder(journey.orderId);
    const order = await db
      .selectFrom("commerce.orders")
      .select(["status", "person_id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", journey.orderId)
      .executeTakeFirstOrThrow();
    expect(order.status).toBe("SETTLED");
    expect(order.person_id).toBe(journey.personId);

    // (d) Fulfillment: echo success activates the subscription + entitlement.
    const activated = await bus.execute<{ id: string; status: string }>(
      actor(),
      "subscription.activate_from_order",
      { orderId: journey.orderId },
    );
    if (!activated.ok) {
      throw new Error(`activate_from_order failed: ${JSON.stringify(activated)}`);
    }
    journey.subscriptionId = activated.data.id;
    const fulfilled = await bus.execute<{ status: string; subscriptionStatus: string }>(
      actor(),
      "fulfillment.request_for_subscription",
      { subscriptionId: journey.subscriptionId, adapter: "echo", echoOutcome: "success" },
    );
    if (!fulfilled.ok) {
      throw new Error(`fulfillment failed: ${JSON.stringify(fulfilled)}`);
    }
    expect(fulfilled.data.status).toBe("SUCCEEDED");
    expect(fulfilled.data.subscriptionStatus).toBe("ACTIVE");

    // (e) Renewal: quote → charge → webhook → renewed cycle 2.
    await moveCycleEnd(journey.subscriptionId, 2);
    const quote = await bus.execute<{ orderId: string; status: string; early: boolean }>(
      actor(),
      "renewal.quote",
      { subscriptionId: journey.subscriptionId },
    );
    if (!quote.ok) {
      throw new Error(`renewal.quote failed: ${JSON.stringify(quote)}`);
    }
    expect(quote.data.status).toBe("AWAITING_PAYMENT");
    expect(quote.data.early).toBe(false);
    journey.renewalOrderId = quote.data.orderId;
    await settleOrder(journey.renewalOrderId);
    const renewed = await bus.execute<{ cycleNo: number; already: boolean }>(actor(), "subscription.renew", {
      orderId: journey.renewalOrderId,
    });
    if (!renewed.ok) {
      throw new Error(`subscription.renew failed: ${JSON.stringify(renewed)}`);
    }
    expect(renewed.data.cycleNo).toBe(2);
    expect(renewed.data.already).toBe(false);

    // (f) Support: a ticket for the same customer, visible on the read path.
    const ticket = await bus.execute<{ id: string; status: string }>(actor(), "support.ticket.open", {
      personId: journey.personId,
      priority: "HIGH",
      summary: "Golden Loop: playback travando apos a renovacao",
    });
    if (!ticket.ok) {
      throw new Error(`support.ticket.open failed: ${JSON.stringify(ticket)}`);
    }
    journey.ticketId = ticket.data.id;
    expect(ticket.data.status).toBe("NEW");
    const listed = await injectRaw({
      method: "GET",
      url: `/v1/tickets?personId=${journey.personId}`,
      token,
    });
    expect(listed.statusCode).toBe(200);
    const tickets = listed.json<{ tickets: Array<{ id: string; status: string }> }>().tickets;
    expect(tickets.some((t) => t.id === journey.ticketId && t.status === "NEW")).toBe(true);
  }, 60_000);

  it("leg g: invariants hold and a second tenant sees nothing of the journey", async () => {
    // Outbox converges for this tenant (bounded real drains, never a sleep).
    expect(await settleOutbox()).toBe(0);

    // Exactly one PAID charge per settled order, across both orders.
    for (const orderId of [journey.orderId, journey.renewalOrderId]) {
      const charges = await db
        .selectFrom("billing.charges")
        .select(["id", "status"])
        .where("tenant_id", "=", tenantId)
        .where("order_id", "=", orderId)
        .execute();
      expect(charges).toHaveLength(1);
      expect(charges[0]?.status).toBe("PAID");
      // Financial proof: exactly ONE settlement transaction posted per order
      // (a PAID charge alone cannot distinguish double posting).
      const settlements = await db
        .selectFrom("finance.financial_transactions")
        .select(["id", "idempotency_key"])
        .where("tenant_id", "=", tenantId)
        .where("transaction_type", "=", "ORDER_SETTLEMENT")
        .where("reference_id", "=", orderId)
        .execute();
      expect(settlements).toHaveLength(1);
      expect(settlements[0]?.idempotency_key).toBe(`order-settlement:${orderId}`);
    }

    // Subscription/entitlement state after renewal.
    const sub = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", journey.subscriptionId)
      .executeTakeFirstOrThrow();
    expect(sub.status).toBe("ACTIVE");
    const cycles = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["cycle_no", "status"])
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", journey.subscriptionId)
      .orderBy("cycle_no", "asc")
      .execute();
    expect(cycles).toHaveLength(2);
    expect(cycles[1]?.status).toBe("ACTIVE");
    const entitlements = await db
      .selectFrom("entitlement.entitlements")
      .select(["feature_key", "status"])
      .where("tenant_id", "=", tenantId)
      .where("source_type", "=", "subscription")
      .where("source_id", "=", journey.subscriptionId)
      .execute();
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0]?.feature_key).toBe(`plan:${journey.planKey}`);
    expect(entitlements[0]?.status).toBe("ACTIVE");

    // Trial operation SUCCEEDED/KNOWN_APPLIED + subscription binding present.
    const op = await db
      .selectFrom("provider.provider_operations")
      .select(["status", "effect_certainty"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", journey.trialOperationId)
      .executeTakeFirstOrThrow();
    expect(op.status).toBe("SUCCEEDED");
    expect(op.effect_certainty).toBe("KNOWN_APPLIED");
    const subBindings = await db
      .selectFrom("provider.provider_bindings")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("entity_type", "=", "subscription")
      .where("entity_id", "=", journey.subscriptionId)
      .execute();
    expect(subBindings).toHaveLength(1);

    // Every journey aggregate lives under THIS tenant.
    const ownerIds = [
      (await db.selectFrom("trial.trials").select("id").where("tenant_id", "=", tenantId).execute()).length,
      (await db.selectFrom("commerce.orders").select("id").where("tenant_id", "=", tenantId).execute()).length,
      (await db
        .selectFrom("subscription.subscriptions")
        .select("id")
        .where("tenant_id", "=", tenantId)
        .execute()).length,
      (await db
        .selectFrom("support.support_tickets")
        .select("id")
        .where("tenant_id", "=", tenantId)
        .execute()).length,
      (await db
        .selectFrom("provider.provider_operations")
        .select("id")
        .where("tenant_id", "=", tenantId)
        .execute()).length,
    ];
    expect(ownerIds.every((n) => n > 0)).toBe(true);

    // A second registered tenant sees ZERO of it through its own reads.
    const other = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("gl-other"), password: "correct-horse-8", tenantName: "Golden Loop Other" },
    });
    expect(other.statusCode).toBe(201);
    const otherToken = other.json<{ token: string }>().token;
    const foreignOrder = await injectRaw({
      method: "GET",
      url: `/v1/orders/${journey.orderId}`,
      token: otherToken,
    });
    expect(foreignOrder.statusCode).toBe(404);
    const foreignSubscription = await injectRaw({
      method: "GET",
      url: `/v1/subscriptions/${journey.subscriptionId}`,
      token: otherToken,
    });
    expect(foreignSubscription.statusCode).toBe(404);
    const foreignTrial = await injectRaw({
      method: "GET",
      url: `/v1/trials/${journey.trialId}`,
      token: otherToken,
    });
    expect(foreignTrial.statusCode).toBe(404);
    const foreignPersons = await injectRaw({ method: "GET", url: "/v1/crm/persons", token: otherToken });
    expect(foreignPersons.json<{ persons: unknown[] }>().persons).toHaveLength(0);
    const foreignOrders = await injectRaw({ method: "GET", url: "/v1/orders", token: otherToken });
    expect(foreignOrders.json<{ orders: unknown[] }>().orders).toHaveLength(0);
    const foreignSubs = await injectRaw({ method: "GET", url: "/v1/subscriptions", token: otherToken });
    expect(foreignSubs.json<{ subscriptions: unknown[] }>().subscriptions).toHaveLength(0);
    const foreignTickets = await injectRaw({
      method: "GET",
      url: `/v1/tickets?personId=${journey.personId}`,
      token: otherToken,
    });
    expect(foreignTickets.json<{ tickets: unknown[] }>().tickets).toHaveLength(0);
  }, 120_000);
});