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
  "subscription.read",
  "subscription.write",
];

const ASAAS_SECRET = "wave10-test-asaas-secret";

/**
 * Wave 10 Finance/Unit-Economics (requires TEST_DATABASE_URL).
 *
 * Real settled-money flow (quote → submit → charge → Asaas webhook →
 * SETTLED) feeds the idempotent cost-allocation ingest and the four
 * read-models. Asserts: 1:1 settlement→allocation with replay safety,
 * contribution math, CAC touch vs BASELINE_UNAVAILABLE, monthly cohorts,
 * overview aggregates, and tenant isolation.
 */
describe.skipIf(!hasDb)("Wave 10 Finance/Unit-Economics (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let tokenA = "";
  let tenantA = "";
  let userA = "";
  let bus: CommandBus;
  let drainer: OutboxDrainer;

  let tokenB = "";
  let tenantB = "";

  let personP1 = "";
  let customerC1 = "";
  let orderP1 = "";
  let planMonthly = "";

  let customerC2 = "";

  function actor(): CommandActor {
    return {
      userId: userA,
      isPlatformAdmin: false,
      tenantId: tenantA,
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
      canonicalName: "Wave10 Person",
    });
    if (!result.ok) {
      throw new Error(`person.register failed: ${result.message}`);
    }
    return result.data.id;
  }

  async function seedPlan(priceMinor: string): Promise<string> {
    const suffix = newId().replace(/-/g, "").slice(-12);
    const productId = newId();
    await db
      .insertInto("catalog.products")
      .values({
        id: productId,
        tenant_id: tenantA,
        product_key: `svc-${suffix}`,
        name: "Wave10 Service",
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
        tenant_id: tenantA,
        product_id: productId,
        plan_key: `monthly-${suffix}`,
        name: "Wave10 Monthly",
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
        tenant_id: tenantA,
        sellable_type: "PLAN",
        sellable_id: planId,
        amount_minor: priceMinor,
        currency: "BRL",
        starts_at: new Date(Date.now() - 60_000),
        ends_at: null,
        segment_key: null,
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
      })
      .execute();
    return planId;
  }

  async function quoteAndSubmit(personId: string, planId: string, quantity: number): Promise<{ orderId: string; net: string }> {
    const quoted = await bus.execute<{ id: string; netAmountMinor: string }>(actor(), "offer.quote", {
      personId,
      items: [{ sellableType: "PLAN", sellableId: planId, quantity }],
      orderType: "NEW_SUBSCRIPTION",
    });
    if (!quoted.ok) {
      throw new Error(`offer.quote failed: ${JSON.stringify(quoted)}`);
    }
    const submitted = await bus.execute(actor(), "order.submit", { orderId: quoted.data.id });
    if (!submitted.ok) {
      throw new Error(`order.submit failed: ${JSON.stringify(submitted)}`);
    }
    return { orderId: quoted.data.id, net: quoted.data.netAmountMinor };
  }

  async function settleOrder(orderId: string, netMinor: string): Promise<void> {
    const tenantKey = `asaas-${newId().replace(/-/g, "").slice(-12)}`;
    await db
      .insertInto("billing.tenant_channels")
      .values({
        id: newId(),
        tenant_id: tenantA,
        channel: "ASAAS",
        tenant_key: tenantKey,
        webhook_secret_hash: sha256Hex(ASAAS_SECRET),
        status: "ACTIVE",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const created = await bus.execute<{ id: string; status: string; providerChargeId: string | null }>(
      actor(),
      "charge.create",
      { orderId },
    );
    if (!created.ok || created.data.providerChargeId === null) {
      throw new Error(`charge.create failed: ${JSON.stringify(created)}`);
    }
    const realUnits = Number(netMinor) / 100;
    const delivered = await injectRaw({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}`,
      headers: { "asaas-access-token": ASAAS_SECRET },
      payload: {
        event: "PAYMENT_RECEIVED",
        id: `evt-w10-${newId().slice(-12)}`,
        payment: { id: created.data.providerChargeId, value: realUnits, currency: "BRL" },
      },
    });
    expect(delivered.statusCode).toBe(202);
    const order = await db
      .selectFrom("commerce.orders")
      .select(["status"])
      .where("tenant_id", "=", tenantA)
      .where("id", "=", orderId)
      .executeTakeFirstOrThrow();
    expect(order.status).toBe("SETTLED");
  }

  async function customerForPerson(personId: string): Promise<string> {
    const row = await db
      .selectFrom("crm.customers")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .where("person_id", "=", personId)
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function allocationCount(costType?: string): Promise<number> {
    let query = db
      .selectFrom("finance.cost_allocations")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("tenant_id", "=", tenantA);
    if (costType !== undefined) {
      query = query.where("cost_type", "=", costType);
    }
    const row = await query.executeTakeFirstOrThrow();
    return Number(row.n);
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    delete process.env["ASAAS_ADAPTER"];
    delete process.env["ASAAS_ECHO_CREATE"];
    delete process.env["ASAAS_ECHO_RECONCILE"];
    delete process.env["ASAAS_ECHO_REFUND"];
    delete process.env["ASAAS_ECHO_REFUND_RECONCILE"];
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);
    drainer = app.get(OutboxDrainer);

    const registerA = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w10a"), password: "correct-horse-8", tenantName: "Wave10 Tenant A" },
    });
    expect(registerA.statusCode).toBe(201);
    const bodyA = registerA.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    tokenA = bodyA.token;
    tenantA = bodyA.activeTenantId;
    userA = bodyA.user.id;

    const registerB = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w10b"), password: "correct-horse-8", tenantName: "Wave10 Tenant B" },
    });
    expect(registerB.statusCode).toBe(201);
    const bodyB = registerB.json<{ token: string; activeTenantId: string }>();
    tokenB = bodyB.token;
    tenantB = bodyB.activeTenantId;
    expect(tenantB).not.toBe(tenantA);

    planMonthly = await seedPlan("3000");
    personP1 = await makePerson();
    const first = await quoteAndSubmit(personP1, planMonthly, 2);
    expect(first.net).toBe("6000");
    orderP1 = first.orderId;
    await settleOrder(orderP1, "6000");
    customerC1 = await customerForPerson(personP1);
  });

  afterAll(async () => {
    delete process.env["ASAAS_ECHO_CREATE"];
    delete process.env["ASAAS_ECHO_RECONCILE"];
    delete process.env["ASAAS_ECHO_REFUND"];
    delete process.env["ASAAS_ECHO_REFUND_RECONCILE"];
    // FASE5-S6-FIX2: bounded hygiene drain — `drain(limit)` takes a row
    // COUNT, not a time budget, and publishes serially, so an unbounded
    // teardown drain overruns the hook timeout. Capped at ~6s wall-clock
    // so budget-capped oldest-first drains (scheduler tick, loop-drains)
    // keep converging on the shared table. No assertion observes drained
    // delivery; outbox assertions are tenant-scoped.
    if (hasDb && drainer !== undefined) {
      const drainBudgetUntil = Date.now() + 6000;
      for (;;) {
        if (Date.now() >= drainBudgetUntil) break;
        const drained = await drainer.drain(50).catch(() => undefined);
        if (drained === undefined || drained.claimed === 0) break;
      }
    }
    await app?.close().catch(() => undefined);
    await (db as unknown as { destroy: () => Promise<void> }).destroy?.().catch(() => undefined);
  });

  it("settlement derives a 1:1 supplier allocation; replay never duplicates", async () => {
    // Supplier cost fact: snapshots ship NULL from commands, so the test
    // authors the fact directly (ingest derives, never invents).
    const items = await db
      .selectFrom("commerce.order_items")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .where("order_id", "=", orderP1)
      .execute();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      await db
        .updateTable("commerce.price_snapshots")
        .set({ supplier_cost_minor: "800" })
        .where("tenant_id", "=", tenantA)
        .where("order_item_id", "=", item.id)
        .execute();
    }

    const first = await injectRaw({ method: "POST", url: "/v1/finance/recompute", token: tokenA, payload: {} });
    expect(first.statusCode).toBe(201);
    const counts = first.json<{ inserted: number; skipped: number; byCostType: Record<string, { inserted: number; skipped: number }> }>();
    expect(counts.byCostType["SUPPLIER_COGS"]?.inserted).toBe(1);
    expect(await allocationCount("SUPPLIER_COGS")).toBe(1);

    const replay = await injectRaw({ method: "POST", url: "/v1/finance/recompute", token: tokenA, payload: {} });
    expect(replay.statusCode).toBe(201);
    const replayCounts = replay.json<{ inserted: number }>();
    expect(replayCounts.inserted).toBe(0);
    expect(await allocationCount("SUPPLIER_COGS")).toBe(1);

    // Ledger untouched by ingest: still exactly confirmation + settlement.
    const txs = await db
      .selectFrom("finance.financial_transactions")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .execute();
    expect(txs.length).toBe(2);
  });

  it("contribution deducts COGS, acquisition and cycles from settled revenue", async () => {
    // Campaign touch (unit cost 250) attributed to P1.
    const created = await injectRaw({ method: "POST", url: "/v1/campaigns", token: tokenA, payload: { name: "W10 acq" } });
    expect(created.statusCode).toBe(201);
    const campaignId = created.json<{ id: string }>().id;
    const published = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/versions`,
      token: tokenA,
      payload: { offerSnapshot: {}, policySnapshot: {}, budgetCapMinor: "10000", unitCostMinor: "250" },
    });
    expect(published.statusCode).toBe(201);
    const audience = await injectRaw({
      method: "POST",
      url: "/v1/audiences",
      token: tokenA,
      payload: { campaignId, name: "W10 audience", membershipType: "STATIC", criteriaJson: {}, memberPersonIds: [personP1] },
    });
    expect(audience.statusCode).toBe(201);
    const creative = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/creatives`,
      token: tokenA,
      payload: { channel: "WHATSAPP", name: "W10 creative", content: { text: "Olá!" } },
    });
    expect(creative.statusCode).toBe(201);
    const activated = await injectRaw({ method: "POST", url: `/v1/campaigns/${campaignId}/activate`, token: tokenA });
    expect(activated.statusCode).toBe(201);
    const touch = await injectRaw({
      method: "POST",
      url: "/v1/attribution/touches",
      token: tokenA,
      payload: { personId: personP1, campaignId, touchType: "CLICK" },
    });
    expect(touch.statusCode).toBe(201);

    // Active subscription + cycle with provider cost for C1.
    // Cycle starts at "now" (not now-1d): PROVIDER_COGS occurred_at =
    // cycle.starts_at and the overview sums occurred_at >= monthStart, so a
    // now-1d start falls in the previous month when the suite runs on the
    // 1st and drops the 900 provider cost from monthCost (1950 -> 1050).
    const subscriptionId = newId();
    await db
      .insertInto("subscription.subscriptions")
      .values({
        id: subscriptionId,
        tenant_id: tenantA,
        customer_id: customerC1,
        plan_id: planMonthly,
        originating_order_id: orderP1,
        status: "ACTIVE",
        started_at: new Date(),
        current_period_start: new Date(),
        current_period_end: new Date(Date.now() + 29 * 86_400_000),
        cancel_at_period_end: false,
        cancelled_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const cycleId = newId();
    await db
      .insertInto("subscription.subscription_cycles")
      .values({
        id: cycleId,
        tenant_id: tenantA,
        subscription_id: subscriptionId,
        cycle_no: 1,
        starts_at: new Date(),
        ends_at: new Date(Date.now() + 29 * 86_400_000),
        renewal_order_id: null,
        status: "ACTIVE",
        base_revenue_minor: "3000",
        base_provider_cost_minor: "900",
        currency: "BRL",
        created_at: new Date(),
      })
      .execute();

    const recomputed = await injectRaw({ method: "POST", url: "/v1/finance/recompute", token: tokenA, payload: {} });
    expect(recomputed.statusCode).toBe(201);

    const res = await injectRaw({ method: "GET", url: `/v1/finance/contribution?customerId=${customerC1}`, token: tokenA });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      revenueMinor: string;
      cogsMinor: string;
      variableMinor: string;
      contributionMinor: string;
      contributionMarginBps: string;
      cycles: Array<{ cycleId: string; costMinor: string }>;
      aiCostStatus: string;
      paymentFeeStatus: string;
      dataQuality: string;
    }>();
    // Revenue 6000 − COGS (800 supplier + 900 provider) − 250 acquisition.
    expect(body.revenueMinor).toBe("6000");
    expect(body.cogsMinor).toBe("1700");
    expect(body.variableMinor).toBe("250");
    expect(body.contributionMinor).toBe("4050");
    expect(body.contributionMarginBps).toBe("6750");
    expect(body.cycles).toHaveLength(1);
    expect(body.cycles[0]?.cycleId).toBe(cycleId);
    expect(body.cycles[0]?.costMinor).toBe("900");
    expect(body.aiCostStatus).toBe("BASELINE_UNAVAILABLE");
    expect(body.paymentFeeStatus).toBe("BASELINE_UNAVAILABLE");
    expect(body.dataQuality).toBe("COMPLETE");
  });

  it("CAC prices an attributed touch and reports BASELINE_UNAVAILABLE without one", async () => {
    const cac = await injectRaw({ method: "GET", url: `/v1/metrics/cac?customerId=${customerC1}`, token: tokenA });
    expect(cac.statusCode).toBe(200);
    const body = cac.json<{
      status: string;
      paidAcquisitionMinor: string;
      referralCostMinor: string;
      blendedAcquisitionMinor: string;
      newPayingCustomers: number;
    }>();
    expect(body.status).toBe("AVAILABLE");
    expect(body.paidAcquisitionMinor).toBe("250");
    expect(body.referralCostMinor).toBe("0");
    expect(body.blendedAcquisitionMinor).toBe("250");
    expect(body.newPayingCustomers).toBe(1);

    // Second paying customer with no campaign touch at all.
    const personP2 = await makePerson();
    const second = await quoteAndSubmit(personP2, planMonthly, 1);
    expect(second.net).toBe("3000");
    await settleOrder(second.orderId, "3000");
    customerC2 = await customerForPerson(personP2);

    const baseline = await injectRaw({ method: "GET", url: `/v1/metrics/cac?customerId=${customerC2}`, token: tokenA });
    expect(baseline.statusCode).toBe(200);
    expect(baseline.json<{ status: string }>().status).toBe("BASELINE_UNAVAILABLE");

    // C2 settled without supplier facts: revenue stands, quality degrades honestly.
    const partial = await injectRaw({ method: "GET", url: `/v1/finance/contribution?customerId=${customerC2}`, token: tokenA });
    expect(partial.statusCode).toBe(200);
    const partialBody = partial.json<{ revenueMinor: string; contributionMinor: string; dataQuality: string }>();
    expect(partialBody.revenueMinor).toBe("3000");
    expect(partialBody.contributionMinor).toBe("3000");
    expect(partialBody.dataQuality).toBe("PARTIAL");
  });

  it("cohorts split customers by creation month with accumulated revenue", async () => {
    await db
      .updateTable("crm.customers")
      .set({ customer_since: new Date("2026-07-15T00:00:00Z") })
      .where("tenant_id", "=", tenantA)
      .where("id", "=", customerC2)
      .execute();

    const res = await injectRaw({ method: "GET", url: "/v1/metrics/cohorts", token: tokenA });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      cohorts: Array<{ cohortMonth: string; members: number; revenueAccumulatedMinor: string; activeSubscriptions: number }>;
      dataQuality: string;
    }>();
    expect(body.dataQuality).toBe("OK");
    expect(body.cohorts.length).toBe(2);
    const july = body.cohorts.find((c) => c.cohortMonth === "2026-07");
    const current = body.cohorts.find((c) => c.cohortMonth !== "2026-07");
    expect(july?.members).toBe(1);
    expect(july?.revenueAccumulatedMinor).toBe("3000");
    expect(july?.activeSubscriptions).toBe(0);
    expect(current?.members).toBe(1);
    expect(current?.revenueAccumulatedMinor).toBe("6000");
    expect(current?.activeSubscriptions).toBe(1);
  });

  it("overview aggregates MRR, month revenue and month cost", async () => {
    const res = await injectRaw({ method: "GET", url: "/v1/metrics/overview", token: tokenA });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      mrrMinor: string;
      mrrActiveSubscriptions: number;
      monthRevenueMinor: string;
      monthCostMinor: string;
      monthContributionMinor: string;
      contributionMarginBps: string;
      aiCostStatus: string;
      dataQuality: string;
    }>();
    expect(body.mrrMinor).toBe("3000");
    expect(body.mrrActiveSubscriptions).toBe(1);
    expect(body.monthRevenueMinor).toBe("9000");
    // 800 supplier + 900 provider + 250 acquisition, all occurred this month.
    expect(body.monthCostMinor).toBe("1950");
    expect(body.monthContributionMinor).toBe("7050");
    expect(body.contributionMarginBps).toBe("7833");
    expect(body.aiCostStatus).toBe("BASELINE_UNAVAILABLE");
    expect(body.dataQuality).toBe("OK");
  });

  it("tenant isolation: another tenant never sees foreign metrics", async () => {
    const foreign = await injectRaw({
      method: "GET",
      url: `/v1/finance/contribution?customerId=${customerC1}`,
      token: tokenB,
    });
    expect(foreign.statusCode).toBe(404);

    const overview = await injectRaw({ method: "GET", url: "/v1/metrics/overview", token: tokenB });
    expect(overview.statusCode).toBe(200);
    const body = overview.json<{ mrrMinor: string; monthRevenueMinor: string; dataQuality: string }>();
    expect(body.mrrMinor).toBe("0");
    expect(body.monthRevenueMinor).toBe("0");

    const cohorts = await injectRaw({ method: "GET", url: "/v1/metrics/cohorts", token: tokenB });
    expect(cohorts.statusCode).toBe(200);
    expect(cohorts.json<{ cohorts: unknown[]; dataQuality: string }>().dataQuality).toBe("EMPTY");

    // Tenant B wrote nothing to the ledger or allocations.
    const stray = await db
      .selectFrom("finance.cost_allocations")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("tenant_id", "=", tenantB)
      .executeTakeFirstOrThrow();
    expect(Number(stray.n)).toBe(0);
  });
});
