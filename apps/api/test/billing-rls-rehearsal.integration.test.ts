import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql, type Kysely } from "kysely";
import { createDb, applyMigrations, withTenantTransaction, type Database } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { AppModule, resolveAppConnectionString } from "../src/app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";
import { CommandBus } from "../src/commands/command-bus.js";

/**
 * P13-FIX3 rehearsal: migration 052 enrolled billing.* + finance.* in RLS
 * (fail-closed when `app.tenant_id` is unset).
 *
 * WHAT IS PROVEN HERE (effective `iptv_app` pool, real Auth/Permissions
 * guards — no guard mocks, no test-only grants; the only grants in force are
 * the ones from migrations 001–052):
 *
 * - pool identity: the app under test connects AS `iptv_app`
 *   (`current_user`/`session_user`, non-superuser, `NOBYPASSRLS`, owns zero
 *   tables/functions);
 * - the 4 billing listings (charges, payments, refund-requests,
 *   billing-exceptions) over HTTP with tenants A/B: own rows visible,
 *   cross-tenant rows absent, unauthenticated denied;
 * - the Asaas chargeback lookup SHAPE (binding → payment, tenant-scoped)
 *   resolves on a genuine `iptv_app` session and fail-closes to 0 rows
 *   without tenant context — exercised directly on the `iptv_app` pool,
 *   isolated from the bus (no webhook call).
 *
 * WHAT IS *NOT* PROVEN HERE (explicitly out of scope):
 *
 * - full Asaas webhook end-to-end UNDER `iptv_app`: the webhook path writes
 *   through the bus (platform outbox), which migration 050 reserves to the
 *   worker boundary — that cutover is the P1-exit gate, not this rehearsal;
 * - the private `AsaasWebhookService.findPaymentForExternalCharge` method
 *   itself is never invoked — only its exact two-table shape is replayed.
 *
 * COMPLEMENTARY EVIDENCE ONLY (kept, labelled, not a cutover claim):
 *
 * - the chargeback webhook end-to-end on the OWNER pool (proves the domain
 *   behavior pre-cutover, says nothing about `iptv_app`);
 * - the `SET LOCAL ROLE iptv_app` SQL probes (approximate the role on an
 *   owner session; the genuine-pool assertions above supersede them).
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

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

const PERMISSIONS = [
  "crm.person.read",
  "crm.lead.write",
  "billing.read",
  "commerce.order.write",
  "billing.charge.write",
  "billing.refund.request",
  "billing.refund.execute",
  "billing.exception.resolve",
  "agent.review.request",
  "agent.review.decide",
];

const ASAAS_SECRET = "p13-fix1-asaas-secret";

describe.skipIf(!hasDb)("Billing RLS rehearsal under iptv_app (requires TEST_DATABASE_URL)", () => {
  // Scratch database owned by this file (migrations 001–052 applied fresh);
  // dropped in teardown. `adminDb` touches only the `postgres` maintenance
  // database for CREATE/DROP DATABASE.
  let adminDb: Kysely<Database>;
  let databaseName = "";
  // Administrative (owner) connection: DDL reads, fixture inserts, and the
  // owner-pool app/bus. Never used for an assertion ABOUT the app role.
  let ownerDb: Kysely<Database>;
  // Effective `iptv_app` connection: every assertion about the cutover role
  // reads through here (genuine session, no SET ROLE tricks).
  let appDb: Kysely<Database>;
  // Owner-pool app (complementary webhook evidence + fixture commands).
  let ownerApp: NestFastifyApplication;
  // `iptv_app`-pool app (the 4 real GETs, real guards end to end).
  let app: NestFastifyApplication;
  let ownerBus: CommandBus;

  let tokenA = "";
  let tenantA = "";
  let userA = "";
  let tokenB = "";
  let tenantB = "";
  let userB = "";

  function actorA(): CommandActor {
    return {
      userId: userA,
      isPlatformAdmin: false,
      tenantId: tenantA,
      roleKeys: ["tenant_owner"],
      permissions: PERMISSIONS,
      actorType: "human",
    };
  }

  function actorB(): CommandActor {
    return {
      userId: userB,
      isPlatformAdmin: false,
      tenantId: tenantB,
      roleKeys: ["tenant_owner"],
      permissions: PERMISSIONS,
      actorType: "human",
    };
  }

  function injectRaw(
    target: NestFastifyApplication,
    opts: {
      method: "GET" | "POST";
      url: string;
      token?: string;
      revision?: string | null;
      headers?: Record<string, string>;
      payload?: Record<string, unknown>;
    },
  ) {
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
    return target.getHttpAdapter().getInstance().inject(options);
  }

  async function makePerson(as: CommandActor): Promise<string> {
    const result = await ownerBus.execute<{ id: string }>(as, "person.register", {
      canonicalName: "P13 Person",
    });
    if (!result.ok) {
      throw new Error(`person.register failed: ${result.message}`);
    }
    return result.data.id;
  }

  async function seedPlan(tenantId: string, priceMinor: string): Promise<string> {
    const suffix = newId().replace(/-/g, "").slice(-12);
    const productId = newId();
    await ownerDb
      .insertInto("catalog.products")
      .values({
        id: productId,
        tenant_id: tenantId,
        product_key: `svc-${suffix}`,
        name: "P13 Service",
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
        name: "P13 Monthly",
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

  async function quoteAndSubmit(as: CommandActor, personId: string, planId: string): Promise<string> {
    const quoted = await ownerBus.execute<{ id: string }>(as, "offer.quote", {
      personId,
      items: [{ sellableType: "PLAN", sellableId: planId, quantity: 1 }],
      orderType: "NEW_SUBSCRIPTION",
    });
    if (!quoted.ok) {
      throw new Error(`offer.quote failed: ${JSON.stringify(quoted)}`);
    }
    const submitted = await ownerBus.execute(as, "order.submit", { orderId: quoted.data.id });
    if (!submitted.ok) {
      throw new Error(`order.submit failed: ${JSON.stringify(submitted)}`);
    }
    return quoted.data.id;
  }

  async function createCharge(as: CommandActor, orderId: string): Promise<{ chargeId: string; providerChargeId: string }> {
    // GAP-LOOP-1: charge.create auto-resolves the person's Asaas binding.
    const provisionOwner = await ownerDb
      .selectFrom("commerce.orders")
      .select(["person_id"])
      .where("tenant_id", "=", as.tenantId)
      .where("id", "=", orderId)
      .executeTakeFirstOrThrow();
    const provisioned = await ownerBus.execute(as, "billing.customer_provision", {
      personId: provisionOwner.person_id,
    });
    if (!provisioned.ok) {
      throw new Error(`customer.provision failed: ${JSON.stringify(provisioned)}`);
    }
    const created = await ownerBus.execute<{ id: string; status: string; providerChargeId: string | null }>(
      as,
      "charge.create",
      { orderId },
    );
    if (!created.ok || created.data.providerChargeId === null) {
      throw new Error(`charge.create failed: ${JSON.stringify(created)}`);
    }
    return { chargeId: created.data.id, providerChargeId: created.data.providerChargeId };
  }

  async function requestRefund(as: CommandActor, paymentId: string, key: string): Promise<string> {
    const requested = await ownerBus.execute<{ id: string; status: string; reviewRequestId: string }>(
      as,
      "refund.request",
      {
        paymentId,
        amountMinor: "500",
        currency: "BRL",
        reason: "partial refund isolation probe",
        idempotencyKey: key,
      },
    );
    if (!requested.ok) {
      throw new Error(`refund.request failed: ${JSON.stringify(requested)}`);
    }
    return requested.data.id;
  }

  async function setupAsaasChannel(tenantId: string): Promise<string> {
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
    return tenantKey;
  }

  async function postAsaas(tenantKey: string, payload: Record<string, unknown>) {
    return injectRaw(ownerApp, {
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}`,
      headers: { "asaas-access-token": ASAAS_SECRET },
      payload,
    });
  }

  function paidPayload(providerChargeId: string, eventId: string, value: number): Record<string, unknown> {
    return {
      event: "PAYMENT_RECEIVED",
      id: eventId,
      payment: { id: providerChargeId, value, currency: "BRL" },
    };
  }

  beforeAll(async () => {
    const base = connectionString as string;
    adminDb = createDb({ connectionString: withDatabase(base, "postgres") });
    databaseName = `p13_rls_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(databaseName)) {
      throw new Error("unsafe generated scratch database name");
    }
    await sql.raw(`CREATE DATABASE "${databaseName}"`).execute(adminDb);
    const dedicatedUrl = withDatabase(base, databaseName);
    await applyMigrations(dedicatedUrl, { migrationsDir: MIGRATIONS_DIR });
    ownerDb = createDb({ connectionString: dedicatedUrl });
    // Temporary password for the cluster-global `iptv_app` role, scoped to
    // this disposable run: hex-only so the literal is injection-safe, reset
    // to NULL in teardown. Never hardcoded, never committed.
    const appPassword = `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
    if (!/^[0-9a-f]{16,}$/.test(appPassword)) {
      throw new Error("unsafe generated app password");
    }
    await sql.raw(`ALTER ROLE iptv_app WITH LOGIN PASSWORD '${appPassword}'`).execute(ownerDb);
    const appUrl = withAppIdentity(dedicatedUrl, appPassword);
    appDb = createDb({ connectionString: appUrl });

    process.env["DATABASE_URL"] = dedicatedUrl;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    delete process.env["ASAAS_ADAPTER"];
    // Owner-pool app first (blank APP_DATABASE_URL = absent → owner pool).
    process.env["APP_DATABASE_URL"] = "";
    ownerApp = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(ownerApp);
    await ownerApp.init();
    ownerBus = ownerApp.get(CommandBus);

    // `iptv_app`-pool app: the resolver MUST pick the restricted pool.
    process.env["APP_DATABASE_URL"] = appUrl;
    expect(resolveAppConnectionString()).toBe(appUrl);
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();

    const registerA = await injectRaw(ownerApp, {
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("p13a"), password: "correct-horse-8", tenantName: "P13 Tenant A" },
    });
    expect(registerA.statusCode).toBe(201);
    const bodyA = registerA.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    tokenA = bodyA.token;
    tenantA = bodyA.activeTenantId;
    userA = bodyA.user.id;

    const registerB = await injectRaw(ownerApp, {
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("p13b"), password: "correct-horse-8", tenantName: "P13 Tenant B" },
    });
    expect(registerB.statusCode).toBe(201);
    const bodyB = registerB.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    tokenB = bodyB.token;
    tenantB = bodyB.activeTenantId;
    userB = bodyB.user.id;
  }, 180_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await ownerApp?.close().catch(() => undefined);
    // The Nest apps own Kysely pools that outlive `close()` (no module
    // destroy hook): drain them explicitly BEFORE the FORCE drop, otherwise
    // the drop terminates their idle sessions and vitest reports unhandled
    // `57P01` errors.
    for (const target of [app, ownerApp]) {
      try {
        const poolDb = target?.get("DB") as Kysely<Database> | null | undefined;
        await poolDb?.destroy();
      } catch {
        // Best-effort teardown only.
      }
    }
    await appDb?.destroy().catch(() => undefined);
    if (ownerDb !== undefined) {
      await sql
        .raw("ALTER ROLE iptv_app WITH PASSWORD NULL")
        .execute(ownerDb)
        .catch(() => undefined);
      await ownerDb.destroy().catch(() => undefined);
    }
    if (adminDb !== undefined && databaseName !== "") {
      await sql
        .raw(`DROP DATABASE "${databaseName}" WITH (FORCE)`)
        .execute(adminDb)
        .catch(() => undefined);
      await adminDb.destroy().catch(() => undefined);
    }
  });

  it("effective pool identity is iptv_app with no bypass and no ownership (REAL)", async () => {
    const who = await sql<{ u: string; su: string; is_superuser: string }>`
      SELECT current_user AS u, session_user AS su, current_setting('is_superuser') AS is_superuser
    `.execute(appDb);
    expect(who.rows[0]?.u).toBe("iptv_app");
    expect(who.rows[0]?.su).toBe("iptv_app");
    expect(who.rows[0]?.is_superuser).toBe("off");
    const role = await sql<{ rolbypassrls: boolean }>`
      SELECT rolbypassrls FROM pg_roles WHERE rolname = 'iptv_app'
    `.execute(ownerDb);
    expect(role.rows[0]?.rolbypassrls).toBe(false);
    const ownedTables = await sql<{ n: string }>`
      SELECT count(*) AS n FROM pg_class c
      JOIN pg_roles r ON r.oid = c.relowner
      WHERE r.rolname = 'iptv_app' AND c.relkind = 'r'
    `.execute(ownerDb);
    expect(Number(ownedTables.rows[0]?.n ?? "-1")).toBe(0);
    const ownedFunctions = await sql<{ n: string }>`
      SELECT count(*) AS n FROM pg_proc p
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE r.rolname = 'iptv_app'
    `.execute(ownerDb);
    expect(Number(ownedFunctions.rows[0]?.n ?? "-1")).toBe(0);
  });

  it("chargeback via webhook records CHARGEBACK + loss reversal (owner-pool evidence ONLY — not an iptv_app claim)", async () => {
    // Complementary evidence: proves the domain behavior pre-cutover on the
    // owner pool. The full webhook path under `iptv_app` is NOT certified
    // here (P1-exit gate: the bus writes through the platform outbox).
    const tenantKey = await setupAsaasChannel(tenantA);
    const personId = await makePerson(actorA());
    const planId = await seedPlan(tenantA, "1000");
    const orderId = await quoteAndSubmit(actorA(), personId, planId);
    const { providerChargeId } = await createCharge(actorA(), orderId);
    const paid = await postAsaas(tenantKey, paidPayload(providerChargeId, `evt-p13-paid-${newId().slice(-12)}`, 10.0));
    expect(paid.statusCode).toBe(202);

    const [payment] = await ownerDb
      .selectFrom("billing.payments")
      .select(["id", "status"])
      .where("tenant_id", "=", tenantA)
      .where("order_id", "=", orderId)
      .execute();
    if (payment === undefined) {
      throw new Error("expected a payment");
    }
    expect(payment.status).toBe("CONFIRMED");

    const cbEventId = `evt-p13-cb-${newId().slice(-12)}`;
    const cb = await postAsaas(tenantKey, {
      event: "PAYMENT_CHARGEBACK",
      id: cbEventId,
      payment: { id: providerChargeId, value: 10.0 },
    });
    expect(cb.statusCode).toBe(202);

    const after = await ownerDb
      .selectFrom("billing.payments")
      .select(["status"])
      .where("tenant_id", "=", tenantA)
      .where("id", "=", payment.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe("CHARGEBACK");

    const exceptions = await ownerDb
      .selectFrom("billing.exceptions")
      .select(["kind", "status"])
      .where("tenant_id", "=", tenantA)
      .where("payment_id", "=", payment.id)
      .where("kind", "=", "CHARGEBACK")
      .execute();
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.status).toBe("OPEN");

    const reversals = await ownerDb
      .selectFrom("finance.financial_transactions")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .where("transaction_type", "=", "CHARGEBACK_REVERSAL")
      .where("reference_type", "=", "payment")
      .where("reference_id", "=", payment.id)
      .execute();
    expect(reversals.length).toBeGreaterThan(0);
  }, 60_000);

  it("chargeback lookup shape resolves on the effective iptv_app pool and fail-closes without context (REAL, bus-isolated)", async () => {
    // REAL but bounded: replays the exact two-table shape of the private
    // `AsaasWebhookService.findPaymentForExternalCharge` on a genuine
    // `iptv_app` session, with NO bus/webhook call. Depends on the
    // paid-then-chargeback tenant from the owner-pool test above for a live
    // binding/payment pair. NOT certified: the private finder itself, nor a
    // full webhook end-to-end under `iptv_app` (P1-exit gate).
    const binding = await ownerDb
      .selectFrom("billing.charge_provider_bindings")
      .select(["tenant_id", "charge_id", "external_charge_id"])
      .where("tenant_id", "=", tenantA)
      .where("provider", "=", "ASAAS")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirstOrThrow();
    const expected = await ownerDb
      .selectFrom("billing.payments")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .where("charge_id", "=", binding.charge_id)
      .executeTakeFirstOrThrow();

    // No tenant context on the effective app pool: fail-closed to 0 rows
    // (the old pool-level shape that silently pushed chargebacks into the
    // unknown-charge fallback).
    const withoutContext = await appDb
      .selectFrom("billing.charge_provider_bindings")
      .select(["charge_id"])
      .where("tenant_id", "=", tenantA)
      .where("provider", "=", "ASAAS")
      .where("external_charge_id", "=", binding.external_charge_id)
      .execute();
    expect(withoutContext).toHaveLength(0);

    // Fixed shape (mirrors findPaymentForExternalCharge): same effective
    // role, inside withTenantTransaction.
    const foundPaymentId = await withTenantTransaction(appDb, tenantA, async (trx) => {
      const found = await trx
        .selectFrom("billing.charge_provider_bindings")
        .select(["charge_id"])
        .where("tenant_id", "=", tenantA)
        .where("provider", "=", "ASAAS")
        .where("external_charge_id", "=", binding.external_charge_id)
        .executeTakeFirst();
      if (found === undefined) {
        return null;
      }
      const payment = await trx
        .selectFrom("billing.payments")
        .select(["id"])
        .where("tenant_id", "=", tenantA)
        .where("charge_id", "=", found.charge_id)
        .executeTakeFirst();
      return payment?.id ?? null;
    });
    expect(foundPaymentId).toBe(expected.id);
  });

  it("billing listings are tenant-isolated over HTTP on the effective iptv_app pool (REAL, guards active)", async () => {
    // Fixtures (charges, CONFIRMED payments, refund requests, exceptions for
    // BOTH tenants) are prepared through the administrative owner path; every
    // read below goes through `app`, whose pool is effectively `iptv_app`
    // with the real Auth/Permissions guards in force (no mocks).
    async function fixturesFor(
      as: CommandActor,
      tenantId: string,
      priceMinor: string,
      paidValue: number,
      tag: string,
    ): Promise<{ chargeId: string; paymentId: string; refundRequestId: string }> {
      const personId = await makePerson(as);
      const planId = await seedPlan(tenantId, priceMinor);
      const orderId = await quoteAndSubmit(as, personId, planId);
      const { providerChargeId, chargeId } = await createCharge(as, orderId);
      const tenantKey = await setupAsaasChannel(tenantId);
      const paid = await postAsaas(
        tenantKey,
        paidPayload(providerChargeId, `evt-p13-iso-paid-${tag}-${newId().slice(-12)}`, paidValue),
      );
      expect(paid.statusCode).toBe(202);
      const payment = await ownerDb
        .selectFrom("billing.payments")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("order_id", "=", orderId)
        .executeTakeFirstOrThrow();
      const refundRequestId = await requestRefund(as, payment.id, `rk-p13-iso-${tag}-${newId().slice(-12)}`);
      // Unknown external charge → tenant-owned exception row.
      const unknown = await postAsaas(
        tenantKey,
        paidPayload(`pay_unknown_p13_${tag}_${newId().slice(-8)}`, `evt-p13-unk-${tag}-${newId().slice(-12)}`, 5.0),
      );
      expect(unknown.statusCode).toBe(202);
      return { chargeId, paymentId: payment.id, refundRequestId };
    }

    const fa = await fixturesFor(actorA(), tenantA, "1000", 10.0, "a");
    const fb = await fixturesFor(actorB(), tenantB, "2000", 20.0, "b");

    // No bypass: unauthenticated reads are denied by the real guards.
    const unauth = await injectRaw(app, { method: "GET", url: "/v1/charges" });
    expect(unauth.statusCode).toBe(401);

    const chargesA = await injectRaw(app, { method: "GET", url: "/v1/charges", token: tokenA });
    expect(chargesA.statusCode).toBe(200);
    const idsA = chargesA.json<{ charges: Array<{ id: string }> }>().charges.map((c) => c.id);
    expect(idsA).toContain(fa.chargeId);
    expect(idsA).not.toContain(fb.chargeId);

    const chargesB = await injectRaw(app, { method: "GET", url: "/v1/charges", token: tokenB });
    expect(chargesB.statusCode).toBe(200);
    const idsB = chargesB.json<{ charges: Array<{ id: string }> }>().charges.map((c) => c.id);
    expect(idsB).toContain(fb.chargeId);
    expect(idsB).not.toContain(fa.chargeId);

    const paymentsA = await injectRaw(app, { method: "GET", url: "/v1/payments", token: tokenA });
    expect(paymentsA.statusCode).toBe(200);
    const payIdsA = paymentsA.json<{ payments: Array<{ id: string }> }>().payments.map((p) => p.id);
    expect(payIdsA).toContain(fa.paymentId);
    expect(payIdsA).not.toContain(fb.paymentId);

    const paymentsB = await injectRaw(app, { method: "GET", url: "/v1/payments", token: tokenB });
    expect(paymentsB.statusCode).toBe(200);
    const payIdsB = paymentsB.json<{ payments: Array<{ id: string }> }>().payments.map((p) => p.id);
    expect(payIdsB).toContain(fb.paymentId);
    expect(payIdsB).not.toContain(fa.paymentId);

    const refundsA = await injectRaw(app, { method: "GET", url: "/v1/refund-requests", token: tokenA });
    expect(refundsA.statusCode).toBe(200);
    const refIdsA = refundsA.json<{ refund_requests: Array<{ id: string }> }>().refund_requests.map((r) => r.id);
    expect(refIdsA).toContain(fa.refundRequestId);
    expect(refIdsA).not.toContain(fb.refundRequestId);

    const refundsB = await injectRaw(app, { method: "GET", url: "/v1/refund-requests", token: tokenB });
    expect(refundsB.statusCode).toBe(200);
    const refIdsB = refundsB.json<{ refund_requests: Array<{ id: string }> }>().refund_requests.map((r) => r.id);
    expect(refIdsB).toContain(fb.refundRequestId);
    expect(refIdsB).not.toContain(fa.refundRequestId);

    const exceptionsA = await injectRaw(app, { method: "GET", url: "/v1/billing-exceptions", token: tokenA });
    expect(exceptionsA.statusCode).toBe(200);
    const exceptionsB = await injectRaw(app, { method: "GET", url: "/v1/billing-exceptions", token: tokenB });
    expect(exceptionsB.statusCode).toBe(200);
    const excA = exceptionsA.json<{ exceptions: Array<{ id: string }> }>().exceptions;
    const excB = exceptionsB.json<{ exceptions: Array<{ id: string }> }>().exceptions;
    expect(excA.length).toBeGreaterThan(0);
    expect(excB.length).toBeGreaterThan(0);
    const excAIds = new Set(excA.map((e) => e.id));
    for (const row of excB) {
      expect(excAIds.has(row.id)).toBe(false);
    }
    const excBIds = new Set(excB.map((e) => e.id));
    for (const row of excA) {
      expect(excBIds.has(row.id)).toBe(false);
    }
  }, 60_000);

  it("billing listing shapes are tenant-isolated under iptv_app at the SQL level (complementary SET ROLE probe)", async () => {
    // Complementary evidence only: approximates the role via SET LOCAL ROLE
    // on the owner session. The genuine-pool assertions above supersede it.
    // charges: B's charge visible under B context, invisible under A context.
    const seenUnderB = await withTenantTransaction(ownerDb, tenantB, async (trx) => {
      await sql`SET LOCAL ROLE iptv_app`.execute(trx);
      return trx.selectFrom("billing.charges").select(["id"]).where("tenant_id", "=", tenantB).execute();
    });
    expect(seenUnderB.length).toBeGreaterThan(0);

    const leakedUnderA = await withTenantTransaction(ownerDb, tenantA, async (trx) => {
      await sql`SET LOCAL ROLE iptv_app`.execute(trx);
      const own = await trx.selectFrom("billing.charges").select(["id"]).where("tenant_id", "=", tenantA).execute();
      const foreign = await trx
        .selectFrom("billing.charges")
        .select(["id"])
        .where("tenant_id", "=", tenantB)
        .execute();
      return { own, foreign };
    });
    expect(leakedUnderA.foreign).toHaveLength(0);

    // payments + exceptions: own rows visible under iptv_app with context.
    const ownReads = await withTenantTransaction(ownerDb, tenantA, async (trx) => {
      await sql`SET LOCAL ROLE iptv_app`.execute(trx);
      const payments = await trx
        .selectFrom("billing.payments")
        .select(["id"])
        .where("tenant_id", "=", tenantA)
        .execute();
      const exceptions = await trx
        .selectFrom("billing.exceptions")
        .select(["id"])
        .where("tenant_id", "=", tenantA)
        .execute();
      return { payments, exceptions };
    });
    expect(ownReads.payments.length).toBeGreaterThan(0);
    expect(ownReads.exceptions.length).toBeGreaterThan(0);
  });
});
