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
  "settings.manage",
  "agent.review.request",
  "agent.review.decide",
];

const ASAAS_SECRET = "wave9-test-asaas-secret";

describe.skipIf(!hasDb)("Wave 9 Renewal + Retention (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let token = "";
  let tenantId = "";
  let userId = "";
  let approverId = "";
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

  function approver(): CommandActor {
    return { ...actor(), userId: approverId };
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
      canonicalName: "Wave9 Person",
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
        name: "Wave9 Service",
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
        name: "Wave9 Monthly",
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
        id: `evt-w9-${newId().replace(/-/g, "").slice(-12)}`,
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

  /** Full Wave 6 loop ending at an ACTIVE subscription. */
  async function activeSubscriptionFixture(): Promise<{ subscriptionId: string; planKey: string }> {
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
    const requested = await bus.execute<{ operationId: string }>(actor(), "fulfillment.request_for_subscription", {
      subscriptionId: activated.data.id,
      adapter: "echo",
      echoOutcome: "success",
    });
    if (!requested.ok) {
      throw new Error(`fulfillment failed: ${JSON.stringify(requested)}`);
    }
    return { subscriptionId: activated.data.id, planKey };
  }

  /** Move the open cycle + subscription period to end `daysFromNow` days out. */
  async function moveCycleEnd(subscriptionId: string, daysFromNow: number): Promise<Date> {
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
    return end;
  }

  async function openCycle(subscriptionId: string) {
    return db
      .selectFrom("subscription.subscription_cycles")
      .select(["id", "cycle_no", "status", "ends_at", "renewal_order_id"])
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", subscriptionId)
      .where("status", "in", ["PENDING", "ACTIVE"])
      .executeTakeFirst();
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    delete process.env["PROVIDER_OPS_ADAPTER"];
    // The fulfillment echo flow below presupposes a certified sandbox gate:
    // upsert the global row AVAILABLE (production stays fail-closed until
    // real certification). platform.capabilities is GLOBAL and test files
    // share one TEST_DATABASE_URL, so each suite owns its arrange (same
    // pattern as trial-compat/subscription-fulfillment integration).
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
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);
    drainer = app.get(OutboxDrainer);

    const register = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w9"), password: "correct-horse-8", tenantName: "Wave9 Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;

    // Second tenant member: the trust-renewal approver (requester cannot
    // self-approve, and review actions FK to a real membership).
    approverId = newId();
    await db
      .insertInto("control.users")
      .values({
        id: approverId,
        auth_subject: `email:${email("w9second")}`,
        display_name: "Wave9 Approver",
        status: "ACTIVE",
        is_platform_admin: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto("control.tenant_memberships")
      .values({
        id: newId(),
        tenant_id: tenantId,
        user_id: approverId,
        role_key: "tenant_owner",
        status: "ACTIVE",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
  });

  afterAll(async () => {
    // FASE5-S6-FIX2: bounded hygiene drain — `drain(limit)` takes a row
    // COUNT, not a time budget, and publishes serially, so an unbounded
    // teardown drain overruns the hook timeout (the S6 root cause). This
    // loop caps the teardown contribution at ~6s wall-clock (leaving hook
    // budget for app.close) while still draining shared-table residue, so
    // budget-capped oldest-first drains (scheduler tick drain(25),
    // test loop-drains) keep converging instead of starving. No assertion
    // observes drained delivery; outbox assertions are tenant-scoped.
    if (hasDb && drainer !== undefined) {
      const drainBudgetUntil = Date.now() + 6000;
      for (;;) {
        if (Date.now() >= drainBudgetUntil) break;
        const drained = await drainer.drain(50).catch(() => undefined);
        if (drained === undefined || drained.claimed === 0) break;
      }
    }
    try {
      await app?.close().catch(() => undefined);
    } finally {
      await db.destroy().catch(() => undefined);
    }
  });

  it("full renewal happy path: quote → charge → webhook → renew → new OPEN cycle", async () => {
    const { subscriptionId, planKey } = await activeSubscriptionFixture();
    await moveCycleEnd(subscriptionId, 2);

    const read = await injectRaw({ method: "GET", url: `/v1/subscriptions/${subscriptionId}`, token });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ projectedState: string }>().projectedState).toBe("RENEWAL_DUE");

    const quote = await bus.execute<{
      orderId: string;
      status: string;
      netAmountMinor: string;
      currency: string;
      early: boolean;
      already: boolean;
    }>(actor(), "renewal.quote", { subscriptionId });
    if (!quote.ok) {
      throw new Error(`renewal.quote failed: ${JSON.stringify(quote)}`);
    }
    expect(quote.data.status).toBe("AWAITING_PAYMENT");
    expect(quote.data.netAmountMinor).toBe("3000");
    expect(quote.data.currency).toBe("BRL");
    expect(quote.data.early).toBe(false);
    expect(quote.data.already).toBe(false);
    const renewalOrderId = quote.data.orderId;

    // Idempotent quote: the same OPEN renewal order comes back.
    const again = await bus.execute<{ orderId: string; already: boolean }>(actor(), "renewal.quote", {
      subscriptionId,
    });
    if (!again.ok) {
      throw new Error(`second quote failed: ${JSON.stringify(again)}`);
    }
    expect(again.data.orderId).toBe(renewalOrderId);
    expect(again.data.already).toBe(true);

    // Price snapshot pinned the CURRENT catalog price.
    const snapshots = await db
      .selectFrom("commerce.price_snapshots")
      .innerJoin("commerce.order_items", (join) =>
        join
          .onRef("commerce.order_items.tenant_id", "=", "commerce.price_snapshots.tenant_id")
          .onRef("commerce.order_items.id", "=", "commerce.price_snapshots.order_item_id"),
      )
      .select(["commerce.price_snapshots.sale_price_minor"])
      .where("commerce.price_snapshots.tenant_id", "=", tenantId)
      .where("commerce.order_items.order_id", "=", renewalOrderId)
      .execute();
    expect(snapshots).toHaveLength(1);
    expect(String(snapshots[0]?.sale_price_minor)).toBe("3000");

    // Renew before settlement is rejected; payment alone never renews.
    const early = await bus.execute(actor(), "subscription.renew", { orderId: renewalOrderId });
    expect(early.ok).toBe(false);

    await settleOrder(renewalOrderId);

    const renewed = await bus.execute<{
      subscriptionId: string;
      priorCycleId: string;
      cycleId: string;
      cycleNo: number;
      already: boolean;
    }>(actor(), "subscription.renew", { orderId: renewalOrderId });
    if (!renewed.ok) {
      throw new Error(`subscription.renew failed: ${JSON.stringify(renewed)}`);
    }
    expect(renewed.data.subscriptionId).toBe(subscriptionId);
    expect(renewed.data.cycleNo).toBe(2);
    expect(renewed.data.already).toBe(false);

    const cycles = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["id", "cycle_no", "status", "starts_at", "ends_at", "renewal_order_id", "base_revenue_minor"])
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", subscriptionId)
      .orderBy("cycle_no", "asc")
      .execute();
    expect(cycles).toHaveLength(2);
    expect(cycles[0]?.status).toBe("COMPLETED");
    expect(cycles[1]?.status).toBe("ACTIVE");
    // Canonical lifecycle: only the prior cycle keeps the pointer to its
    // upcoming renewal order; the newly opened cycle starts unlinked so the
    // next quote/reminder is never blocked by the settled order.
    expect(cycles[0]?.renewal_order_id).toBe(renewalOrderId);
    expect(cycles[1]?.renewal_order_id).toBeNull();
    expect(String(cycles[1]?.base_revenue_minor)).toBe("3000");
    // Subscription persists across renewals: same row, new period.
    const sub = await db
      .selectFrom("subscription.subscriptions")
      .select(["id", "status", "current_period_start", "current_period_end"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .executeTakeFirstOrThrow();
    expect(sub.status).toBe("ACTIVE");
    expect(sub.current_period_start?.getTime()).toBe(cycles[1]?.starts_at?.getTime() ?? NaN);

    // Exactly one OPEN cycle (019 guard held across close-then-open).
    const openCount = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", subscriptionId)
      .where("status", "in", ["PENDING", "ACTIVE"])
      .execute();
    expect(openCount).toHaveLength(1);

    // Entitlements refreshed to the new window + a RENEWAL grant appended.
    const entitlements = await db
      .selectFrom("entitlement.entitlements")
      .select(["feature_key", "status", "starts_at", "ends_at"])
      .where("tenant_id", "=", tenantId)
      .where("source_type", "=", "subscription")
      .where("source_id", "=", subscriptionId)
      .execute();
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0]?.feature_key).toBe(`plan:${planKey}`);
    expect(entitlements[0]?.status).toBe("ACTIVE");
    const grants = await db
      .selectFrom("entitlement.entitlement_grants")
      .select(["grant_type", "source_type", "source_id"])
      .where("tenant_id", "=", tenantId)
      .where("source_type", "=", "subscription_cycle")
      .where("source_id", "=", renewed.data.cycleId)
      .execute();
    expect(grants.some((g) => g.grant_type === "RENEWAL")).toBe(true);

    // Projection left RENEWAL_DUE (new period is a full month out).
    const after = await injectRaw({ method: "GET", url: `/v1/subscriptions/${subscriptionId}`, token });
    expect(after.json<{ projectedState: string }>().projectedState).toBe("ACTIVE");

    // Double renew is idempotent.
    const re = await bus.execute<{ cycleId: string; already: boolean }>(actor(), "subscription.renew", {
      orderId: renewalOrderId,
    });
    if (!re.ok) {
      throw new Error(`second renew failed: ${JSON.stringify(re)}`);
    }
    expect(re.data.cycleId).toBe(renewed.data.cycleId);
    expect(re.data.already).toBe(true);

    // Renewal order is listed per subscription.
    const listed = await injectRaw({
      method: "GET",
      url: `/v1/renewals?subscriptionId=${subscriptionId}`,
      token,
    });
    expect(listed.statusCode).toBe(200);
    const orders = listed.json<{ orders: Array<{ id: string; status: string }> }>().orders;
    expect(orders.some((o) => o.id === renewalOrderId && o.status === "SETTLED")).toBe(true);
  });

  it("early renewal is rejected unless the policy allows it", async () => {
    const { subscriptionId } = await activeSubscriptionFixture();
    // Cycle ends ~30 days out: far outside the default 7d window.
    const early = await bus.execute(actor(), "renewal.quote", { subscriptionId });
    expect(early.ok).toBe(false);
    if (!early.ok) {
      expect(early.code).toBe("precondition_failed");
    }
    const published = await bus.execute(actor(), "policy.publish", {
      family: "subscription.renewal",
      scope: "TENANT",
      class: "TENANT_POLICY",
      document: { early_allowed: true, window_days: 7 },
    });
    if (!published.ok) {
      throw new Error(`policy.publish failed: ${JSON.stringify(published)}`);
    }
    const allowed = await bus.execute<{ orderId: string; early: boolean; already: boolean }>(
      actor(),
      "renewal.quote",
      { subscriptionId },
    );
    if (!allowed.ok) {
      throw new Error(`early quote failed after policy allow: ${JSON.stringify(allowed)}`);
    }
    expect(allowed.data.early).toBe(true);
    expect(allowed.data.already).toBe(false);
  });

  it("trust renewal: forbidden without review, bounded extension once with approval", async () => {
    const { subscriptionId } = await activeSubscriptionFixture();
    await moveCycleEnd(subscriptionId, 2);
    const before = await openCycle(subscriptionId);
    expect(before).toBeDefined();

    const denied = await bus.execute(actor(), "subscription.trust_renew", { subscriptionId });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.code).toBe("forbidden");
    }
    const reviews = await db
      .selectFrom("agent.human_review_requests")
      .select(["id", "review_mode", "reason", "status"])
      .where("tenant_id", "=", tenantId)
      .where("resource_type", "=", "subscription_trust_renewal")
      .where("resource_id", "=", (before as { id: string }).id)
      .execute();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.review_mode).toBe("APPROVAL");
    const reviewId = reviews[0]?.id as string;

    // Self-approval never counts: the requester approving their own request
    // still leaves the extension forbidden.
    const selfApproved = await bus.execute(actor(), "human_review.approve", { requestId: reviewId });
    if (!selfApproved.ok) {
      throw new Error(`self approve failed: ${JSON.stringify(selfApproved)}`);
    }
    const selfApply = await bus.execute(actor(), "subscription.trust_renew", {
      subscriptionId,
      approvedReviewId: reviewId,
    });
    expect(selfApply.ok).toBe(false);
    if (!selfApply.ok) {
      expect(selfApply.code).toBe("forbidden");
    }

    // A different human approves → bounded extension applies once.
    const { subscriptionId: subscriptionId2 } = await activeSubscriptionFixture();
    await moveCycleEnd(subscriptionId2, 2);
    const cycle2 = await openCycle(subscriptionId2);
    const review2 = await bus.execute<{ id: string }>(actor(), "human_review.request", {
      resourceType: "subscription_trust_renewal",
      resourceId: (cycle2 as { id: string }).id,
      reviewMode: "APPROVAL",
      reason: "RISK_REVIEW",
      summary: "Wave9 test trust approval",
    });
    if (!review2.ok) {
      throw new Error(`human_review.request failed: ${JSON.stringify(review2)}`);
    }
    const approved = await bus.execute(approver(), "human_review.approve", {
      requestId: review2.data.id,
    });
    if (!approved.ok) {
      throw new Error(`approve failed: ${JSON.stringify(approved)}`);
    }
    const granted = await bus.execute<{
      cycleId: string;
      previousEndsAt: string;
      newEndsAt: string;
      extensionDays: number;
    }>(actor(), "subscription.trust_renew", {
      subscriptionId: subscriptionId2,
      approvedReviewId: review2.data.id,
    });
    if (!granted.ok) {
      throw new Error(`trust_renew failed: ${JSON.stringify(granted)}`);
    }
    expect(granted.data.extensionDays).toBe(3);
    const addedMs = new Date(granted.data.newEndsAt).getTime() - new Date(granted.data.previousEndsAt).getTime();
    expect(addedMs).toBe(3 * 86_400_000);

    const extended = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["ends_at"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", granted.data.cycleId)
      .executeTakeFirstOrThrow();
    expect(extended.ends_at.getTime()).toBe(new Date(granted.data.newEndsAt).getTime());

    // Second grant for the same cycle is rejected (single open grant).
    const twice = await bus.execute(actor(), "subscription.trust_renew", {
      subscriptionId: subscriptionId2,
      approvedReviewId: review2.data.id,
    });
    expect(twice.ok).toBe(false);
    if (!twice.ok) {
      expect(twice.code).toBe("precondition_failed");
    }
  });

  it("reminders are idempotent per cycle (internal record, never outbound)", async () => {
    const { subscriptionId } = await activeSubscriptionFixture();
    await moveCycleEnd(subscriptionId, 2);
    const first = await bus.execute<{ scanned: number; reminded: string[] }>(
      actor(),
      "renewal.reminders_due",
      { limit: 100 },
    );
    if (!first.ok) {
      throw new Error(`reminders_due failed: ${JSON.stringify(first)}`);
    }
    expect(first.data.reminded).toContain(subscriptionId);
    const second = await bus.execute<{ scanned: number; reminded: string[] }>(
      actor(),
      "renewal.reminders_due",
      { limit: 100 },
    );
    if (!second.ok) {
      throw new Error(`second reminders_due failed: ${JSON.stringify(second)}`);
    }
    expect(second.data.reminded).not.toContain(subscriptionId);

    const cycle = await openCycle(subscriptionId);
    const notes = await db
      .selectFrom("communication.messages")
      .select(["id", "direction", "sender_type", "body_text"])
      .where("tenant_id", "=", tenantId)
      .where(
        "idempotency_key",
        "=",
        `renewal-reminder:${subscriptionId}:${(cycle as { id: string }).id}`,
      )
      .execute();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.direction).toBe("INTERNAL");
    expect(notes[0]?.sender_type).toBe("SYSTEM");
    const deliveries = await db
      .selectFrom("communication.message_deliveries")
      .select(["status", "provider"])
      .where("tenant_id", "=", tenantId)
      .where("message_id", "=", notes[0]?.id as string)
      .execute();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("QUEUED");
    expect(deliveries[0]?.provider).toBe("manual");
  });

  it("concurrent reminders_due for the same cycle create one message without aborting", async () => {
    const { subscriptionId } = await activeSubscriptionFixture();
    await moveCycleEnd(subscriptionId, 2);
    // Two concurrent worker runs over the same due subscription: the
    // per-reminder advisory lock serializes the appends and the message
    // insert resolves conflicts via ON CONFLICT DO NOTHING, so neither run
    // fails with a transaction-aborted (23505 catch-and-continue) error and
    // no orphan SYSTEM conversation is left behind.
    const [left, right] = await Promise.all([
      bus.execute<{ scanned: number; reminded: string[] }>(actor(), "renewal.reminders_due", { limit: 100 }),
      bus.execute<{ scanned: number; reminded: string[] }>(actor(), "renewal.reminders_due", { limit: 100 }),
    ]);
    if (!left.ok) {
      throw new Error(`concurrent reminders_due (left) failed: ${JSON.stringify(left)}`);
    }
    if (!right.ok) {
      throw new Error(`concurrent reminders_due (right) failed: ${JSON.stringify(right)}`);
    }
    const remindedCount =
      (left.data.reminded.includes(subscriptionId) ? 1 : 0) +
      (right.data.reminded.includes(subscriptionId) ? 1 : 0);
    expect(remindedCount).toBe(1);

    const cycle = await openCycle(subscriptionId);
    expect(cycle).toBeDefined();
    const key = `renewal-reminder:${subscriptionId}:${(cycle as { id: string }).id}`;
    const notes = await db
      .selectFrom("communication.messages")
      .select(["id", "conversation_id", "person_id", "direction", "sender_type", "channel"])
      .where("tenant_id", "=", tenantId)
      .where("idempotency_key", "=", key)
      .execute();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.direction).toBe("INTERNAL");
    expect(notes[0]?.sender_type).toBe("SYSTEM");
    const messageId = notes[0]?.id as string;
    const conversationId = notes[0]?.conversation_id as string;
    const personId = notes[0]?.person_id as string;

    // Fixture context: provider activation appends one credential SYSTEM
    // message (idempotency key `subscription-credentials:{subscriptionId}`)
    // into the same conversation, so it must not be counted as a duplicate
    // reminder — it is asserted independently below.
    const credentials = await db
      .selectFrom("communication.messages")
      .select(["id", "conversation_id", "person_id", "direction", "sender_type"])
      .where("tenant_id", "=", tenantId)
      .where("idempotency_key", "=", `subscription-credentials:${subscriptionId}`)
      .execute();
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.direction).toBe("INTERNAL");
    expect(credentials[0]?.sender_type).toBe("SYSTEM");
    expect(credentials[0]?.conversation_id).toBe(conversationId);
    expect(credentials[0]?.person_id).toBe(personId);
    const credentialId = credentials[0]?.id as string;
    expect(credentialId).not.toBe(messageId);

    const history = await db
      .selectFrom("communication.messages")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("conversation_id", "=", conversationId)
      .execute();
    expect(history).toHaveLength(2);
    expect(history.map((m) => m.id).sort()).toEqual([credentialId, messageId].sort());
    const conversations = await db
      .selectFrom("communication.conversations")
      .select(["id", "channel", "person_id"])
      .where("tenant_id", "=", tenantId)
      .where("person_id", "=", personId)
      .execute();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.id).toBe(conversationId);
    expect(conversations[0]?.channel).toBe("SYSTEM");

    const deliveries = await db
      .selectFrom("communication.message_deliveries")
      .select(["status", "provider"])
      .where("tenant_id", "=", tenantId)
      .where("message_id", "=", messageId)
      .execute();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("QUEUED");
    expect(deliveries[0]?.provider).toBe("manual");
  });

  it("F13: settled renewal order suppresses the reminder before subscription.renew runs", async () => {
    const { subscriptionId } = await activeSubscriptionFixture();
    await moveCycleEnd(subscriptionId, 2);
    const quote = await bus.execute<{
      orderId: string;
      status: string;
      already: boolean;
    }>(actor(), "renewal.quote", { subscriptionId });
    if (!quote.ok) {
      throw new Error(`renewal.quote failed: ${JSON.stringify(quote)}`);
    }
    const renewalOrderId = quote.data.orderId;
    await settleOrder(renewalOrderId);

    // Deliberately do NOT call `subscription.renew`: the prior cycle stays
    // OPEN and still carries the settled link.
    const cycle = await openCycle(subscriptionId);
    expect(cycle).toBeDefined();
    expect((cycle as { renewal_order_id: string | null }).renewal_order_id).toBe(renewalOrderId);

    const result = await bus.execute<{ scanned: number; reminded: string[] }>(
      actor(),
      "renewal.reminders_due",
      { limit: 100 },
    );
    if (!result.ok) {
      throw new Error(`reminders_due failed: ${JSON.stringify(result)}`);
    }
    expect(result.data.reminded).not.toContain(subscriptionId);

    const notes = await db
      .selectFrom("communication.messages")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where(
        "idempotency_key",
        "=",
        `renewal-reminder:${subscriptionId}:${(cycle as { id: string }).id}`,
      )
      .execute();
    expect(notes).toHaveLength(0);
  });

  it("next-cycle continuity: after subscription.renew the new cycle quotes and reminds", async () => {
    const { subscriptionId } = await activeSubscriptionFixture();
    await moveCycleEnd(subscriptionId, 2);
    const first = await bus.execute<{ orderId: string; already: boolean }>(actor(), "renewal.quote", {
      subscriptionId,
    });
    if (!first.ok) {
      throw new Error(`first quote failed: ${JSON.stringify(first)}`);
    }
    const firstOrderId = first.data.orderId;
    await settleOrder(firstOrderId);
    const renewed = await bus.execute<{ cycleId: string; already: boolean }>(actor(), "subscription.renew", {
      orderId: firstOrderId,
    });
    if (!renewed.ok) {
      throw new Error(`subscription.renew failed: ${JSON.stringify(renewed)}`);
    }
    // New cycle opens unlinked; the prior cycle retains the settled pointer.
    const afterRenew = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["id", "cycle_no", "renewal_order_id"])
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", subscriptionId)
      .orderBy("cycle_no", "asc")
      .execute();
    expect(afterRenew).toHaveLength(2);
    expect(afterRenew[0]?.renewal_order_id).toBe(firstOrderId);
    expect(afterRenew[1]?.renewal_order_id).toBeNull();

    // Replay stays idempotent via the sequential chain (no duplicate link).
    const replay = await bus.execute<{ cycleId: string; already: boolean }>(actor(), "subscription.renew", {
      orderId: firstOrderId,
    });
    if (!replay.ok) {
      throw new Error(`renew replay failed: ${JSON.stringify(replay)}`);
    }
    expect(replay.data.cycleId).toBe(renewed.data.cycleId);
    expect(replay.data.already).toBe(true);

    // Move the NEW cycle into the reminder window: its next quote succeeds
    // and the AWAITING_PAYMENT renewal stays reminder-eligible.
    await moveCycleEnd(subscriptionId, 2);
    const second = await bus.execute<{ orderId: string; status: string; already: boolean }>(
      actor(),
      "renewal.quote",
      { subscriptionId },
    );
    if (!second.ok) {
      throw new Error(`second-cycle quote failed: ${JSON.stringify(second)}`);
    }
    expect(second.data.already).toBe(false);
    expect(second.data.status).toBe("AWAITING_PAYMENT");
    expect(second.data.orderId).not.toBe(firstOrderId);

    const reminders = await bus.execute<{ scanned: number; reminded: string[] }>(
      actor(),
      "renewal.reminders_due",
      { limit: 100 },
    );
    if (!reminders.ok) {
      throw new Error(`reminders_due failed: ${JSON.stringify(reminders)}`);
    }
    expect(reminders.data.reminded).toContain(subscriptionId);
  });

  it("legacy duplicate: open-cycle copy of the settled order does not block the next quote/reminder", async () => {
    const { subscriptionId } = await activeSubscriptionFixture();
    await moveCycleEnd(subscriptionId, 2);
    const first = await bus.execute<{ orderId: string }>(actor(), "renewal.quote", { subscriptionId });
    if (!first.ok) {
      throw new Error(`first quote failed: ${JSON.stringify(first)}`);
    }
    const firstOrderId = first.data.orderId;
    await settleOrder(firstOrderId);
    const renewed = await bus.execute<{ cycleId: string }>(actor(), "subscription.renew", {
      orderId: firstOrderId,
    });
    if (!renewed.ok) {
      throw new Error(`subscription.renew failed: ${JSON.stringify(renewed)}`);
    }
    // Simulate a row written by the old behavior: the same settled order
    // pointer copied onto the newly opened cycle.
    const open = await openCycle(subscriptionId);
    expect(open).toBeDefined();
    await db
      .updateTable("subscription.subscription_cycles")
      .set({ renewal_order_id: firstOrderId })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", (open as { id: string }).id)
      .execute();

    await moveCycleEnd(subscriptionId, 2);
    // The duplicated historical pointer must not suppress the next-cycle
    // reminder.
    const reminders = await bus.execute<{ scanned: number; reminded: string[] }>(
      actor(),
      "renewal.reminders_due",
      { limit: 100 },
    );
    if (!reminders.ok) {
      throw new Error(`reminders_due failed: ${JSON.stringify(reminders)}`);
    }
    expect(reminders.data.reminded).toContain(subscriptionId);

    // Quoting clears the stale open-cycle pointer and mints a fresh order.
    const second = await bus.execute<{ orderId: string; already: boolean }>(actor(), "renewal.quote", {
      subscriptionId,
    });
    if (!second.ok) {
      throw new Error(`legacy-duplicate quote failed: ${JSON.stringify(second)}`);
    }
    expect(second.data.already).toBe(false);
    expect(second.data.orderId).not.toBe(firstOrderId);
    const reopened = await openCycle(subscriptionId);
    expect((reopened as { renewal_order_id: string | null }).renewal_order_id).toBe(second.data.orderId);
    // The prior cycle still carries the historical settled link.
    const prior = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["renewal_order_id"])
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", subscriptionId)
      .where("cycle_no", "=", 1)
      .executeTakeFirst();
    expect(prior?.renewal_order_id).toBe(firstOrderId);
  });

  it("settled order appends CANCELLED to a previously queued reminder (append-only, visible via GET)", async () => {
    const { subscriptionId } = await activeSubscriptionFixture();
    await moveCycleEnd(subscriptionId, 2);
    const first = await bus.execute<{ scanned: number; reminded: string[] }>(
      actor(),
      "renewal.reminders_due",
      { limit: 100 },
    );
    if (!first.ok) {
      throw new Error(`first reminders_due failed: ${JSON.stringify(first)}`);
    }
    expect(first.data.reminded).toContain(subscriptionId);

    const cycle = await openCycle(subscriptionId);
    expect(cycle).toBeDefined();
    const cycleId = (cycle as { id: string }).id;
    const key = `renewal-reminder:${subscriptionId}:${cycleId}`;
    const before = await db
      .selectFrom("communication.messages")
      .select(["id", "conversation_id"])
      .where("tenant_id", "=", tenantId)
      .where("idempotency_key", "=", key)
      .executeTakeFirstOrThrow();
    const conversationId = before.conversation_id;
    const messageId = before.id;

    // Settle the renewal order AFTER the reminder was queued, then run the
    // due worker again without calling `subscription.renew`.
    const quote = await bus.execute<{ orderId: string }>(actor(), "renewal.quote", { subscriptionId });
    if (!quote.ok) {
      throw new Error(`renewal.quote failed: ${JSON.stringify(quote)}`);
    }
    await settleOrder(quote.data.orderId);

    const second = await bus.execute<{ scanned: number; reminded: string[] }>(
      actor(),
      "renewal.reminders_due",
      { limit: 100 },
    );
    if (!second.ok) {
      throw new Error(`second reminders_due failed: ${JSON.stringify(second)}`);
    }
    expect(second.data.reminded).not.toContain(subscriptionId);

    // No new message: the same record carries the full attempt history.
    const notes = await db
      .selectFrom("communication.messages")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("idempotency_key", "=", key)
      .execute();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.id).toBe(messageId);

    const deliveries = await db
      .selectFrom("communication.message_deliveries")
      .select(["status", "provider", "attempt_no", "error_code"])
      .where("tenant_id", "=", tenantId)
      .where("message_id", "=", messageId)
      .orderBy("attempt_no", "asc")
      .execute();
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]?.status).toBe("QUEUED");
    expect(deliveries[0]?.attempt_no).toBe(1);
    expect(deliveries[1]?.status).toBe("CANCELLED");
    expect(deliveries[1]?.attempt_no).toBe(2);
    expect(deliveries[1]?.provider).toBe("manual");
    expect(deliveries[1]?.error_code).toBe("RENEWAL_ORDER_SETTLED");

    // A third run is a no-op: the latest attempt is no longer QUEUED.
    const third = await bus.execute<{ scanned: number; reminded: string[] }>(
      actor(),
      "renewal.reminders_due",
      { limit: 100 },
    );
    if (!third.ok) {
      throw new Error(`third reminders_due failed: ${JSON.stringify(third)}`);
    }
    expect(third.data.reminded).not.toContain(subscriptionId);
    const again = await db
      .selectFrom("communication.message_deliveries")
      .select(["status", "attempt_no"])
      .where("tenant_id", "=", tenantId)
      .where("message_id", "=", messageId)
      .orderBy("attempt_no", "asc")
      .execute();
    expect(again).toHaveLength(2);

    // The latest cancellation is visible through the tenant-scoped GET
    // message list as `deliveryStatus`.
    const listed = await injectRaw({
      method: "GET",
      url: `/v1/communications/conversations/${conversationId}/messages`,
      token,
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json<{ messages: Array<{ id: string; deliveryStatus: string | null }> }>();
    const found = body.messages.find((m) => m.id === messageId);
    expect(found?.deliveryStatus).toBe("CANCELLED");
  });

  it("stale cancellation scan skips already-cancelled head rows within a small limit", async () => {
    // Older subscription: queue a reminder, settle, and let the worker
    // append CANCELLED — its message stays at the scan head forever
    // (append-only, ordered by occurred_at asc).
    const older = await activeSubscriptionFixture();
    await moveCycleEnd(older.subscriptionId, 2);
    const olderFirst = await bus.execute<{ scanned: number; reminded: string[] }>(
      actor(),
      "renewal.reminders_due",
      { limit: 100 },
    );
    if (!olderFirst.ok) {
      throw new Error(`older reminders_due failed: ${JSON.stringify(olderFirst)}`);
    }
    expect(olderFirst.data.reminded).toContain(older.subscriptionId);
    const olderCycle = await openCycle(older.subscriptionId);
    expect(olderCycle).toBeDefined();
    const olderKey = `renewal-reminder:${older.subscriptionId}:${(olderCycle as { id: string }).id}`;
    const olderQuote = await bus.execute<{ orderId: string }>(actor(), "renewal.quote", {
      subscriptionId: older.subscriptionId,
    });
    if (!olderQuote.ok) {
      throw new Error(`older quote failed: ${JSON.stringify(olderQuote)}`);
    }
    await settleOrder(olderQuote.data.orderId);
    const olderCancel = await bus.execute<{ scanned: number; reminded: string[] }>(
      actor(),
      "renewal.reminders_due",
      { limit: 100 },
    );
    if (!olderCancel.ok) {
      throw new Error(`older cancel run failed: ${JSON.stringify(olderCancel)}`);
    }
    const olderMessage = await db
      .selectFrom("communication.messages")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("idempotency_key", "=", olderKey)
      .executeTakeFirstOrThrow();
    const olderDeliveries = await db
      .selectFrom("communication.message_deliveries")
      .select(["status", "attempt_no"])
      .where("tenant_id", "=", tenantId)
      .where("message_id", "=", olderMessage.id)
      .orderBy("attempt_no", "asc")
      .execute();
    expect(olderDeliveries).toHaveLength(2);
    expect(olderDeliveries[1]?.status).toBe("CANCELLED");

    // Later subscription: queue a reminder, then settle — but do NOT run the
    // worker yet, so its latest delivery stays QUEUED behind the older
    // already-cancelled head row.
    const later = await activeSubscriptionFixture();
    await moveCycleEnd(later.subscriptionId, 2);
    const laterFirst = await bus.execute<{ scanned: number; reminded: string[] }>(
      actor(),
      "renewal.reminders_due",
      { limit: 100 },
    );
    if (!laterFirst.ok) {
      throw new Error(`later reminders_due failed: ${JSON.stringify(laterFirst)}`);
    }
    expect(laterFirst.data.reminded).toContain(later.subscriptionId);
    const laterCycle = await openCycle(later.subscriptionId);
    expect(laterCycle).toBeDefined();
    const laterKey = `renewal-reminder:${later.subscriptionId}:${(laterCycle as { id: string }).id}`;
    const laterQuote = await bus.execute<{ orderId: string }>(actor(), "renewal.quote", {
      subscriptionId: later.subscriptionId,
    });
    if (!laterQuote.ok) {
      throw new Error(`later quote failed: ${JSON.stringify(laterQuote)}`);
    }
    await settleOrder(laterQuote.data.orderId);
    const laterMessage = await db
      .selectFrom("communication.messages")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("idempotency_key", "=", laterKey)
      .executeTakeFirstOrThrow();
    const laterBefore = await db
      .selectFrom("communication.message_deliveries")
      .select(["status", "attempt_no"])
      .where("tenant_id", "=", tenantId)
      .where("message_id", "=", laterMessage.id)
      .orderBy("attempt_no", "asc")
      .execute();
    expect(laterBefore).toHaveLength(1);
    expect(laterBefore[0]?.status).toBe("QUEUED");

    // A small-limit run must still reach the later stale reminder: the scan
    // filters to genuinely stale QUEUED candidates BEFORE applying LIMIT,
    // so the already-cancelled older head row cannot starve it.
    const small = await bus.execute<{ scanned: number; reminded: string[] }>(
      actor(),
      "renewal.reminders_due",
      { limit: 1 },
    );
    if (!small.ok) {
      throw new Error(`small-limit reminders_due failed: ${JSON.stringify(small)}`);
    }
    expect(small.data.reminded).not.toContain(later.subscriptionId);
    const laterAfter = await db
      .selectFrom("communication.message_deliveries")
      .select(["status", "provider", "attempt_no", "error_code"])
      .where("tenant_id", "=", tenantId)
      .where("message_id", "=", laterMessage.id)
      .orderBy("attempt_no", "asc")
      .execute();
    expect(laterAfter).toHaveLength(2);
    expect(laterAfter[0]?.status).toBe("QUEUED");
    expect(laterAfter[1]?.status).toBe("CANCELLED");
    expect(laterAfter[1]?.attempt_no).toBe(2);
    expect(laterAfter[1]?.provider).toBe("manual");
    expect(laterAfter[1]?.error_code).toBe("RENEWAL_ORDER_SETTLED");

    // The older head row stays untouched (no duplicate CANCELLED append).
    const olderAgain = await db
      .selectFrom("communication.message_deliveries")
      .select(["status", "attempt_no"])
      .where("tenant_id", "=", tenantId)
      .where("message_id", "=", olderMessage.id)
      .orderBy("attempt_no", "asc")
      .execute();
    expect(olderAgain).toHaveLength(2);
  });

  it("overdue expiry filters genuine settled rows before LIMIT (no starvation)", async () => {
    // Pin the default no-suspension policy so this test stays
    // order-independent of the suspension test below.
    const suspensionPolicy = await bus.execute(actor(), "policy.publish", {
      family: "subscription.suspension",
      scope: "TENANT",
      class: "TENANT_POLICY",
      document: { allow: false },
    });
    if (!suspensionPolicy.ok) {
      throw new Error(`policy.publish failed: ${JSON.stringify(suspensionPolicy)}`);
    }
    // Older paid candidate: genuinely settled renewal order on the
    // still-current (overdue) cycle — no earlier cycle carries it.
    const { subscriptionId: paidSubscriptionId } = await activeSubscriptionFixture();
    await moveCycleEnd(paidSubscriptionId, 2);
    const paidQuote = await bus.execute<{ orderId: string }>(actor(), "renewal.quote", {
      subscriptionId: paidSubscriptionId,
    });
    if (!paidQuote.ok) {
      throw new Error(`paid quote failed: ${JSON.stringify(paidQuote)}`);
    }
    await settleOrder(paidQuote.data.orderId);
    // Later unpaid candidate: no renewal order at all.
    const { subscriptionId: unpaidSubscriptionId } = await activeSubscriptionFixture();
    // Order matters: the paid row ends EARLIER, so a LIMIT applied before
    // the settled filter would return only the paid row and starve the
    // unpaid one.
    await moveCycleEnd(paidSubscriptionId, -10);
    await moveCycleEnd(unpaidSubscriptionId, -9);

    const result = await bus.execute<{ expired: string[]; suspended: string[]; recoveryTasks: string[] }>(
      actor(),
      "renewal.expire_overdue_due",
      { limit: 1 },
    );
    if (!result.ok) {
      throw new Error(`expire_overdue_due failed: ${JSON.stringify(result)}`);
    }
    expect(result.data.expired).toContain(unpaidSubscriptionId);
    expect(result.data.expired).not.toContain(paidSubscriptionId);

    const unpaid = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", unpaidSubscriptionId)
      .executeTakeFirstOrThrow();
    expect(unpaid.status).toBe("ENDED");

    const paid = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", paidSubscriptionId)
      .executeTakeFirstOrThrow();
    expect(paid.status).toBe("ACTIVE");
  });

  it("overdue expiry ignores a legacy duplicate pointer on the newly opened cycle", async () => {
    // Restore the default no-suspension policy: the suspension test below
    // publishes `{ allow: true }` at TENANT scope, so this test pins the
    // default explicitly and stays order-independent.
    const suspensionPolicy = await bus.execute(actor(), "policy.publish", {
      family: "subscription.suspension",
      scope: "TENANT",
      class: "TENANT_POLICY",
      document: { allow: false },
    });
    if (!suspensionPolicy.ok) {
      throw new Error(`policy.publish failed: ${JSON.stringify(suspensionPolicy)}`);
    }
    // Legacy-duplicate subscription: quote → settle → renew, then simulate
    // the old behavior by copying the settled order pointer onto the newly
    // opened cycle. That open cycle's end is overdue.
    const { subscriptionId } = await activeSubscriptionFixture();
    await moveCycleEnd(subscriptionId, 2);
    const first = await bus.execute<{ orderId: string }>(actor(), "renewal.quote", { subscriptionId });
    if (!first.ok) {
      throw new Error(`first quote failed: ${JSON.stringify(first)}`);
    }
    const firstOrderId = first.data.orderId;
    await settleOrder(firstOrderId);
    const renewed = await bus.execute(actor(), "subscription.renew", { orderId: firstOrderId });
    if (!renewed.ok) {
      throw new Error(`subscription.renew failed: ${JSON.stringify(renewed)}`);
    }
    const duplicateOpen = await openCycle(subscriptionId);
    expect(duplicateOpen).toBeDefined();
    await db
      .updateTable("subscription.subscription_cycles")
      .set({ renewal_order_id: firstOrderId })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", (duplicateOpen as { id: string }).id)
      .execute();
    await moveCycleEnd(subscriptionId, -10);

    // Control subscription: a genuinely settled renewal order on the
    // still-current (overdue) cycle — no earlier cycle carries it, so expiry
    // must stay suppressed and `subscription.renew` keeps owning it.
    const { subscriptionId: paidSubscriptionId } = await activeSubscriptionFixture();
    await moveCycleEnd(paidSubscriptionId, 2);
    const paidQuote = await bus.execute<{ orderId: string }>(actor(), "renewal.quote", {
      subscriptionId: paidSubscriptionId,
    });
    if (!paidQuote.ok) {
      throw new Error(`paid quote failed: ${JSON.stringify(paidQuote)}`);
    }
    await settleOrder(paidQuote.data.orderId);
    await moveCycleEnd(paidSubscriptionId, -10);

    const result = await bus.execute<{ expired: string[]; suspended: string[]; recoveryTasks: string[] }>(
      actor(),
      "renewal.expire_overdue_due",
      { limit: 100 },
    );
    if (!result.ok) {
      throw new Error(`expire_overdue_due failed: ${JSON.stringify(result)}`);
    }
    // The stale duplicate must not suppress expiry; the genuine paid link must.
    expect(result.data.expired).toContain(subscriptionId);
    expect(result.data.expired).not.toContain(paidSubscriptionId);
    expect(result.data.suspended).toHaveLength(0);

    const sub = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .executeTakeFirstOrThrow();
    expect(sub.status).toBe("ENDED");

    const paidSub = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", paidSubscriptionId)
      .executeTakeFirstOrThrow();
    expect(paidSub.status).toBe("ACTIVE");

    // The recovery task for the duplicate cycle carries no stale renewal
    // order link (the historical pointer belongs to the earlier cycle).
    const tasks = await db
      .selectFrom("renewal.recovery_tasks")
      .select(["id", "reason", "status", "renewal_order_id"])
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", subscriptionId)
      .orderBy("created_at", "desc")
      .execute();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.reason).toBe("OVERDUE_NO_RENEWAL");
    expect(tasks[0]?.status).toBe("OPEN");
    expect(tasks[0]?.renewal_order_id).toBeNull();
  });

  it("overdue expiry ends at cycle end by default + opens a recovery task", async () => {
    const { subscriptionId } = await activeSubscriptionFixture();
    await moveCycleEnd(subscriptionId, -10);
    const result = await bus.execute<{ expired: string[]; suspended: string[]; recoveryTasks: string[] }>(
      actor(),
      "renewal.expire_overdue_due",
      { limit: 100 },
    );
    if (!result.ok) {
      throw new Error(`expire_overdue_due failed: ${JSON.stringify(result)}`);
    }
    expect(result.data.expired).toContain(subscriptionId);
    expect(result.data.suspended).toHaveLength(0);
    expect(result.data.recoveryTasks).toHaveLength(1);

    const sub = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .executeTakeFirstOrThrow();
    expect(sub.status).toBe("ENDED");

    const tasks = await injectRaw({
      method: "GET",
      url: `/v1/recovery-tasks?subscriptionId=${subscriptionId}`,
      token,
    });
    expect(tasks.statusCode).toBe(200);
    const listed = tasks.json<{ tasks: Array<{ id: string; status: string; reason: string }> }>().tasks;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("OPEN");
    expect(listed[0]?.reason).toBe("OVERDUE_NO_RENEWAL");

    const resolved = await bus.execute<{ status: string; outcome: string }>(actor(), "recovery.resolve", {
      taskId: result.data.recoveryTasks[0],
      outcome: "WON_BACK",
    });
    if (!resolved.ok) {
      throw new Error(`recovery.resolve failed: ${JSON.stringify(resolved)}`);
    }
    expect(resolved.data.status).toBe("RESOLVED");
    expect(resolved.data.outcome).toBe("WON_BACK");

    const resolvedAgain = await bus.execute(actor(), "recovery.resolve", {
      taskId: result.data.recoveryTasks[0],
      outcome: "LOST",
    });
    expect(resolvedAgain.ok).toBe(false);
  });

  it("overdue expiry suspends only under an explicit suspension policy", async () => {
    const published = await bus.execute(actor(), "policy.publish", {
      family: "subscription.suspension",
      scope: "TENANT",
      class: "TENANT_POLICY",
      document: { allow: true },
    });
    if (!published.ok) {
      throw new Error(`policy.publish failed: ${JSON.stringify(published)}`);
    }
    const { subscriptionId } = await activeSubscriptionFixture();
    await moveCycleEnd(subscriptionId, -10);
    const result = await bus.execute<{ expired: string[]; suspended: string[]; recoveryTasks: string[] }>(
      actor(),
      "renewal.expire_overdue_due",
      { limit: 100 },
    );
    if (!result.ok) {
      throw new Error(`expire_overdue_due failed: ${JSON.stringify(result)}`);
    }
    // Earlier ENDED rows are skipped (no longer ACTIVE); only this one suspends.
    expect(result.data.suspended).toContain(subscriptionId);
    expect(result.data.expired).not.toContain(subscriptionId);
    const sub = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .executeTakeFirstOrThrow();
    expect(sub.status).toBe("SUSPENDED");
  });

  it("cancel_at_period_end rows belong to the Wave 6 worker, never the overdue one", async () => {
    const { subscriptionId } = await activeSubscriptionFixture();
    await bus.execute(actor(), "subscription.cancel_at_period_end", { subscriptionId });
    await moveCycleEnd(subscriptionId, -10);
    const result = await bus.execute<{ expired: string[]; suspended: string[]; recoveryTasks: string[] }>(
      actor(),
      "renewal.expire_overdue_due",
      { limit: 100 },
    );
    if (!result.ok) {
      throw new Error(`expire_overdue_due failed: ${JSON.stringify(result)}`);
    }
    expect(result.data.expired).not.toContain(subscriptionId);
    const still = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .executeTakeFirstOrThrow();
    expect(still.status).toBe("ACTIVE");
    // The Wave 6 seam still ends it (no regression).
    const wave6 = await bus.execute<{ expired: string[]; ended: string[] }>(
      actor(),
      "subscription.expire_cycles_due",
      { limit: 100 },
    );
    if (!wave6.ok) {
      throw new Error(`wave6 expire failed: ${JSON.stringify(wave6)}`);
    }
    expect(wave6.data.ended).toContain(subscriptionId);
  });

  it("tenant isolation: another tenant sees neither renewals nor recovery tasks", async () => {
    const { subscriptionId } = await activeSubscriptionFixture();
    const other = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w9other"), password: "correct-horse-8", tenantName: "Wave9 Other" },
    });
    expect(other.statusCode).toBe(201);
    const otherBody = other.json<{ token: string }>();
    const renewals = await injectRaw({
      method: "GET",
      url: `/v1/renewals?subscriptionId=${subscriptionId}`,
      token: otherBody.token,
    });
    expect(renewals.statusCode).toBe(404);
    const tasks = await injectRaw({ method: "GET", url: "/v1/recovery-tasks", token: otherBody.token });
    expect(tasks.statusCode).toBe(200);
    expect(tasks.json<{ tasks: unknown[] }>().tasks).toHaveLength(0);
  });
});
