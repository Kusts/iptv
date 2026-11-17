import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { applyMigrations, createDb } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { AppModule } from "../src/app.module.js";
import { CommandBus } from "../src/commands/command-bus.js";
import { createFastifyAdapter } from "../src/request-id.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");
const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;
const permissions = ["crm.person.read", "crm.lead.write", "commerce.order.write"];

describe.skipIf(!hasDb)("approved catalog segment pricing", () => {
  const db = createDb({ connectionString: connectionString as string });
  let app: NestFastifyApplication;
  let bus: CommandBus;
  let tenantId = "";
  let userId = "";
  let personId = "";
  let productId = "";
  let planId = "";
  let addonId = "";

  const actor = (): CommandActor => ({
    userId,
    isPlatformAdmin: false,
    tenantId,
    roleKeys: ["tenant_owner"],
    permissions,
    actorType: "human",
  });

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    await app.init();
    bus = app.get(CommandBus);
    tenantId = newId();
    userId = newId();
    const suffix = tenantId.replace(/-/g, "");
    await db.insertInto("control.tenants").values({
      id: tenantId, slug: `segment-${suffix}`, name: "Segment Pricing Test",
      status: "ACTIVE", default_currency: "BRL", timezone: "America/Sao_Paulo",
      created_at: new Date(), updated_at: new Date(),
    }).execute();
    await db.insertInto("control.users").values({
      id: userId, auth_subject: `segment-${suffix}`, display_name: "Pricing Test",
      status: "ACTIVE", is_platform_admin: false, created_at: new Date(), updated_at: new Date(),
    }).execute();
    await db.insertInto("control.tenant_memberships").values({
      id: newId(), tenant_id: tenantId, user_id: userId, role_key: "tenant_owner",
      status: "ACTIVE", created_at: new Date(), updated_at: new Date(),
    }).execute();
    const person = await bus.execute<{ id: string }>(actor(), "person.register", { canonicalName: "Pricing Customer" });
    if (!person.ok) throw new Error(`person.register failed: ${person.message}`);
    personId = person.data.id;
    productId = newId();
    await db.insertInto("catalog.products").values({
      id: productId, tenant_id: tenantId, product_key: `streaming-${suffix}`, name: "Streaming",
      product_type: "SERVICE", status: "ACTIVE", metadata_json: {}, created_at: new Date(), updated_at: new Date(),
    }).execute();
    const plans = [
      { count: 1, amount: 3000 }, { count: 3, amount: 7500 },
      { count: 6, amount: 15000 }, { count: 12, amount: 30000 },
    ];
    for (const plan of plans) {
      const id = newId();
      if (plan.count === 1) planId = id;
      await db.insertInto("catalog.plans").values({
        id, tenant_id: tenantId, product_id: productId, plan_key: `plan-${plan.count}-${suffix}`,
        name: `Plan ${plan.count}`, billing_interval_unit: "MONTH", billing_interval_count: plan.count,
        status: "ACTIVE", metadata_json: {}, created_at: new Date(), updated_at: new Date(),
      }).execute();
      await db.insertInto("catalog.prices").values({
        id: newId(), tenant_id: tenantId, sellable_type: "PLAN", sellable_id: id,
        amount_minor: String(plan.amount), currency: "BRL", starts_at: new Date(Date.now() - 60_000),
        ends_at: null, segment_key: null, status: "ACTIVE", metadata_json: {}, created_at: new Date(),
      }).execute();
    }
    addonId = newId();
    await db.insertInto("catalog.addons").values({
      id: addonId, tenant_id: tenantId, addon_key: `additional-connection-${suffix}`,
      name: "Additional connection", status: "ACTIVE", billing_type: "RECURRING",
      entitlement_feature_key: "CONNECTIONS", metadata_json: {}, created_at: new Date(), updated_at: new Date(),
    }).execute();
    for (const [segmentKey, amount] of [["P1M", 2000], ["P3M", 6000], ["P6M", 10000], ["P12M", 15000]] as const) {
      await db.insertInto("catalog.prices").values({
        id: newId(), tenant_id: tenantId, sellable_type: "ADDON", sellable_id: addonId,
        amount_minor: String(amount), currency: "BRL", starts_at: new Date(Date.now() - 60_000),
        ends_at: null, segment_key: segmentKey, status: "ACTIVE", metadata_json: {}, created_at: new Date(),
      }).execute();
    }
  });

  afterAll(async () => {
    if (tenantId) {
      await db.deleteFrom("commerce.orders").where("tenant_id", "=", tenantId).execute().catch(() => undefined);
      await db.deleteFrom("catalog.prices").where("tenant_id", "=", tenantId).execute().catch(() => undefined);
      await db.deleteFrom("catalog.addons").where("tenant_id", "=", tenantId).execute().catch(() => undefined);
      await db.deleteFrom("catalog.plans").where("tenant_id", "=", tenantId).execute().catch(() => undefined);
      await db.deleteFrom("catalog.products").where("tenant_id", "=", tenantId).execute().catch(() => undefined);
      await db.deleteFrom("identity.persons").where("tenant_id", "=", tenantId).execute().catch(() => undefined);
      await db.deleteFrom("control.tenant_memberships").where("tenant_id", "=", tenantId).execute().catch(() => undefined);
      await db.deleteFrom("control.users").where("id", "=", userId).execute().catch(() => undefined);
      await db.deleteFrom("control.tenants").where("id", "=", tenantId).execute().catch(() => undefined);
    }
    await app?.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
  });

  it("quotes segment prices and audits the selected segment", async () => {
    const expected = [
      { period: "P1M", plan: 3000, addon: 2000, qty: 1, net: 5000 },
      { period: "P3M", plan: 7500, addon: 6000, qty: 2, net: 19500 },
      { period: "P6M", plan: 15000, addon: 10000, qty: 1, net: 25000 },
      { period: "P12M", plan: 30000, addon: 15000, qty: 3, net: 75000 },
    ];
    const planIds = await db.selectFrom("catalog.plans").select(["id", "billing_interval_count"])
      .where("tenant_id", "=", tenantId).execute();
    for (const test of expected) {
      const target = planIds.find((p) => Number(p.billing_interval_count) === Number(test.period.slice(1, -1)));
      if (!target) throw new Error(`missing plan for ${test.period}`);
      const quoted = await bus.execute<{ id: string; netAmountMinor: string }>(actor(), "offer.quote", {
        personId, items: [
          { sellableType: "PLAN", sellableId: target.id, quantity: 1 },
          { sellableType: "ADDON", sellableId: addonId, quantity: test.qty, segmentKey: test.period },
        ],
      });
      expect(quoted).toMatchObject({ ok: true, data: { netAmountMinor: String(test.net) } });
      if (!quoted.ok) throw new Error(`quote failed: ${quoted.message}`);
      const snapshot = await db.selectFrom("commerce.price_snapshots as snap")
        .innerJoin("commerce.order_items as item", "item.id", "snap.order_item_id")
        .select(["snap.context_json"]).where("item.order_id", "=", quoted.data.id)
        .where("item.sellable_type", "=", "ADDON").executeTakeFirstOrThrow();
      expect(snapshot.context_json).toMatchObject({ segmentKey: test.period, quantity: test.qty });
    }
    const missingSegment = await bus.execute(actor(), "offer.quote", {
      personId, items: [{ sellableType: "ADDON", sellableId: addonId, quantity: 1 }],
    });
    expect(missingSegment).toMatchObject({ ok: false, code: "validation_failed" });
    const invalidSegment = await bus.execute(actor(), "offer.quote", {
      personId, items: [{ sellableType: "ADDON", sellableId: addonId, quantity: 1, segmentKey: "P99M" }],
    });
    expect(invalidSegment).toMatchObject({ ok: false, code: "validation_failed" });
    const invalid = await bus.execute(actor(), "offer.quote", {
      personId, items: [{ sellableType: "PLAN", sellableId: planId, quantity: 1, segmentKey: "P1M" }],
    });
    expect(invalid).toMatchObject({ ok: false, code: "validation_failed" });
  });
});
