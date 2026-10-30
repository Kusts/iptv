import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createDb, applyMigrations } from "@iptv/database";
import { sql } from "kysely";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";
import { CommandBus } from "../src/commands/command-bus.js";
import { OutboxDrainer } from "../src/outbox/outbox-drainer.js";

/**
 * F16 same-tenant cross-customer ownership (docs/15-implementation-baseline/14-e2e-acceptance-matrix.md
 * row F16; ownership invariant in docs/15-implementation-baseline/20-data-model-blueprint.md):
 * "Valid IDs from two customers of the same tenant are mixed in Order/Subscription/Cycle/Entitlement/add-on
 * charge" — mismatched ownership must be rejected BEFORE granting access or posting money; tenant-only FKs
 * are explicitly insufficient, so the checks below are application-level (renewal command, fulfillment
 * operation) plus database-level insert/update probes for the cycle-vs-renewal-order link, the
 * entitlement subscription-source-vs-customer link, and each add-on cycle charge leg (cycle/add-on/order
 * item), which have no owning command.
 *
 * Expectations are derived from the docs, not from the implementation: every mismatch below asserts
 * rejection (`ok === false`, ownership-shaped code/message, or rejected SQL for the direct probes) and
 * asserts no access was granted (no ACTIVE cycle/entitlement/grant appeared) and no money was posted
 * (no new cycle revenue, no new charge). Each mismatch is paired with a positive control on the same
 * fixtures so a rejection is attributable to the ownership check rather than invalid setup. Direct-SQL
 * probes clean up in `finally` blocks scoped to explicit fixture/probe IDs only.
 *
 * Parent-side swaps (mutating the referenced parent row instead of the link-bearing child row) must be
 * rejected too: the renewal scenario asserts the database rejects repointing a linked renewal order
 * at another customer's person (`orders.person_id`), stamping an inconsistent denormalized
 * `orders.customer_id` on that order, and remapping the linked customer row itself to another
 * person (`crm.customers.person_id`), while the
 * parent-side test asserts the database refuses to
 * reparent a subscription (`customer_id`), a linked cycle (`subscription_id`), an add-on link with
 * posted charges (`subscription_id`), or a charged order item (`order_id`) into another customer's
 * scope. The `subscription.renew` application-level guard for an already-mixed order (simulated
 * malformed row) is covered by the dedicated mocked-stores test in `renewal.unit.ts`, including guard
 * ordering before any mutation — this file probes the database layer, not the command layer.
 */

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

const ASAAS_SECRET = "f16-test-asaas-secret";

