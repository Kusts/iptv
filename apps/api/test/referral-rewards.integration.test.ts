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

const ASAAS_SECRET = "wave12-test-asaas-secret";

describe.skipIf(!hasDb)("Wave 12 Referral + Rewards (requires TEST_DATABASE_URL)", () => {
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
      canonicalName: "Wave12 Person",
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
        product_key: `svc-${suffix}`,
        name: "Wave12 Service",
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
        plan_key: `monthly-${suffix}`,
        name: "Wave12 Monthly",
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

  async function settleOrder(orderId: string, amount: number): Promise<void> {
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
    const created = await bus.execute<{ id: string; providerChargeId: string | null }>(
      actor(),
      "charge.create",
      { orderId },
    );
    if (!created.ok || created.data.providerChargeId === null) {
      throw new Error(`charge.create failed: ${JSON.stringify(created)}`);
    }
    const delivered = await injectRaw({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}`,
      headers: { "x-asaas-secret": ASAAS_SECRET },
      payload: {
        event: "PAYMENT_RECEIVED",
        id: `evt-w12-${newId().replace(/-/g, "").slice(-12)}`,
        payment: { id: created.data.providerChargeId, value: amount, currency: "BRL" },
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

  /** Operator-configured program fixture (mirrors seed 001's Referral Pilot). */
  async function ensureProgram(forTenantId: string): Promise<string> {
    const programId = newId();
    await db
      .insertInto("referral.referral_programs")
      .values({
        id: programId,
        tenant_id: forTenantId,
        name: "Wave12 Test Program",
        status: "ACTIVE",
        rules_version: "test-v1",
        rules_json: {},
        starts_at: new Date(Date.now() - 60_000),
        ends_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    return programId;
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    delete process.env["PROVIDER_OPS_ADAPTER"];
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);
    drainer = app.get(OutboxDrainer);

    const register = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w12"), password: "correct-horse-8", tenantName: "Wave12 Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;
    await ensureProgram(tenantId);
  });

  afterAll(async () => {
    if (hasDb && drainer !== undefined) {
      await drainer.drain(1000).catch(() => undefined);
    }
    await app?.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
  });

  it("happy path: create → qualify via settled order → issue → redeem zero-value → balanced ledger", async () => {
    const planId = await seedPlan("3000");
    // Advocate converts first (creates the advocate customer row).
    const advocatePerson = await makePerson();
    await settleOrder(await quoteAndSubmit(advocatePerson, planId), 30.0);
    const advocateCustomer = await customerIdForPerson(advocatePerson);

    // Referred person registers, then is attributed (first-touch).
    const referredPerson = await makePerson();
    const created = await injectRaw({
      method: "POST",
      url: `/v1/customers/${advocateCustomer}/referrals`,
      token,
      headers: { "idempotency-key": `w12-${newId()}` },
      payload: { referredPersonId: referredPerson, referredIdentity: { type: "EMAIL", value: "x@y.z" } },
    });
    expect(created.statusCode).toBe(201);
    const referral = created.json<{ id: string; status: string; already: boolean }>();
    expect(referral.status).toBe("ATTRIBUTED");
    expect(referral.already).toBe(false);

    // Late duplicate for the same (program, person) returns first-touch.
    const duplicate = await injectRaw({
      method: "POST",
      url: `/v1/customers/${advocateCustomer}/referrals`,
      token,
      payload: { referredPersonId: referredPerson, referredIdentity: { type: "EMAIL", value: "x@y.z" } },
    });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json<{ id: string; already: boolean }>().id).toBe(referral.id);
    expect(duplicate.json<{ already: boolean }>().already).toBe(true);

    // Reads: list + get (tenant-scoped).
    const listed = await injectRaw({
      method: "GET",
      url: `/v1/customers/${advocateCustomer}/referrals`,
      token,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ items: unknown[] }>().items.length).toBeGreaterThanOrEqual(1);
    const fetched = await injectRaw({ method: "GET", url: `/v1/referrals/${referral.id}`, token });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json<{ status: string }>().status).toBe("ATTRIBUTED");

    // Conversion AFTER attribution (inside the qualification window).
    await settleOrder(await quoteAndSubmit(referredPerson, planId), 30.0);
    const qualified = await injectRaw({
      method: "POST",
      url: `/v1/referrals/${referral.id}/qualification`,
      token,
      payload: { policyVersion: "v1" },
    });
    expect(qualified.statusCode).toBe(201);
    const qual = qualified.json<{ decision: string; referralStatus: string; rewardId: string; already: boolean }>();
    expect(qual.decision).toBe("ALLOW");
    expect(qual.referralStatus).toBe("CONFIRMED");
    expect(typeof qual.rewardId).toBe("string");

    // Replay x10: no double reward, no double ledger row.
    for (let i = 0; i < 10; i += 1) {
      const replay = await bus.execute<{ already: boolean; decision: string }>(actor(), "referral.qualify", {
        referralId: referral.id,
        policyVersion: "v1",
      });
      if (!replay.ok) {
        throw new Error(`replay ${i} failed: ${JSON.stringify(replay)}`);
      }
      expect(replay.data.already).toBe(true);
      expect(replay.data.decision).toBe("ALLOW");
    }
    const rewardLinks = await db
      .selectFrom("referral.referral_reward_links")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("referral_id", "=", referral.id)
      .execute();
    expect(rewardLinks.length).toBe(1);
    const earned = await db
      .selectFrom("loyalty.reward_ledger_entries")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("reward_id", "=", qual.rewardId)
      .where("entry_type", "=", "EARNED")
      .execute();
    expect(earned.length).toBe(1);

    // Redeem: zero-value order settles with NO payment row.
    const redeemed = await injectRaw({
      method: "POST",
      url: `/v1/rewards/${qual.rewardId}/redeem`,
      token,
      headers: { "idempotency-key": `w12-redeem-${newId()}` },
      payload: {},
    });
    expect(redeemed.statusCode).toBe(201);
    const rewardView = redeemed.json<{ status: string; orderId: string }>();
    expect(rewardView.status).toBe("REDEEMED");
    const redemptionOrder = await db
      .selectFrom("commerce.orders")
      .select(["status", "net_amount_minor", "reward_amount_minor", "settled_amount_minor"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", rewardView.orderId)
      .executeTakeFirstOrThrow();
    expect(redemptionOrder.status).toBe("SETTLED");
    expect(String(redemptionOrder.net_amount_minor)).toBe("0");
    expect(String(redemptionOrder.reward_amount_minor)).toBe("3000");
    const payments = await db
      .selectFrom("billing.payments")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("order_id", "=", rewardView.orderId)
      .execute();
    expect(payments.length).toBe(0);

    // Ledger reconciles to zero outstanding (CA-10).
    const entries = await db
      .selectFrom("loyalty.reward_ledger_entries")
      .select(["amount_minor"])
      .where("tenant_id", "=", tenantId)
      .where("reward_id", "=", qual.rewardId)
      .execute();
    const total = entries.reduce((acc, e) => acc + BigInt(String(e.amount_minor ?? 0)), 0n);
    expect(total).toBe(0n);
  });

  it("self-referral is rejected", async () => {
    const planId = await seedPlan("3000");
    const person = await makePerson();
    await settleOrder(await quoteAndSubmit(person, planId), 30.0);
    const customer = await customerIdForPerson(person);
    const res = await injectRaw({
      method: "POST",
      url: `/v1/customers/${customer}/referrals`,
      token,
      payload: { referredPersonId: person, referredIdentity: { type: "EMAIL", value: "s@s.z" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(/self-referral/i);
  });

  it("cross-tenant referral access is denied", async () => {
    const planId = await seedPlan("3000");
    const advocatePerson = await makePerson();
    await settleOrder(await quoteAndSubmit(advocatePerson, planId), 30.0);
    const advocateCustomer = await customerIdForPerson(advocatePerson);
    const referredPerson = await makePerson();
    const created = await bus.execute<{ id: string }>(actor(), "referral.create", {
      customerId: advocateCustomer,
      referredPersonId: referredPerson,
    });
    if (!created.ok) {
      throw new Error(`referral.create failed: ${JSON.stringify(created)}`);
    }
    // Second tenant: fresh register → isolated context.
    const other = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w12b"), password: "correct-horse-8", tenantName: "Wave12 Other" },
    });
    expect(other.statusCode).toBe(201);
    const otherToken = other.json<{ token: string }>().token;
    const otherTenantId = other.json<{ activeTenantId: string }>().activeTenantId;
    await ensureProgram(otherTenantId);
    const read = await injectRaw({ method: "GET", url: `/v1/referrals/${created.data.id}`, token: otherToken });
    expect(read.statusCode).toBe(404);
    const createForeign = await injectRaw({
      method: "POST",
      url: `/v1/customers/${advocateCustomer}/referrals`,
      token: otherToken,
      payload: { referredPersonId: referredPerson, referredIdentity: { type: "EMAIL", value: "f@f.z" } },
    });
    expect(createForeign.statusCode).toBe(404);
  });

  it("manual reversal revokes rewards with compensating entries (history preserved)", async () => {
    const planId = await seedPlan("3000");
    const advocatePerson = await makePerson();
    await settleOrder(await quoteAndSubmit(advocatePerson, planId), 30.0);
    const advocateCustomer = await customerIdForPerson(advocatePerson);
    const referredPerson = await makePerson();
    const created = await bus.execute<{ id: string }>(actor(), "referral.create", {
      customerId: advocateCustomer,
      referredPersonId: referredPerson,
    });
    if (!created.ok) {
      throw new Error(`referral.create failed: ${JSON.stringify(created)}`);
    }
    await settleOrder(await quoteAndSubmit(referredPerson, planId), 30.0);
    const qualified = await bus.execute<{ decision: string; rewardId: string }>(actor(), "referral.qualify", {
      referralId: created.data.id,
      policyVersion: "v1",
    });
    if (!qualified.ok || qualified.data.decision !== "ALLOW") {
      throw new Error(`referral.qualify failed: ${JSON.stringify(qualified)}`);
    }
    const reversed = await bus.execute<{ status: string; revokedRewards: string[] }>(
      actor(),
      "referral.reverse",
      { referralId: created.data.id, reason: "test-window-refund" },
    );
    if (!reversed.ok) {
      throw new Error(`referral.reverse failed: ${JSON.stringify(reversed)}`);
    }
    expect(reversed.data.status).toBe("REVERSED");
    expect(reversed.data.revokedRewards).toContain(qualified.data.rewardId);
    // Append-only: EARNED + REVERSAL rows both present, netting to zero.
    const entries = await db
      .selectFrom("loyalty.reward_ledger_entries")
      .select(["entry_type", "amount_minor"])
      .where("tenant_id", "=", tenantId)
      .where("reward_id", "=", qualified.data.rewardId)
      .orderBy("created_at", "asc")
      .execute();
    const types = entries.map((e) => e.entry_type);
    expect(types).toContain("EARNED");
    expect(types).toContain("REVERSAL");
    const total = entries.reduce((acc, e) => acc + BigInt(String(e.amount_minor ?? 0)), 0n);
    expect(total).toBe(0n);
    // Idempotent reverse.
    const again = await bus.execute<{ already: boolean }>(actor(), "referral.reverse", {
      referralId: created.data.id,
    });
    if (!again.ok || !again.data.already) {
      throw new Error(`second reverse failed: ${JSON.stringify(again)}`);
    }
  });

  it("gift pass redeem: happy path, self-redemption denied, foreign code 404", async () => {
    const planId = await seedPlan("3000");
    const advocatePerson = await makePerson();
    await settleOrder(await quoteAndSubmit(advocatePerson, planId), 30.0);
    const advocateCustomer = await customerIdForPerson(advocatePerson);
    const referredPerson = await makePerson();
    const code = `GIFT-${newId().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
    await db
      .insertInto("loyalty.gift_passes")
      .values({
        id: newId(),
        tenant_id: tenantId,
        issued_to_customer_id: advocateCustomer,
        source_reward_id: null,
        code,
        status: "AVAILABLE",
        benefit_json: { kind: "trial" },
        expires_at: new Date(Date.now() + 7 * 86_400_000),
        redeemed_by_person_id: null,
        redeemed_at: null,
        created_at: new Date(),
      })
      .execute();
    // Self-redemption (issuer redeems their own pass) is denied.
    const self = await injectRaw({
      method: "POST",
      url: "/v1/gift-passes/redeem",
      token,
      payload: { code, personId: advocatePerson },
    });
    expect(self.statusCode).toBe(400);
    // Foreign code → 404 (tenant-scoped).
    const foreign = await injectRaw({
      method: "POST",
      url: "/v1/gift-passes/redeem",
      token,
      payload: { code: `NOPE-${code}`, personId: referredPerson },
    });
    expect(foreign.statusCode).toBe(404);
    // Happy path.
    const redeemed = await injectRaw({
      method: "POST",
      url: "/v1/gift-passes/redeem",
      token,
      headers: { "idempotency-key": `w12-gp-${newId()}` },
      payload: { code, personId: referredPerson },
    });
    expect(redeemed.statusCode).toBe(201);
    expect(redeemed.json<{ status: string }>().status).toBe("REDEEMED");
    // Replay by the same person is idempotent.
    const replay = await injectRaw({
      method: "POST",
      url: "/v1/gift-passes/redeem",
      token,
      payload: { code, personId: referredPerson },
    });
    expect(replay.statusCode).toBe(201);
  });

  it("expire_due closes past-expiry rewards and gift passes", async () => {
    const planId = await seedPlan("3000");
    const advocatePerson = await makePerson();
    await settleOrder(await quoteAndSubmit(advocatePerson, planId), 30.0);
    const advocateCustomer = await customerIdForPerson(advocatePerson);
    const definitionId = newId();
    await db
      .insertInto("loyalty.reward_definitions")
      .values({
        id: definitionId,
        tenant_id: tenantId,
        reward_key: `test-credit-${definitionId.slice(0, 8)}`,
        reward_type: "ORDER_CREDIT",
        status: "ACTIVE",
        perceived_value_minor: "1000",
        estimated_cost_minor: "1000",
        currency: "BRL",
        recurring_cost_policy: null,
        rules_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const rewardId = newId();
    await db
      .insertInto("loyalty.rewards")
      .values({
        id: rewardId,
        tenant_id: tenantId,
        customer_id: advocateCustomer,
        reward_definition_id: definitionId,
        source_type: "test",
        source_id: null,
        status: "AVAILABLE",
        economic_value_minor: "1000",
        estimated_cost_minor: "1000",
        currency: "BRL",
        issued_at: new Date(Date.now() - 3_600_000),
        available_at: new Date(Date.now() - 3_600_000),
        redeemed_at: null,
        expires_at: new Date(Date.now() - 1000),
        revoked_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto("loyalty.reward_ledger_entries")
      .values({
        id: newId(),
        tenant_id: tenantId,
        customer_id: advocateCustomer,
        reward_id: rewardId,
        entry_type: "EARNED",
        amount_minor: "1000",
        points_delta: null,
        currency: "BRL",
        idempotency_key: `test-earn:${rewardId}`,
        reference_type: null,
        reference_id: null,
        created_at: new Date(),
      })
      .execute();
    const passCode = `EXP-${newId().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
    await db
      .insertInto("loyalty.gift_passes")
      .values({
        id: newId(),
        tenant_id: tenantId,
        issued_to_customer_id: advocateCustomer,
        source_reward_id: null,
        code: passCode,
        status: "AVAILABLE",
        benefit_json: {},
        expires_at: new Date(Date.now() - 1000),
        redeemed_by_person_id: null,
        redeemed_at: null,
        created_at: new Date(),
      })
      .execute();
    const expired = await bus.execute<{ expiredRewards: string[]; expiredGiftPasses: string[] }>(
      actor(),
      "referral.expire_due",
      { limit: 100 },
    );
    if (!expired.ok) {
      throw new Error(`referral.expire_due failed: ${JSON.stringify(expired)}`);
    }
    expect(expired.data.expiredRewards).toContain(rewardId);
    expect(expired.data.expiredGiftPasses.length).toBeGreaterThanOrEqual(1);
  });

  it("concurrent double redeem mints a single order and ledger entry (no orphan)", async () => {
    const planId = await seedPlan("3000");
    const advocatePerson = await makePerson();
    await settleOrder(await quoteAndSubmit(advocatePerson, planId), 30.0);
    const advocateCustomer = await customerIdForPerson(advocatePerson);
    const referredPerson = await makePerson();
    const created = await bus.execute<{ id: string }>(actor(), "referral.create", {
      customerId: advocateCustomer,
      referredPersonId: referredPerson,
    });
    if (!created.ok) {
      throw new Error(`referral.create failed: ${JSON.stringify(created)}`);
    }
    await settleOrder(await quoteAndSubmit(referredPerson, planId), 30.0);
    const qualified = await bus.execute<{ decision: string; rewardId: string }>(actor(), "referral.qualify", {
      referralId: created.data.id,
      policyVersion: "v1",
    });
    if (!qualified.ok || qualified.data.decision !== "ALLOW") {
      throw new Error(`referral.qualify failed: ${JSON.stringify(qualified)}`);
    }
    const rewardId = qualified.data.rewardId;
    const countRedemptionOrders = async (): Promise<number> =>
      (
        await db
          .selectFrom("commerce.orders")
          .select(["id"])
          .where("tenant_id", "=", tenantId)
          .where("person_id", "=", advocatePerson)
          .where("order_type", "=", "ADJUSTMENT")
          .execute()
      ).length;
    const before = await countRedemptionOrders();
    const [first, second] = await Promise.all([
      bus.execute<{ already: boolean; orderId: string | null }>(actor(), "reward.redeem", { rewardId }),
      bus.execute<{ already: boolean; orderId: string | null }>(actor(), "reward.redeem", { rewardId }),
    ]);
    // Exactly one winner; the loser replays (already:true) or fails the
    // claim — it must never mint a second order.
    const winners = [first, second].filter((r) => r.ok && !r.data.already);
    expect(winners.length).toBe(1);
    expect((await countRedemptionOrders()) - before).toBe(1);
    const redeemedEntries = await db
      .selectFrom("loyalty.reward_ledger_entries")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("reward_id", "=", rewardId)
      .where("entry_type", "=", "REDEEMED")
      .execute();
    expect(redeemedEntries.length).toBe(1);
  });

  it("cross-advocate first-touch preserves attribution without leaking the row", async () => {
    const planId = await seedPlan("3000");
    const advocateA = await makePerson();
    await settleOrder(await quoteAndSubmit(advocateA, planId), 30.0);
    const customerA = await customerIdForPerson(advocateA);
    const referred = await makePerson();
    const first = await bus.execute<{ id: string; code: string }>(actor(), "referral.create", {
      customerId: customerA,
      referredPersonId: referred,
    });
    if (!first.ok) {
      throw new Error(`referral.create failed: ${JSON.stringify(first)}`);
    }
    const advocateB = await makePerson();
    await settleOrder(await quoteAndSubmit(advocateB, planId), 30.0);
    const customerB = await customerIdForPerson(advocateB);
    const second = await bus.execute(actor(), "referral.create", {
      customerId: customerB,
      referredPersonId: referred,
    });
    expect(second.ok).toBe(false);
    if (second.ok) {
      throw new Error("cross-advocate duplicate unexpectedly succeeded");
    }
    expect(second.code).toBe("precondition_failed");
    const leaked = JSON.stringify(second);
    expect(leaked).not.toContain(customerA);
    expect(leaked).not.toContain(first.data.id);
    expect(leaked).not.toContain(first.data.code);
  });

  it("redemption order never qualifies: explicit candidate errors, auto-discovery skips it", async () => {
    const planId = await seedPlan("3000");
    const advocate = await makePerson();
    await settleOrder(await quoteAndSubmit(advocate, planId), 30.0);
    const advocateCustomer = await customerIdForPerson(advocate);
    const referred = await makePerson();
    const referralAR = await bus.execute<{ id: string }>(actor(), "referral.create", {
      customerId: advocateCustomer,
      referredPersonId: referred,
    });
    if (!referralAR.ok) {
      throw new Error(`referral.create failed: ${JSON.stringify(referralAR)}`);
    }
    const realOrderId = await quoteAndSubmit(referred, planId);
    await settleOrder(realOrderId, 30.0);
    const referredCustomer = await customerIdForPerson(referred);
    const other = await makePerson();
    const referralRX = await bus.execute<{ id: string }>(actor(), "referral.create", {
      customerId: referredCustomer,
      referredPersonId: other,
    });
    if (!referralRX.ok) {
      throw new Error(`referral.create failed: ${JSON.stringify(referralRX)}`);
    }
    await settleOrder(await quoteAndSubmit(other, planId), 30.0);
    const qualifiedRX = await bus.execute<{ decision: string; rewardId: string }>(actor(), "referral.qualify", {
      referralId: referralRX.data.id,
      policyVersion: "v1",
    });
    if (!qualifiedRX.ok || qualifiedRX.data.decision !== "ALLOW") {
      throw new Error(`referral.qualify failed: ${JSON.stringify(qualifiedRX)}`);
    }
    const redeemed = await bus.execute<{ orderId: string | null }>(actor(), "reward.redeem", {
      rewardId: qualifiedRX.data.rewardId,
    });
    if (!redeemed.ok || redeemed.data.orderId === null) {
      throw new Error(`reward.redeem failed: ${JSON.stringify(redeemed)}`);
    }
    const redemptionOrderId = redeemed.data.orderId;
    // Explicit redemption candidate: command error, stays QUALIFYING.
    const bad = await bus.execute(actor(), "referral.qualify", {
      referralId: referralAR.data.id,
      qualifiedOrderId: redemptionOrderId,
      policyVersion: "v1",
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) {
      throw new Error("redemption candidate unexpectedly qualified");
    }
    expect(bad.code).toBe("precondition_failed");
    const row = await db
      .selectFrom("referral.referrals")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", referralAR.data.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("QUALIFYING");
    const openQual = await db
      .selectFrom("referral.referral_qualifications")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("referral_id", "=", referralAR.data.id)
      .where("resolved_at", "is", null)
      .executeTakeFirst();
    expect(openQual).toBeDefined();
    // Auto-discovery skips the (newer) redemption and confirms on the real conversion.
    const good = await bus.execute<{
      decision: string;
      referralStatus: string;
      qualifiedOrderId: string | null;
    }>(actor(), "referral.qualify", { referralId: referralAR.data.id, policyVersion: "v1" });
    if (!good.ok) {
      throw new Error(`referral.qualify failed: ${JSON.stringify(good)}`);
    }
    expect(good.data.decision).toBe("ALLOW");
    expect(good.data.referralStatus).toBe("CONFIRMED");
    expect(good.data.qualifiedOrderId).toBe(realOrderId);
  });

  it("premature/wrong-person candidate is a command error without terminal transition", async () => {
    const planId = await seedPlan("3000");
    const advocate = await makePerson();
    await settleOrder(await quoteAndSubmit(advocate, planId), 30.0);
    const advocateCustomer = await customerIdForPerson(advocate);
    const referred = await makePerson();
    const created = await bus.execute<{ id: string }>(actor(), "referral.create", {
      customerId: advocateCustomer,
      referredPersonId: referred,
    });
    if (!created.ok) {
      throw new Error(`referral.create failed: ${JSON.stringify(created)}`);
    }
    // Unsettled candidate: error, referral stays QUALIFYING with an open qualification.
    const draftOrderId = await quoteAndSubmit(referred, planId);
    const premature = await bus.execute(actor(), "referral.qualify", {
      referralId: created.data.id,
      qualifiedOrderId: draftOrderId,
      policyVersion: "v1",
    });
    expect(premature.ok).toBe(false);
    if (premature.ok) {
      throw new Error("unsettled candidate unexpectedly qualified");
    }
    expect(premature.code).toBe("precondition_failed");
    // Another person's settled order: error, still non-terminal.
    const stranger = await makePerson();
    await settleOrder(await quoteAndSubmit(stranger, planId), 30.0);
    const strangerOrder = await db
      .selectFrom("commerce.orders")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("person_id", "=", stranger)
      .where("status", "=", "SETTLED")
      .orderBy("settled_at", "desc")
      .limit(1)
      .executeTakeFirstOrThrow();
    const mismatched = await bus.execute(actor(), "referral.qualify", {
      referralId: created.data.id,
      qualifiedOrderId: strangerOrder.id,
      policyVersion: "v1",
    });
    expect(mismatched.ok).toBe(false);
    if (mismatched.ok) {
      throw new Error("wrong-person candidate unexpectedly qualified");
    }
    expect(mismatched.code).toBe("precondition_failed");
    const row = await db
      .selectFrom("referral.referrals")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", created.data.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("QUALIFYING");
    // The real conversion still confirms afterwards.
    await settleOrder(draftOrderId, 30.0);
    const good = await bus.execute<{ decision: string; referralStatus: string }>(actor(), "referral.qualify", {
      referralId: created.data.id,
      qualifiedOrderId: draftOrderId,
      policyVersion: "v1",
    });
    if (!good.ok) {
      throw new Error(`referral.qualify failed: ${JSON.stringify(good)}`);
    }
    expect(good.data.decision).toBe("ALLOW");
    expect(good.data.referralStatus).toBe("CONFIRMED");
  });

  it("post-REVIEW re-evaluation opens a fresh qualification instead of failing", async () => {
    const planId = await seedPlan("3000");
    const advocate = await makePerson();
    await settleOrder(await quoteAndSubmit(advocate, planId), 30.0);
    const advocateCustomer = await customerIdForPerson(advocate);
    const referred = await makePerson();
    const created = await bus.execute<{ id: string }>(actor(), "referral.create", {
      customerId: advocateCustomer,
      referredPersonId: referred,
    });
    if (!created.ok) {
      throw new Error(`referral.create failed: ${JSON.stringify(created)}`);
    }
    // Simulate a prior REVIEW: referral parked in QUALIFYING with a resolved qualification.
    await db
      .updateTable("referral.referrals")
      .set({ status: "QUALIFYING" })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", created.data.id)
      .execute();
    const priorId = newId();
    await db
      .insertInto("referral.referral_qualifications")
      .values({
        id: priorId,
        tenant_id: tenantId,
        referral_id: created.data.id,
        status: "REVIEW",
        risk_assessment_id: null,
        reason_codes: ["DUPLICATE_SIGNAL"],
        qualified_order_id: null,
        policy_version: "v1",
        created_at: new Date(),
        resolved_at: new Date(),
      })
      .execute();
    const retry = await bus.execute<{
      decision: string;
      qualificationId: string | null;
      already: boolean;
    }>(actor(), "referral.qualify", { referralId: created.data.id, policyVersion: "v1" });
    if (!retry.ok) {
      throw new Error(`post-REVIEW qualify failed: ${JSON.stringify(retry)}`);
    }
    expect(retry.data.qualificationId).not.toBe(priorId);
    expect(retry.data.decision).toBe("PENDING");
    expect(retry.data.already).toBe(false);
  });
});
