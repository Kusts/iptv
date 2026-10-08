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

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(-12)}@example.com`;
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
];

describe.skipIf(!hasDb)("GAP-LOOP-1 customer binding + charge auto-resolve (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let tenantId = "";
  let userId = "";
  let bus: CommandBus;

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

  async function makePerson(): Promise<string> {
    const result = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Binding Person",
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
        tenant_id: tenantId,
        product_key: `bind-svc-${suffix}`,
        name: "Binding Service",
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
        plan_key: `bind-monthly-${suffix}`,
        name: "Binding Monthly",
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

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    delete process.env["ASAAS_ADAPTER"];
    delete process.env["ASAAS_ECHO_CREATE"];
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);

    const instance = app.getHttpAdapter().getInstance();
    const register = await instance.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("bind"), password: "correct-horse-8", tenantName: "Binding Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    tenantId = body.activeTenantId;
    userId = body.user.id;
  });

  afterAll(async () => {
    delete process.env["ASAAS_ECHO_CREATE"];
    await app?.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
  });

  it("charge.create fails closed without a binding (explicit precondition, no charge row)", async () => {
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const orderId = await quoteAndSubmit(personId, planId);
    const created = await bus.execute(actor(), "charge.create", { orderId });
    expect(created.ok).toBe(false);
    if (created.ok) {
      throw new Error("charge.create must fail without a binding");
    }
    expect(created.code).toBe("precondition_failed");
    expect(created.message).toContain("billing.customer_provision");
    const charges = await db
      .selectFrom("billing.charges")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("order_id", "=", orderId)
      .execute();
    expect(charges).toHaveLength(0);
  });

  it("provision -> idempotent re-provision -> charge.create resolves the binding (echo)", async () => {
    const personId = await makePerson();
    const planId = await seedPlan("2000");
    const orderId = await quoteAndSubmit(personId, planId);

    const first = await bus.execute<{
      id: string;
      personId: string;
      providerCustomerId: string;
      provisioned: boolean;
    }>(actor(), "billing.customer_provision", { personId });
    if (!first.ok) {
      throw new Error(`provision failed: ${JSON.stringify(first)}`);
    }
    expect(first.data.provisioned).toBe(true);
    expect(first.data.providerCustomerId).toContain("echo-cus-");

    const second = await bus.execute<{ provisioned: boolean; providerCustomerId: string }>(
      actor(),
      "billing.customer_provision",
      { personId },
    );
    if (!second.ok) {
      throw new Error(`re-provision failed: ${JSON.stringify(second)}`);
    }
    expect(second.data.provisioned).toBe(false);
    expect(second.data.providerCustomerId).toBe(first.data.providerCustomerId);

    const created = await bus.execute<{
      id: string;
      status: string;
      providerChargeId: string | null;
    }>(actor(), "charge.create", { orderId });
    if (!created.ok || created.data.providerChargeId === null) {
      throw new Error(`charge.create failed: ${JSON.stringify(created)}`);
    }
    expect(created.data.status).toBe("PROCESSING");

    // The charge binding carries the resolved customer (never null now).
    const binding = await db
      .selectFrom("billing.charge_provider_bindings")
      .select(["external_customer_id", "external_charge_id"])
      .where("tenant_id", "=", tenantId)
      .where("charge_id", "=", created.data.id)
      .executeTakeFirstOrThrow();
    expect(binding.external_customer_id).toBe(first.data.providerCustomerId);
    expect(binding.external_charge_id).toBe(created.data.providerChargeId);
  });

  it("provision refuses an unknown person", async () => {
    const result = await bus.execute(actor(), "billing.customer_provision", {
      personId: newId(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("provision must fail for an unknown person");
    }
    expect(result.code).toBe("not_found");
  });
});
