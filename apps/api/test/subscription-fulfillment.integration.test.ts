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
import { OutboxDrainer } from "../src/outbox/outbox-drainer.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(-12)}@example.com`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const PERMISSIONS = [
  "crm.person.read",
  "crm.lead.write",
  "billing.read",
  "commerce.order.write",
  "billing.charge.write",
  "billing.refund.request",
  "billing.refund.execute",
  "billing.exception.resolve",
  "provider.operation.read",
  "provider.operation.write",
  "subscription.read",
  "subscription.write",
  "support.ticket.write",
  "settings.manage",
  "agent.review.request",
  "agent.review.decide",
];

const ASAAS_SECRET = "wave6-test-asaas-secret";

describe.skipIf(!hasDb)("Wave 6 Subscriptions + Fulfillment (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let token = "";
  let tenantId = "";
  let userId = "";
  let bus: CommandBus;
  let drainer: OutboxDrainer;

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
    /** Tenant-context precondition; defaults to "0" with a token, `null` omits it. */
    revision?: string | null;
    headers?: Record<string, string>;
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
      if (opts.revision !== null && headers["x-tenant-context-revision"] === undefined) {
        headers["x-tenant-context-revision"] = opts.revision ?? "0";
      }
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

  async function makePerson(): Promise<string> {
    const result = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Wave6 Person",
    });
    if (!result.ok) {
      throw new Error(`person.register failed: ${result.message}`);
    }
    return result.data.id;
  }

  async function seedMonthlyPlan(): Promise<{ planId: string; planKey: string }> {
    const suffix = newId().replace(/-/g, "").slice(-12);
    const productId = newId();
    await db
      .insertInto("catalog.products")
      .values({
        id: productId,
        tenant_id: tenantId,
        product_key: `svc-${suffix}`,
        name: "Wave6 Service",
        product_type: "SERVICE",
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const planId = newId();
    const planKey = `monthly-${suffix}`;
    await db
      .insertInto("catalog.plans")
      .values({
        id: planId,
        tenant_id: tenantId,
        product_id: productId,
        plan_key: planKey,
        name: "Wave6 Monthly",
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

  async function settleOrder(orderId: string): Promise<void> {
    const tenantKey = `asaas-${newId().replace(/-/g, "").slice(-12)}`;
    await db
      .insertInto("billing.tenant_channels")
      .values({
        id: newId(),
        tenant_id: tenantId,
        channel: "ASAAS",
        tenant_key: tenantKey,
        webhook_secret_hash: sha256Hex(ASAAS_SECRET),
        status: "ACTIVE",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
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
        id: `evt-w6-${newId().slice(-12)}`,
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

  /** Full sales-loop setup ending at a SETTLED order (no subscription yet). */
  async function settledOrderFixture(): Promise<{ personId: string; orderId: string; planKey: string }> {
    const personId = await makePerson();
    const { planId, planKey } = await seedMonthlyPlan();
    const orderId = await quoteAndSubmit(personId, planId);
    await settleOrder(orderId);
    return { personId, orderId, planKey };
  }

  async function activateFromOrder(orderId: string): Promise<string> {
    const result = await bus.execute<{ id: string; status: string }>(actor(), "subscription.activate_from_order", {
      orderId,
    });
    if (!result.ok) {
      throw new Error(`subscription.activate_from_order failed: ${JSON.stringify(result)}`);
    }
    return result.data.id;
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    delete process.env["PROVIDER_OPS_ADAPTER"];
    delete process.env["PROVIDER_READBACK_EFFECT"];
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);
    drainer = app.get(OutboxDrainer);

    const register = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w6"), password: "correct-horse-8", tenantName: "Wave6 Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;
  });

  afterAll(async () => {
    delete process.env["PROVIDER_READBACK_EFFECT"];
    if (hasDb && drainer !== undefined) {
      await drainer.drain(1000).catch(() => undefined);
    }
    await app?.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
  });

  it("payment alone never creates a subscription; activation requires SETTLED", async () => {
    const personId = await makePerson();
    const { planId } = await seedMonthlyPlan();
    const draftOrderId = await quoteAndSubmit(personId, planId);
    const draft = await bus.execute(actor(), "subscription.activate_from_order", { orderId: draftOrderId });
    expect(draft.ok).toBe(false);
    if (!draft.ok) {
      expect(draft.code).toBe("precondition_failed");
    }
    await settleOrder(draftOrderId);
    // SETTLED, but no subscription row exists until activate_from_order runs.
    const rows = await db
      .selectFrom("subscription.subscriptions")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("originating_order_id", "=", draftOrderId)
      .execute();
    expect(rows).toHaveLength(0);
  });

  it("full loop: SETTLED → PENDING + cycle → MANUAL resolve SUCCEEDED → ACTIVE + grants + notification", async () => {
    const { orderId, planKey } = await settledOrderFixture();
    const subscriptionId = await activateFromOrder(orderId);

    const pending = await db
      .selectFrom("subscription.subscriptions")
      .select(["status", "cancel_at_period_end"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .executeTakeFirstOrThrow();
    expect(pending.status).toBe("PENDING_ACTIVATION");
    expect(pending.cancel_at_period_end).toBe(false);

    const requested = await bus.execute<{
      operationId: string;
      status: string;
      subscriptionStatus: string;
    }>(actor(), "fulfillment.request_for_subscription", { subscriptionId, adapter: "manual" });
    if (!requested.ok) {
      throw new Error(`fulfillment request failed: ${JSON.stringify(requested)}`);
    }
    expect(requested.data.status).toBe("HUMAN_REQUIRED");
    expect(requested.data.subscriptionStatus).toBe("PENDING_ACTIVATION");

    const resolved = await bus.execute<{ status: string }>(actor(), "provider.resolve_operation", {
      operationId: requested.data.operationId,
      outcome: "SUCCEEDED",
    });
    if (!resolved.ok) {
      throw new Error(`provider resolve failed: ${JSON.stringify(resolved)}`);
    }
    expect(resolved.data.status).toBe("SUCCEEDED");

    const active = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .executeTakeFirstOrThrow();
    expect(active.status).toBe("ACTIVE");

    const cycle = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["id", "status", "cycle_no"])
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", subscriptionId)
      .execute();
    expect(cycle).toHaveLength(1);
    expect(cycle[0]?.status).toBe("ACTIVE");
    expect(Number(cycle[0]?.cycle_no)).toBe(1);

    const entitlements = await db
      .selectFrom("entitlement.entitlements")
      .select(["feature_key", "status"])
      .where("tenant_id", "=", tenantId)
      .where("source_type", "=", "subscription")
      .where("source_id", "=", subscriptionId)
      .execute();
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0]?.feature_key).toBe(`plan:${planKey}`);
    expect(entitlements[0]?.status).toBe("ACTIVE");

    const grants = await db
      .selectFrom("entitlement.entitlement_grants")
      .select(["id", "grant_type", "source_type"])
      .where("tenant_id", "=", tenantId)
      .execute();
    expect(grants.some((g) => g.grant_type === "INITIAL" && g.source_type === "subscription_cycle")).toBe(true);

    const evidence = await db
      .selectFrom("provider.provider_evidence")
      .select(["evidence_type"])
      .where("tenant_id", "=", tenantId)
      .where("provider_operation_id", "=", requested.data.operationId)
      .execute();
    expect(evidence.some((e) => e.evidence_type === "ACTIVATION_POSTCONDITION")).toBe(true);

    const bindings = await db
      .selectFrom("provider.provider_bindings")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("entity_type", "=", "subscription")
      .where("entity_id", "=", subscriptionId)
      .execute();
    // Manual handling has no provider-side external id yet, so no binding
    // row is fabricated — the postcondition lives in provider_evidence.
    expect(bindings).toHaveLength(0);

    // Credential notification: system-originated INTERNAL record, delivery
    // QUEUED behind the manual gateway — never a real secret.
    const notes = await db
      .selectFrom("communication.messages")
      .select(["id", "direction", "sender_type", "body_text"])
      .where("tenant_id", "=", tenantId)
      .where("idempotency_key", "=", `subscription-credentials:${subscriptionId}`)
      .execute();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.direction).toBe("INTERNAL");
    expect(notes[0]?.sender_type).toBe("SYSTEM");
    expect(String(notes[0]?.body_text)).not.toMatch(/senha\s*[:=]\s*\S+/i);
    const deliveries = await db
      .selectFrom("communication.message_deliveries")
      .select(["status", "provider"])
      .where("tenant_id", "=", tenantId)
      .where("message_id", "=", notes[0]?.id as string)
      .execute();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("QUEUED");
    expect(deliveries[0]?.provider).toBe("manual");

    // Double activation is idempotent.
    const again = await bus.execute<{ status: string; already: boolean }>(actor(), "subscription.activate", {
      subscriptionId,
    });
    if (!again.ok) {
      throw new Error(`second activate failed: ${JSON.stringify(again)}`);
    }
    expect(again.data.status).toBe("ACTIVE");
    expect(again.data.already).toBe(true);

    // Read path carries the computed projection.
    const got = await injectRaw({ method: "GET", url: `/v1/subscriptions/${subscriptionId}`, token });
    expect(got.statusCode).toBe(200);
    expect(got.json<{ status: string; projectedState: string }>().status).toBe("ACTIVE");
  });

  it("echo success auto-activates; echo unknown reconciles to ACTIVE", async () => {
    const { orderId } = await settledOrderFixture();
    const subscriptionId = await activateFromOrder(orderId);
    const requested = await bus.execute<{ status: string; subscriptionStatus: string }>(
      actor(),
      "fulfillment.request_for_subscription",
      { subscriptionId, adapter: "echo", echoOutcome: "success" },
    );
    if (!requested.ok) {
      throw new Error(`echo fulfillment failed: ${JSON.stringify(requested)}`);
    }
    expect(requested.data.status).toBe("SUCCEEDED");
    expect(requested.data.subscriptionStatus).toBe("ACTIVE");

    const echoBindings = await db
      .selectFrom("provider.provider_bindings")
      .select(["id", "external_id"])
      .where("tenant_id", "=", tenantId)
      .where("entity_type", "=", "subscription")
      .where("entity_id", "=", subscriptionId)
      .execute();
    expect(echoBindings).toHaveLength(1);
    expect(String(echoBindings[0]?.external_id)).toContain("echo-subscription");

    const { orderId: orderId2 } = await settledOrderFixture();
    const subscriptionId2 = await activateFromOrder(orderId2);
    const unknown = await bus.execute<{ operationId: string; status: string }>(
      actor(),
      "fulfillment.request_for_subscription",
      { subscriptionId: subscriptionId2, adapter: "echo", echoOutcome: "unknown" },
    );
    if (!unknown.ok) {
      throw new Error(`unknown fulfillment failed: ${JSON.stringify(unknown)}`);
    }
    expect(unknown.data.status).toBe("VERIFYING");
    process.env["PROVIDER_READBACK_EFFECT"] = "APPLIED";
    try {
      const reconciled = await bus.execute<{ status: string }>(actor(), "provider.reconcile", {
        operationId: unknown.data.operationId,
      });
      if (!reconciled.ok) {
        throw new Error(`reconcile failed: ${JSON.stringify(reconciled)}`);
      }
      expect(reconciled.data.status).toBe("SUCCEEDED");
    } finally {
      delete process.env["PROVIDER_READBACK_EFFECT"];
    }
    const active = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId2)
      .executeTakeFirstOrThrow();
    expect(active.status).toBe("ACTIVE");
  });

  it("F04: DOM drift degrades only the affected write; unrelated fulfillment continues", async () => {
    const drifted = await settledOrderFixture();
    const driftedSubscriptionId = await activateFromOrder(drifted.orderId);
    const degraded = await bus.execute<{ operationId: string; status: string; subscriptionStatus: string }>(
      actor(),
      "fulfillment.request_for_subscription",
      { subscriptionId: driftedSubscriptionId, adapter: "echo", echoOutcome: "drift" },
    );
    if (!degraded.ok) {
      throw new Error(`drift fulfillment failed: ${JSON.stringify(degraded)}`);
    }
    expect(degraded.data.status).toBe("VERIFYING");
    expect(degraded.data.subscriptionStatus).toBe("PENDING_ACTIVATION");
    const driftedOp = await db
      .selectFrom("provider.provider_operations")
      .select(["status", "effect_certainty", "result_summary_json"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", degraded.data.operationId)
      .executeTakeFirstOrThrow();
    expect(driftedOp.status).toBe("VERIFYING");
    expect(driftedOp.effect_certainty).toBe("UNKNOWN");
    const summary = driftedOp.result_summary_json as Record<string, unknown>;
    expect(summary["degraded"]).toBe(true);
    expect(summary["drift_detected"]).toBe(true);
    const driftedAttempts = await db
      .selectFrom("provider.provider_operation_attempts")
      .select(["error_code"])
      .where("tenant_id", "=", tenantId)
      .where("provider_operation_id", "=", degraded.data.operationId)
      .execute();
    expect(driftedAttempts.some((a) => a.error_code === "DOM_DRIFT")).toBe(true);
    const driftedEvidence = await db
      .selectFrom("provider.provider_evidence")
      .select(["evidence_type"])
      .where("tenant_id", "=", tenantId)
      .where("provider_operation_id", "=", degraded.data.operationId)
      .execute();
    expect(driftedEvidence.some((e) => e.evidence_type === "FULFILLMENT_DEGRADED")).toBe(true);
    const healthy = await settledOrderFixture();
    const healthySubscriptionId = await activateFromOrder(healthy.orderId);
    const healthyRequested = await bus.execute<{ status: string; subscriptionStatus: string }>(
      actor(),
      "fulfillment.request_for_subscription",
      { subscriptionId: healthySubscriptionId, adapter: "echo", echoOutcome: "success" },
    );
    if (!healthyRequested.ok) {
      throw new Error(`healthy fulfillment failed: ${JSON.stringify(healthyRequested)}`);
    }
    expect(healthyRequested.data.status).toBe("SUCCEEDED");
    expect(healthyRequested.data.subscriptionStatus).toBe("ACTIVE");
    const driftedOrder = await db
      .selectFrom("commerce.orders")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", drifted.orderId)
      .executeTakeFirstOrThrow();
    expect(driftedOrder.status).toBe("SETTLED");
    const crmPersonId = await makePerson();
    expect(typeof crmPersonId).toBe("string");
    const ticket = await bus.execute<{ id: string; status: string }>(actor(), "support.ticket.open", {
      personId: drifted.personId,
      summary: "F04 continuity probe: support resolves while one fulfillment is degraded",
    });
    if (!ticket.ok) {
      throw new Error(`support continuity failed: ${JSON.stringify(ticket)}`);
    }
    expect(ticket.data.id.length).toBeGreaterThan(0);
    const driftedRead = await injectRaw({ method: "GET", url: `/v1/subscriptions/${driftedSubscriptionId}`, token });
    expect(driftedRead.statusCode).toBe(200);
    expect(driftedRead.json<{ status: string }>().status).toBe("PENDING_ACTIVATION");
    const healthyRead = await injectRaw({ method: "GET", url: `/v1/subscriptions/${healthySubscriptionId}`, token });
    expect(healthyRead.statusCode).toBe(200);
    expect(healthyRead.json<{ status: string }>().status).toBe("ACTIVE");
  });

  it("F02: provider outage queues fulfillment; recovery resumes without duplicate effect", async () => {
    const outage = await settledOrderFixture();
    const outageSubscriptionId = await activateFromOrder(outage.orderId);
    const failed = await bus.execute<{ operationId: string; status: string }>(
      actor(),
      "fulfillment.request_for_subscription",
      { subscriptionId: outageSubscriptionId, adapter: "echo", echoOutcome: "failed" },
    );
    if (!failed.ok) {
      throw new Error(`outage fulfillment failed: ${JSON.stringify(failed)}`);
    }
    expect(failed.data.status).toBe("FAILED");
    const queuedSub = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", outageSubscriptionId)
      .executeTakeFirstOrThrow();
    expect(queuedSub.status).toBe("PENDING_ACTIVATION");
    const queuedOrder = await db
      .selectFrom("commerce.orders")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", outage.orderId)
      .executeTakeFirstOrThrow();
    expect(queuedOrder.status).toBe("SETTLED");
    const queuedCharges = await db
      .selectFrom("billing.charges")
      .select(["id", "status"])
      .where("tenant_id", "=", tenantId)
      .where("order_id", "=", outage.orderId)
      .execute();
    expect(queuedCharges.length).toBeGreaterThan(0);
    const peer = await settledOrderFixture();
    const peerSubscriptionId = await activateFromOrder(peer.orderId);
    const peerRequested = await bus.execute<{ status: string; subscriptionStatus: string }>(
      actor(),
      "fulfillment.request_for_subscription",
      { subscriptionId: peerSubscriptionId, adapter: "echo", echoOutcome: "success" },
    );
    if (!peerRequested.ok) {
      throw new Error(`peer fulfillment failed: ${JSON.stringify(peerRequested)}`);
    }
    expect(peerRequested.data.subscriptionStatus).toBe("ACTIVE");
    const crmProbe = await makePerson();
    expect(typeof crmProbe).toBe("string");
    const supportProbe = await bus.execute<{ id: string }>(actor(), "support.ticket.open", {
      personId: outage.personId,
      summary: "F02 continuity probe: support resolves while fulfillment is queued",
    });
    if (!supportProbe.ok) {
      throw new Error(`support continuity failed: ${JSON.stringify(supportProbe)}`);
    }
    const drained = await bus.execute<{ retried: number; succeeded: number; stillPending: number }>(
      actor(),
      "fulfillment.retry_due",
      { limit: 100, adapter: "echo", echoOutcome: "success" },
    );
    if (!drained.ok) {
      throw new Error(`fulfillment.retry_due failed: ${JSON.stringify(drained)}`);
    }
    expect(drained.data.retried).toBeGreaterThanOrEqual(1);
    expect(drained.data.succeeded).toBeGreaterThanOrEqual(1);
    const recovered = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", outageSubscriptionId)
      .executeTakeFirstOrThrow();
    expect(recovered.status).toBe("ACTIVE");
    const recoveredCycles = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["id", "status"])
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", outageSubscriptionId)
      .execute();
    expect(recoveredCycles).toHaveLength(1);
    expect(recoveredCycles[0]?.status).toBe("ACTIVE");
    const recoveredEntitlements = await db
      .selectFrom("entitlement.entitlements")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("source_type", "=", "subscription")
      .where("source_id", "=", outageSubscriptionId)
      .execute();
    expect(recoveredEntitlements).toHaveLength(1);
    expect(recoveredEntitlements[0]?.status).toBe("ACTIVE");
    const recoveredBindings = await db
      .selectFrom("provider.provider_bindings")
      .select(["external_id"])
      .where("tenant_id", "=", tenantId)
      .where("entity_type", "=", "subscription")
      .where("entity_id", "=", outageSubscriptionId)
      .execute();
    expect(recoveredBindings).toHaveLength(1);
    const settledAgain = await db
      .selectFrom("commerce.orders")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", outage.orderId)
      .executeTakeFirstOrThrow();
    expect(settledAgain.status).toBe("SETTLED");
    const drainedAgain = await bus.execute<{ retried: number; succeeded: number; stillPending: number }>(
      actor(),
      "fulfillment.retry_due",
      { limit: 100, adapter: "echo", echoOutcome: "success" },
    );
    if (!drainedAgain.ok) {
      throw new Error(`second fulfillment.retry_due failed: ${JSON.stringify(drainedAgain)}`);
    }
    expect(drainedAgain.data.retried).toBe(0);
    const cyclesAfter = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", outageSubscriptionId)
      .execute();
    expect(cyclesAfter).toHaveLength(1);
  });

  it("FAILED fulfillment opens a review and never grants access", async () => {
    const { orderId } = await settledOrderFixture();
    const subscriptionId = await activateFromOrder(orderId);
    const failed = await bus.execute<{ status: string }>(actor(), "fulfillment.request_for_subscription", {
      subscriptionId,
      adapter: "echo",
      echoOutcome: "failed",
    });
    if (!failed.ok) {
      throw new Error(`failed fulfillment errored: ${JSON.stringify(failed)}`);
    }
    expect(failed.data.status).toBe("FAILED");
    const sub = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .executeTakeFirstOrThrow();
    expect(sub.status).toBe("PENDING_ACTIVATION");
    const reviews = await db
      .selectFrom("agent.human_review_requests")
      .select(["id", "review_mode", "reason"])
      .where("tenant_id", "=", tenantId)
      .where("resource_type", "=", "subscription")
      .where("resource_id", "=", subscriptionId)
      .execute();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.review_mode).toBe("MANUAL_EXECUTION");
    expect(reviews[0]?.reason).toBe("PROVIDER_EXCEPTION");
  });

  it("cancel_at_period_end keeps access until cycle expiry, then ENDED", async () => {
    const { orderId } = await settledOrderFixture();
    const subscriptionId = await activateFromOrder(orderId);
    const requested = await bus.execute<{ operationId: string }>(actor(), "fulfillment.request_for_subscription", {
      subscriptionId,
      adapter: "echo",
      echoOutcome: "success",
    });
    if (!requested.ok) {
      throw new Error(`fulfillment failed: ${JSON.stringify(requested)}`);
    }
    const cancelled = await bus.execute<{ cancelAtPeriodEnd: boolean }>(
      actor(),
      "subscription.cancel_at_period_end",
      { subscriptionId },
    );
    if (!cancelled.ok) {
      throw new Error(`cancel failed: ${JSON.stringify(cancelled)}`);
    }
    expect(cancelled.data.cancelAtPeriodEnd).toBe(true);
    const still = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .executeTakeFirstOrThrow();
    expect(still.status).toBe("ACTIVE");

    const resumed = await bus.execute<{ cancelAtPeriodEnd: boolean }>(actor(), "subscription.resume", {
      subscriptionId,
    });
    if (!resumed.ok) {
      throw new Error(`resume failed: ${JSON.stringify(resumed)}`);
    }
    expect(resumed.data.cancelAtPeriodEnd).toBe(false);
    await bus.execute(actor(), "subscription.cancel_at_period_end", { subscriptionId });

    // Age the cycle + period into the past, then run the worker seam.
    const past = new Date(Date.now() - 30 * 86_400_000);
    const pastStart = new Date(Date.now() - 60 * 86_400_000);
    await db
      .updateTable("subscription.subscription_cycles")
      .set({ starts_at: pastStart, ends_at: past })
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", subscriptionId)
      .execute();
    await db
      .updateTable("subscription.subscriptions")
      .set({ current_period_start: pastStart, current_period_end: past })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .execute();
    const expired = await bus.execute<{ expired: string[]; ended: string[] }>(
      actor(),
      "subscription.expire_cycles_due",
      { limit: 100 },
    );
    if (!expired.ok) {
      throw new Error(`expire failed: ${JSON.stringify(expired)}`);
    }
    expect(expired.data.ended).toContain(subscriptionId);
    const ended = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .executeTakeFirstOrThrow();
    expect(ended.status).toBe("ENDED");
  });

  it("suspension requires the service policy; reinstate restores access", async () => {
    const { orderId } = await settledOrderFixture();
    const subscriptionId = await activateFromOrder(orderId);
    await bus.execute(actor(), "fulfillment.request_for_subscription", {
      subscriptionId,
      adapter: "echo",
      echoOutcome: "success",
    });
    const denied = await bus.execute(actor(), "subscription.suspend", {
      subscriptionId,
      reason: "late webhook",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.code).toBe("forbidden");
    }
    const published = await bus.execute(actor(), "policy.publish", {
      family: "subscription.suspension",
      scope: "TENANT",
      class: "TENANT_POLICY",
      document: { allow: true },
    });
    if (!published.ok) {
      throw new Error(`policy.publish failed: ${JSON.stringify(published)}`);
    }
    const suspended = await bus.execute<{ status: string }>(actor(), "subscription.suspend", {
      subscriptionId,
      reason: "explicit service decision: abuse review",
    });
    if (!suspended.ok) {
      throw new Error(`suspend failed: ${JSON.stringify(suspended)}`);
    }
    expect(suspended.data.status).toBe("SUSPENDED");
    const entitlements = await db
      .selectFrom("entitlement.entitlements")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("source_type", "=", "subscription")
      .where("source_id", "=", subscriptionId)
      .execute();
    expect(entitlements.length).toBeGreaterThan(0);
    for (const e of entitlements) {
      expect(e.status).toBe("SUSPENDED");
    }
    const reinstated = await bus.execute<{ status: string }>(actor(), "subscription.reinstate", { subscriptionId });
    if (!reinstated.ok) {
      throw new Error(`reinstate failed: ${JSON.stringify(reinstated)}`);
    }
    expect(reinstated.data.status).toBe("ACTIVE");
  });

  it("tenant isolation: another tenant cannot see or touch the subscription", async () => {
    const { orderId } = await settledOrderFixture();
    const subscriptionId = await activateFromOrder(orderId);
    const other = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w6other"), password: "correct-horse-8", tenantName: "Wave6 Other" },
    });
    expect(other.statusCode).toBe(201);
    const otherBody = other.json<{ token: string }>();
    const got = await injectRaw({ method: "GET", url: `/v1/subscriptions/${subscriptionId}`, token: otherBody.token });
    expect(got.statusCode).toBe(404);
    const listed = await injectRaw({ method: "GET", url: "/v1/subscriptions", token: otherBody.token });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ subscriptions: unknown[] }>().subscriptions).toHaveLength(0);
  });
});
