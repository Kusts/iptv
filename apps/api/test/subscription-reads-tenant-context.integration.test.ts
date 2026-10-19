import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "kysely";
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

/**
 * Regression for the staging 404/empty-read incident (2026-10-19):
 * subscription/fulfillment/renewal controller reads used the raw pool
 * without tenant context, so under the iptv_app role (RLS-enrolled tables)
 * they failed closed — GET /v1/subscriptions/:id → 404 and list → [] even
 * though the row existed. The whole app pool here is iptv_app, mirroring
 * staging/production, so these HTTP assertions fail on the old code and
 * pass with the withTenantTransaction fix.
 */
describe.skipIf(!hasDb)("Subscription reads under iptv_app (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  let ownerDb: ReturnType<typeof createDb>;
  let adminDb: ReturnType<typeof createDb>;
  let databaseName = "";
  let bus: CommandBus;
  let token = "";
  let tenantId = "";
  let userId = "";

  function withDatabase(base: string, database: string): string {
    const url = new URL(base);
    url.pathname = `/${database}`;
    return url.toString();
  }

  function withAppIdentity(base: string, password: string): string {
    const url = new URL(base);
    url.username = "iptv_app";
    url.password = password;
    return url.toString();
  }

  function email(prefix: string): string {
    return `${prefix}-${newId().replace(/-/g, "").slice(-12)}@example.com`;
  }

  function sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }

  function actor(): CommandActor {
    return {
      userId,
      isPlatformAdmin: false,
      tenantId,
      roleKeys: ["tenant_owner"],
      permissions: [
        "commerce.order.write",
        "billing.charge.write",
        "billing.read",
        "subscription.read",
        "subscription.write",
        "provider.operation.read",
        "provider.operation.write",
      ],
      actorType: "human",
    };
  }

  function injectRaw(opts: {
    method: "GET" | "POST";
    url: string;
    payload?: Record<string, unknown>;
    headers?: Record<string, string>;
  }) {
    return app.getHttpAdapter().getInstance().inject({
      method: opts.method,
      url: opts.url,
      headers: {
        authorization: `Bearer ${token}`,
        "x-tenant-context-revision": "0",
        ...(opts.headers ?? {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    });
  }

  const ASAAS_SECRET = "reads-test-asaas-secret";

  beforeAll(async () => {
    const base = connectionString as string;
    adminDb = createDb({ connectionString: withDatabase(base, "postgres") });
    databaseName = `reads_ctx_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(databaseName)) {
      throw new Error("unsafe generated scratch database name");
    }
    await sql.raw(`CREATE DATABASE "${databaseName}"`).execute(adminDb);
    const dedicatedUrl = withDatabase(base, databaseName);
    await applyMigrations(dedicatedUrl, { migrationsDir: MIGRATIONS_DIR });
    ownerDb = createDb({ connectionString: dedicatedUrl });
    const appPassword = `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
    await sql.raw(`ALTER ROLE iptv_app WITH LOGIN PASSWORD '${appPassword}'`).execute(ownerDb);
    const appUrl = withAppIdentity(dedicatedUrl, appPassword);

    process.env["DATABASE_URL"] = dedicatedUrl;
    process.env["APP_DATABASE_URL"] = appUrl;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);

    const register = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("reads"), password: "correct-horse-8", tenantName: "Reads Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;
  }, 120000);

  afterAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    await app?.close().catch(() => undefined);
    await ownerDb?.destroy().catch(() => undefined);
    if (hasDb && databaseName !== "") {
      await sql.raw(`DROP DATABASE IF EXISTS "${databaseName}"`).execute(adminDb).catch(() => undefined);
    }
    await adminDb?.destroy().catch(() => undefined);
  });

  it("subscription get/list + fulfillment status + renewals list read own rows under iptv_app", async () => {
    // Catalog seed via owner (no catalog write API; RLS-bypassed owner setup).
    const suffix = newId().replace(/-/g, "").slice(-12);
    const productId = newId();
    await ownerDb
      .insertInto("catalog.products")
      .values({
        id: productId,
        tenant_id: tenantId,
        product_key: `svc-${suffix}`,
        name: "Reads Service",
        product_type: "SERVICE",
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const planId = newId();
    await ownerDb
      .insertInto("catalog.plans")
      .values({
        id: planId,
        tenant_id: tenantId,
        product_id: productId,
        plan_key: `monthly-${suffix}`,
        name: "Reads Monthly",
        billing_interval_unit: "MONTH",
        billing_interval_count: 1,
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await ownerDb
      .insertInto("catalog.prices")
      .values({
        id: newId(),
        tenant_id: tenantId,
        sellable_type: "PLAN",
        sellable_id: planId,
        amount_minor: "500",
        currency: "BRL",
        starts_at: new Date(Date.now() - 60_000),
        ends_at: null,
        segment_key: null,
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
      })
      .execute();

    // Sale loop through the app pool (every step sets tenant context).
    const person = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Reads Person",
    });
    expect(person.ok).toBe(true);
    if (!person.ok) throw new Error(person.message);
    const quoted = await bus.execute<{ id: string }>(actor(), "offer.quote", {
      personId: person.data.id,
      items: [{ sellableType: "PLAN", sellableId: planId, quantity: 1 }],
      orderType: "NEW_SUBSCRIPTION",
    });
    expect(quoted.ok).toBe(true);
    if (!quoted.ok) throw new Error(JSON.stringify(quoted));
    const submitted = await bus.execute(actor(), "order.submit", { orderId: quoted.data.id });
    expect(submitted.ok).toBe(true);
    const tenantKey = `asaas-${newId().replace(/-/g, "").slice(-12)}`;
    await ownerDb
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
    const provisioned = await bus.execute(actor(), "billing.customer_provision", {
      personId: person.data.id,
    });
    expect(provisioned.ok).toBe(true);
    const created = await bus.execute<{ id: string; providerChargeId: string | null }>(
      actor(),
      "charge.create",
      { orderId: quoted.data.id },
    );
    expect(created.ok).toBe(true);
    if (!created.ok || created.data.providerChargeId === null) {
      throw new Error(`charge.create failed: ${JSON.stringify(created)}`);
    }
    const delivered = await injectRaw({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}`,
      headers: { "x-asaas-secret": ASAAS_SECRET },
      payload: {
        event: "PAYMENT_RECEIVED",
        id: `evt-reads-${newId().slice(-12)}`,
        payment: { id: created.data.providerChargeId, value: 5.0, currency: "BRL" },
      },
    });
    expect(delivered.statusCode).toBe(202);
    const activated = await bus.execute<{ id: string; status: string }>(
      actor(),
      "subscription.activate_from_order",
      { orderId: quoted.data.id },
    );
    expect(activated.ok).toBe(true);
    if (!activated.ok) throw new Error(JSON.stringify(activated));
    const subscriptionId = activated.data.id;

    // The regression assertions: HTTP reads under iptv_app must see the row.
    const got = await injectRaw({ method: "GET", url: `/v1/subscriptions/${subscriptionId}` });
    expect(got.statusCode).toBe(200);
    expect(got.json<{ id: string; status: string }>().id).toBe(subscriptionId);

    const listed = await injectRaw({ method: "GET", url: "/v1/subscriptions" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ subscriptions: { id: string }[] }>().subscriptions.map((s) => s.id)).toContain(
      subscriptionId,
    );

    const requested = await bus.execute<{ operationId: string; status: string }>(
      actor(),
      "fulfillment.request_for_subscription",
      { subscriptionId, adapter: "manual" },
    );
    expect(requested.ok).toBe(true);
    const fstatus = await injectRaw({
      method: "GET",
      url: `/v1/fulfillment/subscriptions/${subscriptionId}`,
    });
    expect(fstatus.statusCode).toBe(200);

    const renewals = await injectRaw({
      method: "GET",
      url: `/v1/renewals?subscriptionId=${subscriptionId}`,
    });
    expect(renewals.statusCode).toBe(200);
  });
});