describe.skipIf(!hasDb)("F16 same-tenant cross-customer ownership (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

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
      canonicalName: "F16 Person",
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
        product_key: `f16-svc-${suffix}`,
        name: "F16 Service",
        product_type: "SERVICE",
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const planId = newId();
    const planKey = `f16-monthly-${suffix}`;
    await db
      .insertInto("catalog.plans")
      .values({
        id: planId,
        tenant_id: tenantId,
        product_id: productId,
        plan_key: planKey,
        name: "F16 Monthly",
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
      headers: { "asaas-access-token": ASAAS_SECRET },
      payload: {
        event: "PAYMENT_RECEIVED",
        id: `evt-f16-${newId().replace(/-/g, "").slice(-12)}`,
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

  async function customerIdForPerson(personId: string): Promise<string> {
    const row = await db
      .selectFrom("crm.customers")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("person_id", "=", personId)
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Full loop ending at an ACTIVE subscription with echo fulfillment. */
  async function activeSubscriptionFixture(): Promise<{
    personId: string;
    customerId: string;
    orderId: string;
    subscriptionId: string;
    planKey: string;
  }> {
    const personId = await makePerson();
    const { planId, planKey } = await seedMonthlyPlan();
    const orderId = await quoteAndSubmit(personId, planId);
    await settleOrder(orderId);
    const activated = await bus.execute<{ id: string }>(actor(), "subscription.activate_from_order", {
      orderId,
    });
    if (!activated.ok) {
      throw new Error(`activate_from_order failed: ${JSON.stringify(activated)}`);
    }
    const requested = await bus.execute(actor(), "fulfillment.request_for_subscription", {
      subscriptionId: activated.data.id,
      adapter: "echo",
      echoOutcome: "success",
    });
    if (!requested.ok) {
      throw new Error(`fulfillment failed: ${JSON.stringify(requested)}`);
    }
    const customerId = await customerIdForPerson(personId);
    return { personId, customerId, orderId, subscriptionId: activated.data.id, planKey };
  }

  /** Move the open cycle + subscription period to end `daysFromNow` days out (renewal window arrange). */
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

  async function cyclesFor(subscriptionId: string) {
    return db
      .selectFrom("subscription.subscription_cycles")
      .select(["id", "cycle_no", "status", "renewal_order_id", "base_revenue_minor"])
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", subscriptionId)
      .orderBy("cycle_no", "asc")
      .execute();
  }

  async function renewalGrantsFor(subscriptionId: string) {
    return db
      .selectFrom("entitlement.entitlement_grants")
      .select(["id", "grant_type", "source_id"])
      .where("tenant_id", "=", tenantId)
      .where("grant_type", "=", "RENEWAL")
      .execute()
      .then((rows) => rows.filter((r) => typeof r.source_id === "string" && r.source_id.length > 0))
      .then(async (rows) => {
        // Keep only grants whose cycle belongs to this subscription.
        const kept: typeof rows = [];
        for (const row of rows) {
          const cycle = await db
            .selectFrom("subscription.subscription_cycles")
            .select(["id"])
            .where("tenant_id", "=", tenantId)
            .where("id", "=", row.source_id)
            .where("subscription_id", "=", subscriptionId)
            .executeTakeFirst();
          if (cycle !== undefined) {
            kept.push(row);
          }
        }
        return kept;
      });
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
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
        manual_equivalent:
          "Provider operator fulfills the operation manually (HITL) via provider.resolve_operation",
        policy_family: "provider-integration",
        degradation:
          "Forced MANUAL: every operation parks in HUMAN_REQUIRED until durable post-commit dispatch with certified readback",
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
      payload: { email: email("f16"), password: "correct-horse-8", tenantName: "F16 Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    tenantId = body.activeTenantId;
    userId = body.user.id;
  });

  afterAll(async () => {
    delete process.env["PROVIDER_READBACK_EFFECT"];
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

  it("positive controls: two same-tenant customers stay isolated across order/subscription/cycle/entitlement/charge", async () => {
    const a = await activeSubscriptionFixture();
    const b = await activeSubscriptionFixture();
    expect(a.customerId).not.toBe(b.customerId);

    for (const f of [a, b]) {
      const sub = await db
        .selectFrom("subscription.subscriptions")
        .select(["customer_id", "originating_order_id", "status"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", f.subscriptionId)
        .executeTakeFirstOrThrow();
      // The subscription belongs to its own customer and order, and fulfillment granted access.
      expect(sub.customer_id).toBe(f.customerId);
      expect(sub.originating_order_id).toBe(f.orderId);
      expect(sub.status).toBe("ACTIVE");

      const cycles = await cyclesFor(f.subscriptionId);
      expect(cycles).toHaveLength(1);
      expect(cycles[0]?.status).toBe("ACTIVE");

      const entitlements = await db
        .selectFrom("entitlement.entitlements")
        .select(["customer_id", "status"])
        .where("tenant_id", "=", tenantId)
        .where("source_type", "=", "subscription")
        .where("source_id", "=", f.subscriptionId)
        .execute();
      expect(entitlements).toHaveLength(1);
      expect(entitlements[0]?.customer_id).toBe(f.customerId);
      expect(entitlements[0]?.status).toBe("ACTIVE");

      const charges = await db
        .selectFrom("billing.charges")
        .select(["id", "status"])
        .where("tenant_id", "=", tenantId)
        .where("order_id", "=", f.orderId)
        .execute();
      expect(charges.length).toBeGreaterThan(0);
    }

    // No cross-customer entitlement: neither subscription's source carries the other's customer.
    const crossed = await db
      .selectFrom("entitlement.entitlements")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("source_type", "=", "subscription")
      .where((eb) =>
        eb.or([
          eb.and([eb("source_id", "=", a.subscriptionId), eb("customer_id", "=", b.customerId)]),
          eb.and([eb("source_id", "=", b.subscriptionId), eb("customer_id", "=", a.customerId)]),
        ]),
      )
      .execute();
    expect(crossed).toHaveLength(0);
  });

  it("F16 Order/Cycle/Subscription mix: database rejects repointing a linked renewal order at another person and inconsistent denormalized customer writes", async () => {
    const a = await activeSubscriptionFixture();
    const b = await activeSubscriptionFixture();
    expect(a.personId).not.toBe(b.personId);
    await moveCycleEnd(a.subscriptionId, 2);

    const quote = await bus.execute<{ orderId: string; status: string }>(actor(), "renewal.quote", {
      subscriptionId: a.subscriptionId,
    });
    if (!quote.ok) {
      throw new Error(`renewal.quote failed: ${JSON.stringify(quote)}`);
    }
    const renewalOrderId = quote.data.orderId;
    // Positive control: the renewal order names A's person. The canonical owner
    // resolves through person_id → crm.customers.person_id (denormalized
    // orders.customer_id is normally NULL; when present it must agree with it).
    const quotedOrder = await db
      .selectFrom("commerce.orders")
      .select(["person_id", "customer_id", "order_type", "status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", renewalOrderId)
      .executeTakeFirstOrThrow();
    expect(quotedOrder.order_type).toBe("RENEWAL");
    expect(quotedOrder.person_id).toBe(a.personId);
    expect(await customerIdForPerson(quotedOrder.person_id)).toBe(a.customerId);
    if (quotedOrder.customer_id !== null) {
      expect(quotedOrder.customer_id).toBe(a.customerId);
    }
    const originalCustomerId: string | null = quotedOrder.customer_id;

    await settleOrder(renewalOrderId);

    // Positive control: renewal.quote linked the renewal order to A's open cycle.
    const linkedCycle = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["id", "subscription_id"])
      .where("tenant_id", "=", tenantId)
      .where("renewal_order_id", "=", renewalOrderId)
      .executeTakeFirstOrThrow();
    expect(linkedCycle.subscription_id).toBe(a.subscriptionId);

    const cyclesBefore = await cyclesFor(a.subscriptionId);
    expect(cyclesBefore).toHaveLength(1);
    const subBefore = await db
      .selectFrom("subscription.subscriptions")
      .select(["current_period_end"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", a.subscriptionId)
      .executeTakeFirstOrThrow();
    const grantsBefore = await renewalGrantsFor(a.subscriptionId);

    // Probe 1 (parent-side person_id tamper): repoint the renewal order at B's
    // person while it is still linked to A's cycle. The BEFORE UPDATE guard
    // (migration 064 §5) resolves the proposed person-derived owner and rejects
    // the move ("order % owner change breaks a renewal link of another
    // customer"). The rejection leaves the row untouched, so no restore is
    // needed — assert exact person/customer state unchanged.
    await expect(
      db
        .updateTable("commerce.orders")
        .set({ person_id: b.personId })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", renewalOrderId)
        .execute(),
    ).rejects.toThrow(/F16|owner change|renewal link|another customer/i);
    const repersoned = await db
      .selectFrom("commerce.orders")
      .select(["person_id", "customer_id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", renewalOrderId)
      .executeTakeFirstOrThrow();
    expect(repersoned.person_id).toBe(a.personId);
    expect(repersoned.customer_id).toBe(originalCustomerId);
    expect(await customerIdForPerson(repersoned.person_id)).toBe(a.customerId);

    // Probe 2 (inconsistent denormalized customer_id): stamping a non-null
    // customer_id that contradicts the person-derived owner (B over A's person)
    // on the linked order must be rejected (migration 064 §5: "order % stores
    // customer_id % inconsistent with its proposed person-derived owner %").
    // Restore targets the captured original (normally NULL), not A's customer id.
    try {
      await expect(
        db
          .updateTable("commerce.orders")
          .set({ customer_id: b.customerId })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", renewalOrderId)
          .execute(),
      ).rejects.toThrow(/F16|inconsistent|person-derived owner|another customer/i);
    } finally {
      await db
        .updateTable("commerce.orders")
        .set({ customer_id: originalCustomerId })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", renewalOrderId)
        .execute();
    }
    // The rejected stamp left the row with A: exact person/customer state unchanged.
    const afterMix = await db
      .selectFrom("commerce.orders")
      .select(["person_id", "customer_id", "order_type", "status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", renewalOrderId)
      .executeTakeFirstOrThrow();
    expect(afterMix.person_id).toBe(a.personId);
    expect(afterMix.customer_id).toBe(originalCustomerId);
    expect(afterMix.order_type).toBe("RENEWAL");
    expect(await customerIdForPerson(afterMix.person_id)).toBe(a.customerId);

    // Probe 3 (relationship owner remap): move A's customer row itself to B's
    // person. The customer guard (migration 064 §10) finds every order still
    // owned via OLD.person_id whose subscription still names this customer and
    // rejects ("moving customer % to another person breaks an originating link
    // that names it" — A's originating order/subscription qualify first). B's
    // person is a valid same-tenant person; the BEFORE UPDATE trigger fires
    // before the (tenant_id, person_id) uniqueness check, so the F16 rejection
    // — not a unique violation — is expected. Rejection leaves the row
    // untouched: no restore needed, assert exact state unchanged.
    const customerBefore = await db
      .selectFrom("crm.customers")
      .select(["person_id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", a.customerId)
      .executeTakeFirstOrThrow();
    expect(customerBefore.person_id).toBe(a.personId);
    await expect(
      db
        .updateTable("crm.customers")
        .set({ person_id: b.personId })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", a.customerId)
        .execute(),
    ).rejects.toThrow(/F16|another person|originating link|renewal link|names it/i);
    const customerAfter = await db
      .selectFrom("crm.customers")
      .select(["person_id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", a.customerId)
      .executeTakeFirstOrThrow();
    expect(customerAfter.person_id).toBe(a.personId);

    // No access granted and no money posted by the rejected swap: still exactly one
    // cycle, the subscription period is untouched, and no RENEWAL grants appeared.
    const cyclesAfter = await cyclesFor(a.subscriptionId);
    expect(cyclesAfter).toHaveLength(1);
    expect(cyclesAfter[0]?.id).toBe(cyclesBefore[0]?.id);
    expect(cyclesAfter[0]?.status).toBe(cyclesBefore[0]?.status);
    const subAfter = await db
      .selectFrom("subscription.subscriptions")
      .select(["status", "current_period_end"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", a.subscriptionId)
      .executeTakeFirstOrThrow();
    expect(subAfter.status).toBe("ACTIVE");
    expect(subAfter.current_period_end?.getTime()).toBe(subBefore.current_period_end?.getTime());
    expect(await renewalGrantsFor(a.subscriptionId)).toHaveLength(grantsBefore.length);
  });

  it("F16 parent-side mix: database rejects reparenting subscription/cycle rows into another customer's scope", async () => {
    const a = await activeSubscriptionFixture();
    const b = await activeSubscriptionFixture();
    expect(a.customerId).not.toBe(b.customerId);

    // Probe 1 (parent-side subscription.customer_id): A's subscription is anchored to
    // A's originating order by the same-customer composite FK, so repointing it at
    // customer B must be rejected. Both IDs are valid in this tenant.
    const subBefore = await db
      .selectFrom("subscription.subscriptions")
      .select(["customer_id", "originating_order_id", "status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", a.subscriptionId)
      .executeTakeFirstOrThrow();
    expect(subBefore.customer_id).toBe(a.customerId);
    expect(subBefore.originating_order_id).toBe(a.orderId);
    try {
      await expect(
        db
          .updateTable("subscription.subscriptions")
          .set({ customer_id: b.customerId })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", a.subscriptionId)
          .execute(),
      ).rejects.toThrow(/cross-customer|ownership|same customer|customer|foreign key/i);
    } finally {
      await db
        .updateTable("subscription.subscriptions")
        .set({ customer_id: a.customerId })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", a.subscriptionId)
        .execute();
    }
    const subRestored = await db
      .selectFrom("subscription.subscriptions")
      .select(["customer_id", "originating_order_id", "status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", a.subscriptionId)
      .executeTakeFirstOrThrow();
    expect(subRestored.customer_id).toBe(a.customerId);
    expect(subRestored.originating_order_id).toBe(subBefore.originating_order_id);
    expect(subRestored.status).toBe(subBefore.status);

    // Probe 2 (parent-side subscription_cycles.subscription_id): arrange A's open cycle
    // with a same-customer renewal link (its own originating order — accepted because
    // both name customer A), then attempt to reparent the cycle under B's subscription.
    // The cycle renewal guard revalidates the link on subscription_id writes and must
    // reject the swap.
    const cycleA = (await cyclesFor(a.subscriptionId))[0];
    if (cycleA === undefined) {
      throw new Error("expected an open cycle for A");
    }
    const cycleBefore = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["subscription_id", "renewal_order_id", "status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", cycleA.id)
      .executeTakeFirstOrThrow();
    await db
      .updateTable("subscription.subscription_cycles")
      .set({ renewal_order_id: a.orderId })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", cycleA.id)
      .execute();
    try {
      await expect(
        db
          .updateTable("subscription.subscription_cycles")
          .set({ subscription_id: b.subscriptionId })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", cycleA.id)
          .execute(),
      ).rejects.toThrow(/cross-customer|ownership|same customer|customer/i);
    } finally {
      await db
        .updateTable("subscription.subscription_cycles")
        .set({ subscription_id: a.subscriptionId, renewal_order_id: cycleBefore.renewal_order_id })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", cycleA.id)
        .execute();
    }
    const cycleRestored = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["subscription_id", "renewal_order_id", "status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", cycleA.id)
      .executeTakeFirstOrThrow();
    expect(cycleRestored.subscription_id).toBe(a.subscriptionId);
    expect(cycleRestored.renewal_order_id).toBe(cycleBefore.renewal_order_id);
    expect(cycleRestored.status).toBe(cycleBefore.status);

    // Probe 3 (parent-side subscription_addons.subscription_id): post a valid add-on
    // charge for A (cycle A + link A + item A), then attempt to move the link under
    // B's subscription. Guard (8) must reject — the charge would strand on another
    // subscription ("moving add-on link % ... strands charges ..."). The rejection
    // leaves the row untouched, so current-state assertions before/after suffice.
    const itemA = await db
      .selectFrom("commerce.order_items")
      .select(["id", "order_id"])
      .where("tenant_id", "=", tenantId)
      .where("order_id", "=", a.orderId)
      .executeTakeFirstOrThrow();
    const addonSuffix = newId().replace(/-/g, "").slice(-12);
    const addonId = newId();
    await db
      .insertInto("catalog.addons")
      .values({
        id: addonId,
        tenant_id: tenantId,
        addon_key: `f16-parent-addon-${addonSuffix}`,
        name: "F16 Parent Addon",
        billing_type: "RECURRING",
        entitlement_feature_key: `f16-parent-addon-${addonSuffix}`,
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const addonLinkId = newId();
    await db
      .insertInto("subscription.subscription_addons")
      .values({
        id: addonLinkId,
        tenant_id: tenantId,
        subscription_id: a.subscriptionId,
        addon_id: addonId,
        quantity: "1",
        status: "ACTIVE",
        effective_from: new Date(),
        effective_until: null,
        price_policy_ref: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const chargeId = newId();
    await sql`insert into subscription.subscription_addon_cycle_charges
      (id, tenant_id, subscription_cycle_id, subscription_addon_id, quantity, revenue_minor, provider_cost_minor, currency, order_item_id)
      values (${chargeId}::uuid, ${tenantId}::uuid, ${cycleA.id}::uuid, ${addonLinkId}::uuid, 1, 500, 200, 'BRL', ${itemA.id}::uuid)`.execute(
      db,
    );
    const linkBefore = await db
      .selectFrom("subscription.subscription_addons")
      .select(["subscription_id", "status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", addonLinkId)
      .executeTakeFirstOrThrow();
    expect(linkBefore.subscription_id).toBe(a.subscriptionId);
    await expect(
      db
        .updateTable("subscription.subscription_addons")
        .set({ subscription_id: b.subscriptionId })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", addonLinkId)
        .execute(),
    ).rejects.toThrow(/F16|another subscription|another customer|strands charges/i);
    const linkAfter = await db
      .selectFrom("subscription.subscription_addons")
      .select(["subscription_id", "status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", addonLinkId)
      .executeTakeFirstOrThrow();
    expect(linkAfter.subscription_id).toBe(a.subscriptionId);
    expect(linkAfter.status).toBe(linkBefore.status);

    // Probe 4 (parent-side commerce.order_items.order_id): the charge above ties
    // itemA to A's subscription, so moving the item to B's order must be rejected
    // (guard (9): "moving order item % ... breaks an add-on charge link of another
    // customer"). The rejection leaves the row untouched.
    const itemBefore = await db
      .selectFrom("commerce.order_items")
      .select(["order_id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", itemA.id)
      .executeTakeFirstOrThrow();
    expect(itemBefore.order_id).toBe(a.orderId);
    await expect(
      db
        .updateTable("commerce.order_items")
        .set({ order_id: b.orderId })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", itemA.id)
        .execute(),
    ).rejects.toThrow(/F16|another customer|add-on charge link/i);
    const itemAfter = await db
      .selectFrom("commerce.order_items")
      .select(["order_id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", itemA.id)
      .executeTakeFirstOrThrow();
    expect(itemAfter.order_id).toBe(a.orderId);

    // Probe rows leave with the test: the arranged charge, link, and catalog addon
    // are scoped to explicit IDs only; fixture rows (orders, items, cycles) stay.
    await sql`delete from subscription.subscription_addon_cycle_charges
      where tenant_id = ${tenantId}::uuid and id = ${chargeId}::uuid`.execute(db);
    await db
      .deleteFrom("subscription.subscription_addons")
      .where("tenant_id", "=", tenantId)
      .where("id", "=", addonLinkId)
      .execute();
    await db.deleteFrom("catalog.addons").where("tenant_id", "=", tenantId).where("id", "=", addonId).execute();
    expect(
      await sql`select id from subscription.subscription_addon_cycle_charges
        where tenant_id = ${tenantId}::uuid and id = ${chargeId}::uuid`.execute(db).then((r) => r.rows),
    ).toHaveLength(0);
    expect(
      await db
        .selectFrom("subscription.subscription_addons")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", addonLinkId)
        .execute(),
    ).toHaveLength(0);
  });

  it("F16 Subscription/Entitlement mix: activating A with B's fulfillment operation is rejected with nothing granted", async () => {
    // Two fresh PENDING subscriptions (settled orders, no fulfillment yet).
    async function pendingSubscription(): Promise<{ personId: string; customerId: string; subscriptionId: string }> {
      const personId = await makePerson();
      const { planId } = await seedMonthlyPlan();
      const orderId = await quoteAndSubmit(personId, planId);
      await settleOrder(orderId);
      const activated = await bus.execute<{ id: string; status: string }>(
        actor(),
        "subscription.activate_from_order",
        { orderId },
      );
      if (!activated.ok) {
        throw new Error(`activate_from_order failed: ${JSON.stringify(activated)}`);
      }
      expect(activated.data.status).toBe("PENDING_ACTIVATION");
      return { personId, customerId: await customerIdForPerson(personId), subscriptionId: activated.data.id };
    }

    const c = await pendingSubscription();
    const d = await pendingSubscription();
    expect(c.customerId).not.toBe(d.customerId);

    // Positive control: B's own fulfillment succeeds and grants B access.
    const fulfilledD = await bus.execute<{ status: string; subscriptionStatus: string }>(
      actor(),
      "fulfillment.request_for_subscription",
      { subscriptionId: d.subscriptionId, adapter: "echo", echoOutcome: "success" },
    );
    if (!fulfilledD.ok) {
      throw new Error(`fulfillment for D failed: ${JSON.stringify(fulfilledD)}`);
    }
    expect(fulfilledD.data.subscriptionStatus).toBe("ACTIVE");
    const opRow = await sql<{ id: string }>`select id from provider.provider_operations
      where tenant_id = ${tenantId}::uuid and entity_type = 'subscription' and entity_id = ${d.subscriptionId}::uuid
      order by requested_at desc limit 1`.execute(db);
    const operationIdOfD = opRow.rows[0]?.id;
    if (operationIdOfD === undefined) {
      throw new Error("expected a fulfillment operation for D");
    }

    // The mix: A's activation cites B's SUCCEEDED fulfillment operation.
    const activateC = await bus.execute(actor(), "subscription.activate", {
      subscriptionId: c.subscriptionId,
      operationId: operationIdOfD,
    });
    expect(activateC.ok).toBe(false);
    if (activateC.ok) {
      throw new Error(
        `F16 defect: subscription.activate granted ${c.subscriptionId} (customer ${c.customerId}) ` +
          `on fulfillment ${operationIdOfD} owned by ${d.subscriptionId} (customer ${d.customerId})`,
      );
    }
    expect(activateC.code).toBe("precondition_failed");

    // No access granted to A: still PENDING with PENDING entitlements and no INITIAL grants.
    const subC = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", c.subscriptionId)
      .executeTakeFirstOrThrow();
    expect(subC.status).toBe("PENDING_ACTIVATION");
    const entitlementsC = await db
      .selectFrom("entitlement.entitlements")
      .select(["status", "customer_id"])
      .where("tenant_id", "=", tenantId)
      .where("source_type", "=", "subscription")
      .where("source_id", "=", c.subscriptionId)
      .execute();
    expect(entitlementsC).toHaveLength(1);
    expect(entitlementsC[0]?.status).toBe("PENDING");
    expect(entitlementsC[0]?.customer_id).toBe(c.customerId);
  });

  it("F16 cycle/renewal-order mix: database rejects a cycle linked to another customer's order", async () => {
    const a = await activeSubscriptionFixture();
    const b = await activeSubscriptionFixture();
    expect(a.customerId).not.toBe(b.customerId);

    const cycleA = (await cyclesFor(a.subscriptionId))[0];
    if (cycleA === undefined) {
      throw new Error("expected an open cycle for A");
    }
    const cycleRow = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["renewal_order_id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", cycleA.id)
      .executeTakeFirstOrThrow();
    const originalLink: string | null = cycleRow.renewal_order_id;

    // Probe 1 (UPDATE): point A's open cycle at B's settled order. Both IDs are
    // valid in this tenant, so only a cross-customer guard may reject this.
    try {
      await expect(
        db
          .updateTable("subscription.subscription_cycles")
          .set({ renewal_order_id: b.orderId })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", cycleA.id)
          .execute(),
      ).rejects.toThrow(/cross-customer|ownership|same customer|customer/i);
    } finally {
      // Reliable restore scoped to this fixture cycle only.
      await db
        .updateTable("subscription.subscription_cycles")
        .set({ renewal_order_id: originalLink })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", cycleA.id)
        .execute();
    }
    const restored = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["renewal_order_id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", cycleA.id)
      .executeTakeFirstOrThrow();
    expect(restored.renewal_order_id).toBe(originalLink);

    // Probe 2 (INSERT): a non-open cycle for A linked to B's order. COMPLETED
    // keeps the one-open-per-subscription index out of the way so a rejection
    // is attributable to the ownership guard, not the open-cycle guard.
    const existingNos = (await cyclesFor(a.subscriptionId)).map((c) => c.cycle_no);
    const probeNo = Math.max(...existingNos) + 1000;
    const probeCycleId = newId();
    const probeStart = new Date(Date.now() - 60_000);
    const probeEnd = new Date(probeStart.getTime() + 30 * 86_400_000);
    try {
      await expect(
        db
          .insertInto("subscription.subscription_cycles")
          .values({
            id: probeCycleId,
            tenant_id: tenantId,
            subscription_id: a.subscriptionId,
            cycle_no: probeNo,
            starts_at: probeStart,
            ends_at: probeEnd,
            renewal_order_id: b.orderId,
            status: "COMPLETED",
            base_revenue_minor: "0",
            base_provider_cost_minor: null,
            currency: "BRL",
            created_at: new Date(),
          })
          .execute(),
      ).rejects.toThrow(/cross-customer|ownership|same customer|customer/i);
    } finally {
      await db
        .deleteFrom("subscription.subscription_cycles")
        .where("tenant_id", "=", tenantId)
        .where("id", "=", probeCycleId)
        .execute();
    }
    const leftover = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", probeCycleId)
      .execute();
    expect(leftover).toHaveLength(0);
  });

  it("F16 entitlement mix: database rejects an entitlement whose subscription source belongs to another customer", async () => {
    const a = await activeSubscriptionFixture();
    const b = await activeSubscriptionFixture();
    expect(a.customerId).not.toBe(b.customerId);

    const entA = await db
      .selectFrom("entitlement.entitlements")
      .select(["id", "customer_id"])
      .where("tenant_id", "=", tenantId)
      .where("source_type", "=", "subscription")
      .where("source_id", "=", a.subscriptionId)
      .executeTakeFirstOrThrow();
    // Positive control: A's entitlement names A's customer.
    expect(entA.customer_id).toBe(a.customerId);

    // Probe 1 (INSERT): subscription source of A with customer B. B is a real
    // customer of this tenant, so only a cross-customer guard may reject this.
    const suffix = newId().replace(/-/g, "").slice(-12);
    const probeId = newId();
    try {
      await expect(
        db
          .insertInto("entitlement.entitlements")
          .values({
            id: probeId,
            tenant_id: tenantId,
            customer_id: b.customerId,
            feature_key: `f16-xcust-${suffix}`,
            status: "PENDING",
            quantity: null,
            starts_at: new Date(),
            ends_at: null,
            source_type: "subscription",
            source_id: a.subscriptionId,
            metadata_json: {},
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute(),
      ).rejects.toThrow(/cross-customer|ownership|same customer|customer/i);
    } finally {
      await db
        .deleteFrom("entitlement.entitlements")
        .where("tenant_id", "=", tenantId)
        .where("id", "=", probeId)
        .execute();
    }
    const leftover = await db
      .selectFrom("entitlement.entitlements")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", probeId)
      .execute();
    expect(leftover).toHaveLength(0);

    // Probe 2 (UPDATE): reassign A's entitlement to customer B.
    try {
      await expect(
        db
          .updateTable("entitlement.entitlements")
          .set({ customer_id: b.customerId })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", entA.id)
          .execute(),
      ).rejects.toThrow(/cross-customer|ownership|same customer|customer/i);
    } finally {
      await db
        .updateTable("entitlement.entitlements")
        .set({ customer_id: a.customerId })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", entA.id)
        .execute();
    }
    const restored = await db
      .selectFrom("entitlement.entitlements")
      .select(["customer_id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", entA.id)
      .executeTakeFirstOrThrow();
    expect(restored.customer_id).toBe(a.customerId);
  });

  it("F16 add-on charge mix: a cycle/add-on/order-item triple from different customers must not combine", async () => {
    const e = await activeSubscriptionFixture();
    const f = await activeSubscriptionFixture();

    // Positive controls: own-customer order items exist for both settled base orders.
    const itemE = await db
      .selectFrom("commerce.order_items")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("order_id", "=", e.orderId)
      .executeTakeFirstOrThrow();
    const itemF = await db
      .selectFrom("commerce.order_items")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("order_id", "=", f.orderId)
      .executeTakeFirstOrThrow();
    const cycleE = (await cyclesFor(e.subscriptionId))[0];
    if (cycleE === undefined) {
      throw new Error("expected an open cycle for E");
    }

    const suffix = newId().replace(/-/g, "").slice(-12);
    async function attachAddon(subscriptionId: string, tag: string): Promise<string> {
      const addonId = newId();
      await db
        .insertInto("catalog.addons")
        .values({
          id: addonId,
          tenant_id: tenantId,
          addon_key: `f16-extra-${tag}-${suffix}`,
          name: "F16 Extra Screen",
          billing_type: "RECURRING",
          entitlement_feature_key: `f16-extra-screen-${suffix}`,
          status: "ACTIVE",
          metadata_json: {},
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
      const linkId = newId();
      await db
        .insertInto("subscription.subscription_addons")
        .values({
          id: linkId,
          tenant_id: tenantId,
          subscription_id: subscriptionId,
          addon_id: addonId,
          quantity: "1",
          status: "ACTIVE",
          effective_from: new Date(),
          effective_until: null,
          price_policy_ref: null,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
      return linkId;
    }

    const addonLinkE = await attachAddon(e.subscriptionId, "e");
    const addonLinkF = await attachAddon(f.subscriptionId, "f");

    async function chargeCount(cycleId: string, addonLinkId: string): Promise<number> {
      const found = await sql<{ id: string }>`select id from subscription.subscription_addon_cycle_charges
        where tenant_id = ${tenantId}::uuid and subscription_cycle_id = ${cycleId}::uuid
          and subscription_addon_id = ${addonLinkId}::uuid`.execute(db);
      return found.rows.length;
    }

    // Positive control: E's own triple (cycle E + addon E + item E) combines.
    await sql`insert into subscription.subscription_addon_cycle_charges
      (tenant_id, subscription_cycle_id, subscription_addon_id, quantity, revenue_minor, provider_cost_minor, currency, order_item_id)
      values (${tenantId}::uuid, ${cycleE.id}::uuid, ${addonLinkE}::uuid, 1, 500, 200, 'BRL', ${itemE.id}::uuid)`.execute(
      db,
    );
    expect(await chargeCount(cycleE.id, addonLinkE)).toBe(1);

    const cycleF = (await cyclesFor(f.subscriptionId))[0];
    if (cycleF === undefined) {
      throw new Error("expected an open cycle for F");
    }

    async function expectRejectedCharge(
      label: string,
      cycleId: string,
      addonLinkId: string,
      orderItemId: string,
    ): Promise<void> {
      // Every ID below is valid in this tenant, so only a cross-customer
      // guard may reject the insert. Cleanup is scoped to the probe row ID.
      const probeId = newId();
      try {
        await expect(
          sql`insert into subscription.subscription_addon_cycle_charges
            (id, tenant_id, subscription_cycle_id, subscription_addon_id, quantity, revenue_minor, provider_cost_minor, currency, order_item_id)
            values (${probeId}::uuid, ${tenantId}::uuid, ${cycleId}::uuid, ${addonLinkId}::uuid, 1, 500, 200, 'BRL', ${orderItemId}::uuid)`.execute(
            db,
          ),
          label,
        ).rejects.toThrow(/F16|add-on charge|cross-customer|ownership|same customer|customer/i);
      } finally {
        await sql`delete from subscription.subscription_addon_cycle_charges
          where tenant_id = ${tenantId}::uuid and id = ${probeId}::uuid`.execute(db);
      }
    }

    // Add-on leg mix: E's cycle charged with F's add-on link (item stays E's).
    await expectRejectedCharge("cycle E + add-on F + item E", cycleE.id, addonLinkF, itemE.id);
    expect(await chargeCount(cycleE.id, addonLinkF)).toBe(0);

    // Order-item leg mix: F's cycle/add-on charged against E's order item.
    await expectRejectedCharge("cycle F + add-on F + item E", cycleF.id, addonLinkF, itemE.id);
    expect(await chargeCount(cycleF.id, addonLinkF)).toBe(0);

    // Full triple mix: E's cycle with F's add-on link and F's order item.
    await expectRejectedCharge("cycle E + add-on F + item F", cycleE.id, addonLinkF, itemF.id);
    expect(await chargeCount(cycleE.id, addonLinkF)).toBe(0);
    // The valid charge is untouched by the rejected mixes.
    expect(await chargeCount(cycleE.id, addonLinkE)).toBe(1);
  });
});
