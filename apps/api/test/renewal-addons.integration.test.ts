import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDb } from "@iptv/database";
import { sql } from "kysely";
import type { CommandActor } from "@iptv/domain";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter } from "../src/request-id.js";
import { CommandBus } from "../src/commands/command-bus.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "db", "migrations");
const connectionString = process.env.TEST_DATABASE_URL;

describe.skipIf(!connectionString)("renewal quote with recurring add-ons", () => {
  const db = createDb({ connectionString: connectionString ?? "" });
  let app: NestFastifyApplication;
  let bus: CommandBus;
  const tenantId = randomUUID();
  const userId = randomUUID();
  const personId = randomUUID();
  const customerId = randomUUID();
  const productId = randomUUID();
  const addonId = randomUUID();
  const actor: CommandActor = {
    userId, tenantId, isPlatformAdmin: false, roleKeys: ["tenant_owner"],
    permissions: ["subscription.read", "subscription.write", "settings.manage", "commerce.order.write"],
    actorType: "human",
  };

  beforeAll(async () => {
    await applyMigrations(connectionString!, { migrationsDir });
    await sql`insert into control.tenants (id, slug, name)
      values (${tenantId}::uuid, ${`renewal-${tenantId}`}, 'Renewal test')`.execute(db);
    await sql`insert into control.users (id, auth_subject, display_name, status, is_platform_admin)
      values (${userId}::uuid, ${`renewal:${userId}`}, 'Renewal test actor', 'ACTIVE', false)`.execute(db);
    await sql`insert into control.tenant_memberships (id, tenant_id, user_id, role_key, status)
      values (${randomUUID()}::uuid, ${tenantId}::uuid, ${userId}::uuid, 'tenant_owner', 'ACTIVE')`.execute(db);
    await sql`insert into identity.persons (id, tenant_id, canonical_name)
      values (${personId}::uuid, ${tenantId}::uuid, 'Renewal test person')`.execute(db);
    await sql`insert into crm.customers (id, tenant_id, person_id)
      values (${customerId}::uuid, ${tenantId}::uuid, ${personId}::uuid)`.execute(db);
    await sql`insert into catalog.products (id, tenant_id, product_key, name, product_type)
      values (${productId}::uuid, ${tenantId}::uuid, ${`service-${productId}`}, 'Service', 'SERVICE')`.execute(db);
    await sql`insert into catalog.addons (id, tenant_id, addon_key, name, billing_type)
      values (${addonId}::uuid, ${tenantId}::uuid, ${`screen-${addonId}`}, 'Extra screen', 'RECURRING')`.execute(db);
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    await app.init();
    bus = app.get(CommandBus);
    const policy = await bus.execute(actor, "policy.publish", {
      family: "subscription.renewal", scope: "TENANT", class: "TENANT_POLICY",
      document: { window_days: 7, early_allowed: true, grace_days: 3 },
    });
    if (!policy.ok) throw new Error(`policy.publish failed: ${JSON.stringify(policy)}`);
  });

  async function fixture(unit: "MONTH" | "QUARTER" | "HALF_YEAR" | "YEAR", count: number, planPrice: number, addonPrice: number, quantity: number, ownerCustomerId = customerId) {
    const planId = randomUUID();
    const subscriptionId = randomUUID();
    const now = new Date();
    const suffix = randomUUID();
    const interval: Record<typeof unit, [string, number]> = {
      MONTH: ["MONTH", 1], QUARTER: ["MONTH", 3], HALF_YEAR: ["MONTH", 6], YEAR: ["MONTH", 12],
    };
    await db.insertInto("catalog.plans").values({
      id: planId, tenant_id: tenantId, product_id: productId, plan_key: `plan-${suffix}`,
      name: "Renewal plan", billing_interval_unit: interval[unit][0] as "MONTH",
      billing_interval_count: interval[unit][1], status: "ACTIVE", metadata_json: {},
      created_at: now, updated_at: now,
    }).execute();
    for (const [sellableType, sellableId, amount, segment] of [
      ["PLAN", planId, planPrice, null], ["ADDON", addonId, addonPrice, unit === "MONTH" ? "P1M" : unit === "QUARTER" ? "P3M" : unit === "HALF_YEAR" ? "P6M" : "P12M"],
    ] as const) {
      await db.insertInto("catalog.prices").values({
        id: randomUUID(), tenant_id: tenantId, sellable_type: sellableType, sellable_id: sellableId,
        amount_minor: String(amount), currency: "BRL", starts_at: new Date(now.getTime() - 60_000),
        ends_at: null, segment_key: segment, status: "ACTIVE", metadata_json: {}, created_at: now,
      }).execute();
    }
    const end = new Date(now.getTime() + 30 * 86_400_000);
    await db.insertInto("subscription.subscriptions").values({
      id: subscriptionId, tenant_id: tenantId, customer_id: ownerCustomerId, plan_id: planId,
      originating_order_id: null, status: "ACTIVE", started_at: now, current_period_start: now,
      current_period_end: end, cancel_at_period_end: false, cancelled_at: null, created_at: now, updated_at: now,
    }).execute();
    await db.insertInto("subscription.subscription_cycles").values({
      id: randomUUID(), tenant_id: tenantId, subscription_id: subscriptionId, cycle_no: 1,
      starts_at: now, ends_at: end, renewal_order_id: null, status: "ACTIVE",
      base_revenue_minor: String(planPrice), base_provider_cost_minor: "0", currency: "BRL", created_at: now,
    }).execute();
    await db.insertInto("subscription.subscription_addons").values({
      id: randomUUID(), tenant_id: tenantId, subscription_id: subscriptionId, addon_id: addonId,
      quantity: String(quantity), status: "ACTIVE", effective_from: now, created_at: now, updated_at: now,
    }).execute();
    return subscriptionId;
  }

  it.each([
    ["monthly", "MONTH", 1, 3000, 2000, 1, 4500],
    ["quarterly", "QUARTER", 3, 7500, 6000, 2, 19000],
    ["half-yearly", "HALF_YEAR", 6, 15000, 10000, 1, 24500],
    ["yearly", "YEAR", 12, 30000, 15000, 2, 59500],
  ] as const)("quotes %s plan plus its recurring screens at the discounted total", async (_label, unit, count, plan, addon, quantity, expected) => {
    const subscriptionId = await fixture(unit, count, plan, addon, quantity);
    const result = await bus.execute<{ orderId: string; netAmountMinor: string; early: boolean; already: boolean }>(
      actor, "renewal.quote", { subscriptionId },
    );
    if (!result.ok) throw new Error(`renewal.quote failed: ${JSON.stringify(result)}`);
    expect(result.data).toMatchObject({ netAmountMinor: String(expected), early: true, already: false });
    const items = await db.selectFrom("commerce.order_items").select(["item_type", "quantity"])
      .where("tenant_id", "=", tenantId).where("order_id", "=", result.data.orderId).execute();
    expect(items).toHaveLength(2);
    expect(items.filter((item) => item.item_type === "OTHER")).toHaveLength(1);
    expect(Number(items.find((item) => item.item_type === "OTHER")?.quantity)).toBe(quantity);
  });

  it("does not discount an in-window renewal and returns an idempotent quote without duplicating add-on items", async () => {
    const subscriptionId = await fixture("MONTH", 1, 3000, 2000, 1);
    await db.updateTable("subscription.subscription_cycles")
      .set({ ends_at: new Date(Date.now() + 3 * 86_400_000) })
      .where("tenant_id", "=", tenantId).where("subscription_id", "=", subscriptionId).execute();
    const first = await bus.execute<{ orderId: string; netAmountMinor: string; early: boolean; already: boolean }>(
      actor, "renewal.quote", { subscriptionId },
    );
    if (!first.ok) throw new Error(`renewal.quote failed: ${JSON.stringify(first)}`);
    expect(first.data).toMatchObject({ netAmountMinor: "5000", early: false, already: false });
    const replay = await bus.execute<{ orderId: string; netAmountMinor: string; early: boolean; already: boolean }>(
      actor, "renewal.quote", { subscriptionId },
    );
    if (!replay.ok) throw new Error(`second renewal.quote failed: ${JSON.stringify(replay)}`);
    expect(replay.data).toMatchObject({ orderId: first.data.orderId, netAmountMinor: "5000", already: true });
    const rows = await db.selectFrom("commerce.order_items").select(["id"])
      .where("tenant_id", "=", tenantId).where("order_id", "=", first.data.orderId).execute();
    expect(rows).toHaveLength(2);
  });

  it("reopens add-on entitlements only for the renewed subscription and customer", async () => {
    const otherPersonId = randomUUID();
    const otherCustomerId = randomUUID();
    await sql`insert into identity.persons (id, tenant_id, canonical_name)
      values (${otherPersonId}::uuid, ${tenantId}::uuid, 'Other renewal person')`.execute(db);
    await sql`insert into crm.customers (id, tenant_id, person_id)
      values (${otherCustomerId}::uuid, ${tenantId}::uuid, ${otherPersonId}::uuid)`.execute(db);
    const subscriptionA = await fixture("MONTH", 1, 3000, 2000, 1);
    const subscriptionB = await fixture("MONTH", 1, 3000, 2000, 1, otherCustomerId);
    const startA = new Date(Date.now() - 60 * 86_400_000);
    const endA = new Date(Date.now() - 30 * 86_400_000);
    const startB = new Date(Date.now() - 90 * 86_400_000);
    const endB = new Date(Date.now() - 60 * 86_400_000);
    const entitlementA = randomUUID();
    const entitlementB = randomUUID();
    for (const [id, owner, subscriptionId, startsAt, endsAt] of [
      [entitlementA, customerId, subscriptionA, startA, endA],
      [entitlementB, otherCustomerId, subscriptionB, startB, endB],
    ] as const) {
      await db.insertInto("entitlement.entitlements").values({
        id, tenant_id: tenantId, customer_id: owner, feature_key: "screens",
        status: "EXPIRED", starts_at: startsAt, ends_at: endsAt,
        source_type: "subscription_addon", source_id: addonId,
        metadata_json: { subscription_id: subscriptionId }, created_at: startA, updated_at: startA,
      }).execute();
    }
    const quote = await bus.execute<{ orderId: string }>(actor, "renewal.quote", { subscriptionId: subscriptionA });
    if (!quote.ok) throw new Error(`renewal.quote failed: ${JSON.stringify(quote)}`);
    const order = await db.selectFrom("commerce.orders").select(["net_amount_minor"])
      .where("tenant_id", "=", tenantId).where("id", "=", quote.data.orderId).executeTakeFirstOrThrow();
    await db.updateTable("commerce.orders").set({
      status: "SETTLED", settled_amount_minor: order.net_amount_minor, settled_at: new Date(),
    }).where("tenant_id", "=", tenantId).where("id", "=", quote.data.orderId).execute();
    const renewed = await bus.execute(actor, "subscription.renew", { orderId: quote.data.orderId });
    if (!renewed.ok) throw new Error(`subscription.renew failed: ${JSON.stringify(renewed)}`);
    const [a, b] = await Promise.all([entitlementA, entitlementB].map((id) =>
      db.selectFrom("entitlement.entitlements").select(["status", "starts_at", "ends_at"])
        .where("tenant_id", "=", tenantId).where("id", "=", id).executeTakeFirstOrThrow()));
    expect(a).toBeDefined();
    expect(a?.status).toBe("ACTIVE");
    expect(a?.starts_at.getTime()).not.toBe(startA.getTime());
    expect(a?.ends_at).not.toBeNull();
    expect(a?.ends_at?.getTime()).not.toBe(endA.getTime());
    expect(b).toMatchObject({ status: "EXPIRED", starts_at: startB, ends_at: endB });
  });

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
  });
});
