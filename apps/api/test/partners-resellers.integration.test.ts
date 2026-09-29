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

const PERMISSIONS = [
  "crm.person.read",
  "crm.lead.write",
  "commerce.order.write",
];

const TOPICS = [
  "academy-01-product-service",
  "academy-02-devices-apps",
  "academy-03-trials-retrial",
  "academy-04-provisioning",
  "academy-05-support-escalation",
  "academy-06-consultative-sales",
  "academy-07-renewal-retention",
  "academy-08-finance-pricing",
  "academy-09-campaigns-acquisition",
  "academy-10-saas-pathway",
];

describe.skipIf(!hasDb)("Wave 13 Partners/Resellers (requires TEST_DATABASE_URL)", () => {
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

  async function createAccount(displayName: string): Promise<{ id: string; status: string }> {
    const res = await injectRaw({
      method: "POST",
      url: "/v1/partners",
      token,
      headers: { "idempotency-key": `w13-acct-${newId()}` },
      payload: { displayName },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function publishBook(unitPriceMinor: string): Promise<{ id: string }> {
    const result = await bus.execute<{ id: string }>(actor(), "partners.publish_price_book", {
      bookKey: `wholesale-${newId().slice(0, 8)}`,
      unitPriceMinor,
      currency: "BRL",
    });
    if (!result.ok) {
      throw new Error(`publish_price_book failed: ${result.message}`);
    }
    return result.data;
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);
    drainer = app.get(OutboxDrainer);

    const register = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w13"), password: "correct-horse-8", tenantName: "Wave13 Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;
  });

  afterAll(async () => {
    if (hasDb && drainer !== undefined) {
      await drainer.drain(1000).catch(() => undefined);
    }
    await app?.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
  });

  it("G14: onboarding → academy → READY → activate → order settled with 1:1 credit consumption", async () => {
    const account = await createAccount("G14 Reseller");
    expect(account.status).toBe("ONBOARDING");

    const book = await publishBook("3000");

    const topup = await injectRaw({
      method: "POST",
      url: `/v1/partners/${account.id}/credits/topup`,
      token,
      payload: { amountMinor: "10000", currency: "BRL", idempotencyKey: `w13-topup-${newId()}` },
    });
    expect(topup.statusCode).toBe(201);

    const content = await injectRaw({ method: "GET", url: "/v1/academy/content", token });
    expect(content.statusCode).toBe(200);
    expect(content.json<{ items: unknown[] }>().items.length).toBe(10);

    let status = "ONBOARDING";
    for (const topicKey of TOPICS) {
      const progress = await injectRaw({
        method: "POST",
        url: "/v1/academy/progress",
        token,
        payload: { partnerAccountId: account.id, topicKey },
      });
      expect(progress.statusCode).toBe(201);
      status = progress.json<{ status: string }>().status;
    }
    expect(status).toBe("READY");

    const activate = await injectRaw({ method: "POST", url: `/v1/partners/${account.id}/activate`, token });
    expect(activate.statusCode).toBe(201);
    expect(activate.json<{ status: string }>().status).toBe("ACTIVE");

    const order = await injectRaw({
      method: "POST",
      url: "/v1/reseller-orders",
      token,
      payload: { partnerAccountId: account.id, priceBookId: book.id, quantity: 2, idempotencyKey: `w13-order-${newId()}` },
    });
    expect(order.statusCode).toBe(201);
    const settled = order.json<{ id: string; status: string; totalMinor: string }>();
    expect(settled.status).toBe("SETTLED");
    expect(settled.totalMinor).toBe("6000");

    const credits = await injectRaw({ method: "GET", url: `/v1/partners/${account.id}/credits`, token });
    expect(credits.statusCode).toBe(200);
    const balances = credits.json<{ balances: { currency: string; availableMinor: string }[] }>().balances;
    expect(balances).toHaveLength(1);
    expect(balances[0]?.availableMinor).toBe("4000");

    const fetched = await injectRaw({ method: "GET", url: `/v1/reseller-orders/${settled.id}`, token });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json<{ status: string }>().status).toBe("SETTLED");

    const summary = await injectRaw({ method: "GET", url: `/v1/partners/${account.id}/summary`, token });
    expect(summary.statusCode).toBe(200);
    const body = summary.json<{ academy: { completedTopics: number; totalTopics: number }; orders: unknown[] }>();
    expect(body.academy.completedTopics).toBe(10);
    expect(body.academy.totalTopics).toBe(10);
    expect(body.orders.length).toBe(1);
  });

  it("G15: grandparent aggregates direct children only and cannot manage a grandchild", async () => {
    const grandparent = await createAccount("G15 Grandparent");
    const mkChild = await injectRaw({
      method: "POST",
      url: `/v1/partners/${grandparent.id}/children`,
      token,
      payload: { childDisplayName: "G15 Parent" },
    });
    expect(mkChild.statusCode).toBe(201);
    const parentId = mkChild.json<{ childAccountId: string }>().childAccountId as string;

    const mkGrandchild = await injectRaw({
      method: "POST",
      url: `/v1/partners/${parentId}/children`,
      token,
      payload: { childDisplayName: "G15 Child" },
    });
    expect(mkGrandchild.statusCode).toBe(201);
    const childId = mkGrandchild.json<{ childAccountId: string }>().childAccountId as string;

    // Grandparent tries to manage the grandchild → denied (not the direct parent).
    const manage = await injectRaw({
      method: "POST",
      url: `/v1/partners/${childId}/capabilities`,
      token,
      payload: { capabilityKey: "SERVICE_RESELLER", actingParentAccountId: grandparent.id },
    });
    expect(manage.statusCode).toBe(403);

    // Direct parent manages fine.
    const manageOk = await injectRaw({
      method: "POST",
      url: `/v1/partners/${childId}/capabilities`,
      token,
      payload: { capabilityKey: "SERVICE_RESELLER", actingParentAccountId: parentId },
    });
    expect(manageOk.statusCode).toBe(201);

    // Grandparent tries to attach the grandchild directly → denied (already parented).
    const attach = await injectRaw({
      method: "POST",
      url: `/v1/partners/${grandparent.id}/children`,
      token,
      payload: { childAccountId: childId },
    });
    expect(attach.statusCode).toBe(409);

    // Network aggregate of the grandparent lists ONLY the direct child.
    const network = await injectRaw({ method: "GET", url: `/v1/partners/${grandparent.id}/network`, token });
    expect(network.statusCode).toBe(200);
    const ids = network.json<{ directChildren: { id: string }[] }>().directChildren.map((row) => row.id);
    expect(ids).toEqual([parentId]);
    expect(ids).not.toContain(childId);
  });

  it("double-spend: two concurrent orders with credit for one settle exactly one", async () => {
    const account = await createAccount("W13 DoubleSpend");
    const book = await publishBook("5000");
    const topup = await bus.execute(actor(), "partners.topup_credit", {
      partnerAccountId: account.id,
      amountMinor: "5000",
      currency: "BRL",
      idempotencyKey: `w13-ds-topup-${newId()}`,
    });
    if (!topup.ok) {
      throw new Error(`topup failed: ${topup.message}`);
    }
    for (const topicKey of TOPICS) {
      const done = await bus.execute(actor(), "partners.complete_topic", {
        partnerAccountId: account.id,
        topicKey,
      });
      if (!done.ok) {
        throw new Error(`complete_topic failed: ${done.message}`);
      }
    }
    const activated = await bus.execute(actor(), "partners.activate", { partnerAccountId: account.id });
    if (!activated.ok) {
      throw new Error(`activate failed: ${activated.message}`);
    }
    const keyA = `w13-ds-a-${newId()}`;
    const keyB = `w13-ds-b-${newId()}`;
    const inputFor = (key: string) => ({
      partnerAccountId: account.id,
      priceBookId: book.id,
      quantity: 1,
      idempotencyKey: key,
    });
    const [first, second] = await Promise.all([
      bus.execute<{ status: string }>(actor(), "partners.create_reseller_order", inputFor(keyA)),
      bus.execute<{ status: string }>(actor(), "partners.create_reseller_order", inputFor(keyB)),
    ]);
    const settledCount = [first, second].filter((result) => result.ok && result.data.status === "SETTLED").length;
    const blockedCount = [first, second].filter((result) => !result.ok).length;
    expect(settledCount).toBe(1);
    expect(blockedCount).toBe(1);
    const orders = await db
      .selectFrom("partners.reseller_orders")
      .select(["id", "status"])
      .where("tenant_id", "=", tenantId)
      .where("partner_account_id", "=", account.id)
      .execute();
    expect(orders.filter((row) => row.status === "SETTLED")).toHaveLength(1);
  });

  it("relationship cycles are rejected", async () => {
    const a = await createAccount("W13 CycleA");
    const edge = await injectRaw({
      method: "POST",
      url: `/v1/partners/${a.id}/children`,
      token,
      payload: { childDisplayName: "W13 CycleB" },
    });
    expect(edge.statusCode).toBe(201);
    const bId = edge.json<{ childAccountId: string }>().childAccountId as string;
    const cycle = await injectRaw({
      method: "POST",
      url: `/v1/partners/${bId}/children`,
      token,
      payload: { childAccountId: a.id },
    });
    expect(cycle.statusCode).toBe(400);
  });

  it("topup replay with the same idempotency key credits once", async () => {
    const account = await createAccount("W13 Replay");
    const key = `w13-replay-${newId()}`;
    const payload = { amountMinor: "7000", currency: "BRL", idempotencyKey: key };
    const first = await injectRaw({ method: "POST", url: `/v1/partners/${account.id}/credits/topup`, token, payload });
    expect(first.statusCode).toBe(201);
    expect(first.json<{ already: boolean }>().already).toBe(false);
    const second = await injectRaw({ method: "POST", url: `/v1/partners/${account.id}/credits/topup`, token, payload });
    expect(second.statusCode).toBe(201);
    expect(second.json<{ already: boolean }>().already).toBe(true);
    const entries = await db
      .selectFrom("partners.reseller_credit_entries")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("partner_account_id", "=", account.id)
      .where("entry_type", "=", "TOPUP")
      .execute();
    expect(entries).toHaveLength(1);
    const credits = await injectRaw({ method: "GET", url: `/v1/partners/${account.id}/credits`, token });
    expect(credits.json<{ balances: { availableMinor: string }[] }>().balances[0]?.availableMinor).toBe("7000");
  });

  it("w13fix-1: concurrent A→B + B→A hierarchy writes settle exactly one edge, no cycle", async () => {
    const a = await createAccount("W13 RaceA");
    const b = await createAccount("W13 RaceB");
    const relate = (parentId: string, childId: string) =>
      bus.execute<{ relationshipId: string }>(actor(), "partners.create_direct_relationship", {
        parentAccountId: parentId,
        childAccountId: childId,
      });
    const [ab, ba] = await Promise.all([relate(a.id, b.id), relate(b.id, a.id)]);
    const winners = [ab, ba].filter((result) => result.ok);
    expect(winners).toHaveLength(1);
    const edges = await db
      .selectFrom("partners.partner_relationships")
      .select(["parent_account_id", "child_account_id"])
      .where("tenant_id", "=", tenantId)
      .where("status", "=", "ACTIVE")
      .where((eb) =>
        eb.or([
          eb.and([eb("parent_account_id", "=", a.id), eb("child_account_id", "=", b.id)]),
          eb.and([eb("parent_account_id", "=", b.id), eb("child_account_id", "=", a.id)]),
        ]),
      )
      .execute();
    expect(edges).toHaveLength(1);
  });

  it("w13fix-2: partner scope derives from auth membership; cross-branch same-tenant denied", async () => {
    const parent = await createAccount("W13 ScopeParent");
    const mkChild = await injectRaw({
      method: "POST",
      url: `/v1/partners/${parent.id}/children`,
      token,
      payload: { childDisplayName: "W13 ScopeChild" },
    });
    expect(mkChild.statusCode).toBe(201);
    const childId = mkChild.json<{ childAccountId: string }>().childAccountId as string;

    // Acting parent derived from the live edge when the body omits it.
    const derived = await injectRaw({
      method: "POST",
      url: `/v1/partners/${childId}/capabilities`,
      token,
      payload: { capabilityKey: "SERVICE_RESELLER" },
    });
    expect(derived.statusCode).toBe(201);

    // Same tenant, different user, no partner membership → 403 everywhere.
    const stranger: CommandActor = { ...actor(), userId: newId() };
    const manage = await bus.execute(stranger, "partners.set_capability", {
      partnerAccountId: childId,
      capabilityKey: "SERVICE_RESELLER",
      actingParentAccountId: parent.id,
    });
    expect(manage.ok).toBe(false);
    if (!manage.ok) {
      expect(manage.code).toBe("forbidden");
    }
    const topup = await bus.execute(stranger, "partners.topup_credit", {
      partnerAccountId: childId,
      amountMinor: "100",
      currency: "BRL",
      idempotencyKey: `w13-scope-${newId()}`,
    });
    expect(topup.ok).toBe(false);
    if (!topup.ok) {
      expect(topup.code).toBe("forbidden");
    }
    const topic = await bus.execute(stranger, "partners.complete_topic", {
      partnerAccountId: childId,
      topicKey: TOPICS[0] as string,
    });
    expect(topic.ok).toBe(false);
    if (!topic.ok) {
      expect(topic.code).toBe("forbidden");
    }
  });

  it("w13fix-3: standalone reserve surface is gone; holds exist only inside orders", async () => {
    const account = await createAccount("W13 NoReserve");
    const gone = await injectRaw({
      method: "POST",
      url: `/v1/partners/${account.id}/credits/reservations`,
      token,
      payload: { amountMinor: "100", currency: "BRL", idempotencyKey: `w13-nores-${newId()}` },
    });
    expect(gone.statusCode).toBe(404);
    const retired = await bus.execute(actor(), "partners.reserve_credit", {
      partnerAccountId: account.id,
      amountMinor: "100",
      currency: "BRL",
      idempotencyKey: `w13-nores-${newId()}`,
    });
    expect(retired.ok).toBe(false);
  });

  it("w13fix-4: concurrent final academy topics transition to READY exactly once", async () => {
    const account = await createAccount("W13 AcademyRace");
    for (const topicKey of TOPICS.slice(0, 8)) {
      const done = await bus.execute(actor(), "partners.complete_topic", {
        partnerAccountId: account.id,
        topicKey,
      });
      if (!done.ok) {
        throw new Error(`complete_topic failed: ${done.message}`);
      }
    }
    const lastTwo = TOPICS.slice(8);
    const [first, second] = await Promise.all(
      lastTwo.map((topicKey) =>
        bus.execute<{ status: string; completedCount: number }>(actor(), "partners.complete_topic", {
          partnerAccountId: account.id,
          topicKey,
        }),
      ),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const statuses = [first, second].flatMap((result) => (result.ok ? [result.data.status] : []));
    expect(statuses).toContain("READY");
    const counts = [first, second].flatMap((result) => (result.ok ? [result.data.completedCount] : []));
    expect(Math.max(...counts)).toBe(10);
  });

  it("w13fix-5: idempotency key reuse with a divergent payload is rejected", async () => {
    const account = await createAccount("W13 Fingerprint");
    const key = `w13-fp-${newId()}`;
    const first = await bus.execute(actor(), "partners.topup_credit", {
      partnerAccountId: account.id,
      amountMinor: "7000",
      currency: "BRL",
      idempotencyKey: key,
    });
    if (!first.ok) {
      throw new Error(`topup failed: ${first.message}`);
    }
    const divergent = await bus.execute(actor(), "partners.topup_credit", {
      partnerAccountId: account.id,
      amountMinor: "9000",
      currency: "BRL",
      idempotencyKey: key,
    });
    expect(divergent.ok).toBe(false);
    if (!divergent.ok) {
      expect(divergent.code).toBe("precondition_failed");
      expect(divergent.message).toMatch(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
    }
    const entries = await db
      .selectFrom("partners.reseller_credit_entries")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("partner_account_id", "=", account.id)
      .where("entry_type", "=", "TOPUP")
      .execute();
    expect(entries).toHaveLength(1);

    const book = await publishBook("1000");
    for (const topicKey of TOPICS) {
      await bus.execute(actor(), "partners.complete_topic", { partnerAccountId: account.id, topicKey });
    }
    await bus.execute(actor(), "partners.activate", { partnerAccountId: account.id });
    const orderKey = `w13-fp-order-${newId()}`;
    const orderBase = { partnerAccountId: account.id, priceBookId: book.id, idempotencyKey: orderKey };
    const orderFirst = await bus.execute(actor(), "partners.create_reseller_order", { ...orderBase, quantity: 1 });
    if (!orderFirst.ok) {
      throw new Error(`order failed: ${orderFirst.message}`);
    }
    const orderDivergent = await bus.execute(actor(), "partners.create_reseller_order", {
      ...orderBase,
      quantity: 2,
    });
    expect(orderDivergent.ok).toBe(false);
    if (!orderDivergent.ok) {
      expect(orderDivergent.code).toBe("precondition_failed");
      expect(orderDivergent.message).toMatch(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
    }
  });

  it("w13fix-6: order total above BIGINT max is rejected before reserve", async () => {
    const account = await createAccount("W13 Overflow");
    const book = await publishBook("9223372036854775807");
    for (const topicKey of TOPICS) {
      await bus.execute(actor(), "partners.complete_topic", { partnerAccountId: account.id, topicKey });
    }
    await bus.execute(actor(), "partners.activate", { partnerAccountId: account.id });
    const order = await bus.execute(actor(), "partners.create_reseller_order", {
      partnerAccountId: account.id,
      priceBookId: book.id,
      quantity: 2,
      idempotencyKey: `w13-overflow-${newId()}`,
    });
    expect(order.ok).toBe(false);
    if (!order.ok) {
      expect(order.code).toBe("validation_failed");
      expect(order.message).toMatch(/BIGINT/);
    }
    const orders = await db
      .selectFrom("partners.reseller_orders")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("partner_account_id", "=", account.id)
      .execute();
    expect(orders).toHaveLength(0);
  });

  it("insufficient credit blocks the order and tenants are isolated", async () => {
    const account = await createAccount("W13 Blocked");
    const book = await publishBook("9000");
    const topup = await bus.execute(actor(), "partners.topup_credit", {
      partnerAccountId: account.id,
      amountMinor: "1000",
      currency: "BRL",
      idempotencyKey: `w13-blocked-${newId()}`,
    });
    if (!topup.ok) {
      throw new Error(`topup failed: ${topup.message}`);
    }
    for (const topicKey of TOPICS) {
      await bus.execute(actor(), "partners.complete_topic", { partnerAccountId: account.id, topicKey });
    }
    await bus.execute(actor(), "partners.activate", { partnerAccountId: account.id });
    const blocked = await bus.execute(actor(), "partners.create_reseller_order", {
      partnerAccountId: account.id,
      priceBookId: book.id,
      quantity: 1,
      idempotencyKey: `w13-blocked-order-${newId()}`,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.message).toMatch(/BLOCKED/);
    }

    const other = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w13other"), password: "correct-horse-8", tenantName: "Wave13 Other" },
    });
    expect(other.statusCode).toBe(201);
    const otherBody = other.json<{ token: string; activeTenantId: string }>();
    const foreign = await injectRaw({
      method: "GET",
      url: `/v1/partners/${account.id}`,
      token: otherBody.token,
    });
    expect(foreign.statusCode).toBe(404);
    expect(otherBody.activeTenantId).not.toBe(tenantId);
  });
});
