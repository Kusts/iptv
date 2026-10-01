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
import { recomputeAllocations } from "../src/finance/finance-ingest.js";
import { recomputeAnalytics } from "../src/analytics/analytics-projections.js";

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
  "subscription.read",
];

/**
 * MVP final fixes (requires TEST_DATABASE_URL): one tenant per finding so
 * the 600-order ingest flood never pollutes the analytics counts.
 *
 * - Finding 2 (HIGH): >500 settled facts with a repeated default-window
 *   recompute allocate EVERY fact (anti-join before the per-run limit).
 * - Finding 4: zero-value ADJUSTMENT redemptions never inflate
 *   sales.settled_orders; revenue stays consistent.
 * - Finding 5: MESSAGING_COST allocates per successful OUTBOUND delivery
 *   (the real send fact), never per scheduled_contacts SENT.
 */
describe.skipIf(!hasDb)("MVP final fixes: cost ingest + sales projections (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let tenantBulk = "";
  let userBulk = "";
  let tenantSales = "";
  let userSales = "";
  let tenantMsg = "";
  let userMsg = "";
  let bus: CommandBus;
  let drainer: OutboxDrainer;

  function actorFor(tenantId: string, userId: string): CommandActor {
    return {
      userId,
      isPlatformAdmin: false,
      tenantId,
      roleKeys: ["tenant_owner"],
      permissions: PERMISSIONS,
      actorType: "human",
    };
  }

  function inject(opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
      headers["x-tenant-context-revision"] = "0";
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

  async function registerTenant(prefix: string): Promise<{ tenantId: string; userId: string }> {
    const res = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email(prefix), password: "correct-horse-8", tenantName: `${prefix} Tenant` },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ activeTenantId: string; user: { id: string } }>();
    return { tenantId: body.activeTenantId, userId: body.user.id };
  }

  async function makePerson(tenantId: string, userId: string): Promise<string> {
    const result = await bus.execute<{ id: string }>(actorFor(tenantId, userId), "person.register", {
      canonicalName: "Mvfix Person",
    });
    if (!result.ok) {
      throw new Error(`person.register failed: ${result.message}`);
    }
    return result.data.id;
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

    ({ tenantId: tenantBulk, userId: userBulk } = await registerTenant("mvfix-bulk"));
    ({ tenantId: tenantSales, userId: userSales } = await registerTenant("mvfix-sales"));
    ({ tenantId: tenantMsg, userId: userMsg } = await registerTenant("mvfix-msg"));
  }, 120_000);

  afterAll(async () => {
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
    await db.destroy().catch(() => undefined);
  });

  it("finding 2: 600 settled facts fully allocate across repeated default-window recomputes", async () => {
    const personId = await makePerson(tenantBulk, userBulk);
    const base = Date.now() - 600_000;
    const orderRows = [];
    const itemRows = [];
    const snapshotRows = [];
    const txRows = [];
    for (let i = 0; i < 600; i += 1) {
      const orderId = newId();
      const itemId = newId();
      const at = new Date(base + i * 1000);
      orderRows.push({
        id: orderId,
        tenant_id: tenantBulk,
        person_id: personId,
        customer_id: null,
        source_offer_id: null,
        order_type: "NEW_SUBSCRIPTION",
        status: "SETTLED",
        currency: "BRL",
        gross_amount_minor: "6000",
        discount_amount_minor: "0",
        reward_amount_minor: "0",
        net_amount_minor: "6000",
        settled_amount_minor: "6000",
        created_at: at,
        awaiting_payment_at: at,
        settled_at: at,
        cancelled_at: null,
        expires_at: null,
      });
      itemRows.push({
        id: itemId,
        tenant_id: tenantBulk,
        order_id: orderId,
        item_type: "BASE_PLAN",
        sellable_type: "PLAN",
        sellable_id: newId(),
        quantity: "1",
        unit_price_minor: "6000",
        gross_minor: "6000",
        discount_minor: "0",
        reward_minor: "0",
        net_minor: "6000",
        metadata_json: {},
        created_at: at,
      });
      snapshotRows.push({
        id: newId(),
        tenant_id: tenantBulk,
        order_item_id: itemId,
        sale_price_minor: "6000",
        supplier_cost_minor: "1000",
        currency: "BRL",
        price_source_ref: null,
        captured_at: at,
        context_json: {},
      });
      txRows.push({
        id: newId(),
        tenant_id: tenantBulk,
        transaction_type: "ORDER_SETTLEMENT",
        reference_type: "order",
        reference_id: orderId,
        idempotency_key: `mvfix-settle-${orderId}`,
        occurred_at: at,
        recorded_at: at,
        reversal_of_transaction_id: null,
        metadata_json: {},
      });
    }
    for (let i = 0; i < orderRows.length; i += 150) {
      await db.insertInto("commerce.orders").values(orderRows.slice(i, i + 150)).execute();
      await db.insertInto("commerce.order_items").values(itemRows.slice(i, i + 150)).execute();
      await db.insertInto("commerce.price_snapshots").values(snapshotRows.slice(i, i + 150)).execute();
    }
    // Settlement transactions need balanced ledger entries at COMMIT (the
    // migration-005 constraint triggers are DEFERRABLE): DEBIT cash /
    // CREDIT revenue per settlement, inside one transaction per batch.
    const cashAccount = newId();
    const revenueAccount = newId();
    await db
      .insertInto("finance.financial_accounts")
      .values([
        {
          id: cashAccount,
          tenant_id: tenantBulk,
          account_code: "CASH",
          name: "Cash",
          account_type: "ASSET",
          currency: "BRL",
          status: "ACTIVE",
          created_at: new Date(base),
        },
        {
          id: revenueAccount,
          tenant_id: tenantBulk,
          account_code: "REVENUE",
          name: "Revenue",
          account_type: "REVENUE",
          currency: "BRL",
          status: "ACTIVE",
          created_at: new Date(base),
        },
      ])
      .execute();
    for (let i = 0; i < txRows.length; i += 150) {
      const batch = txRows.slice(i, i + 150);
      await db.transaction().execute(async (trx) => {
        await trx.insertInto("finance.financial_transactions").values(batch).execute();
        const entries = batch.flatMap((tx) => [
          {
            id: newId(),
            tenant_id: tenantBulk,
            financial_transaction_id: tx.id,
            financial_account_id: cashAccount,
            direction: "DEBIT",
            amount_minor: "6000",
            currency: "BRL",
            created_at: tx.occurred_at,
          },
          {
            id: newId(),
            tenant_id: tenantBulk,
            financial_transaction_id: tx.id,
            financial_account_id: revenueAccount,
            direction: "CREDIT",
            amount_minor: "6000",
            currency: "BRL",
            created_at: tx.occurred_at,
          },
        ]);
        for (let j = 0; j < entries.length; j += 150) {
          await trx.insertInto("finance.financial_ledger_entries").values(entries.slice(j, j + 150)).execute();
        }
      });
    }

    const first = await recomputeAllocations(db, tenantBulk);
    expect(first.byCostType["SUPPLIER_COGS"]?.inserted).toBe(500);
    const second = await recomputeAllocations(db, tenantBulk);
    // The starved tail (600 - 500) must allocate on the next run, not rot.
    expect(second.byCostType["SUPPLIER_COGS"]?.inserted).toBe(100);

    const total = await db
      .selectFrom("finance.cost_allocations")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("tenant_id", "=", tenantBulk)
      .where("cost_type", "=", "SUPPLIER_COGS")
      .executeTakeFirstOrThrow();
    expect(Number(total.n)).toBe(600);

    const third = await recomputeAllocations(db, tenantBulk);
    expect(third.inserted).toBe(0);
    expect(third.byCostType["SUPPLIER_COGS"]).toBeUndefined();
  }, 120_000);

  it("finding 4: ADJUSTMENT redemptions do not inflate sales.settled_orders", async () => {
    const personId = await makePerson(tenantSales, userSales);
    const now = new Date();
    await db
      .insertInto("commerce.orders")
      .values({
        id: newId(),
        tenant_id: tenantSales,
        person_id: personId,
        customer_id: null,
        source_offer_id: null,
        order_type: "NEW_SUBSCRIPTION",
        status: "SETTLED",
        currency: "BRL",
        gross_amount_minor: "6000",
        discount_amount_minor: "0",
        reward_amount_minor: "0",
        net_amount_minor: "6000",
        settled_amount_minor: "6000",
        created_at: now,
        awaiting_payment_at: now,
        settled_at: now,
        cancelled_at: null,
        expires_at: null,
      })
      .execute();
    // Zero-value redemption order (SPEC §10 shape): gross 5000 covered by
    // reward credit, net/settled 0.
    await db
      .insertInto("commerce.orders")
      .values({
        id: newId(),
        tenant_id: tenantSales,
        person_id: personId,
        customer_id: null,
        source_offer_id: null,
        order_type: "ADJUSTMENT",
        status: "SETTLED",
        currency: "BRL",
        gross_amount_minor: "5000",
        discount_amount_minor: "0",
        reward_amount_minor: "5000",
        net_amount_minor: "0",
        settled_amount_minor: "0",
        created_at: now,
        awaiting_payment_at: now,
        settled_at: now,
        cancelled_at: null,
        expires_at: null,
      })
      .execute();

    await recomputeAnalytics(db, tenantSales);

    const counts = await db
      .selectFrom("analytics.metric_snapshots")
      .select(["value_json"])
      .where("tenant_id", "=", tenantSales)
      .where("metric_key", "=", "sales.settled_orders")
      .execute();
    const totalCount = counts.reduce(
      (acc, r) => acc + Number((r.value_json as { count: number }).count),
      0,
    );
    expect(totalCount).toBe(1);

    const revenues = await db
      .selectFrom("analytics.metric_snapshots")
      .select(["value_json"])
      .where("tenant_id", "=", tenantSales)
      .where("metric_key", "=", "sales.settled_revenue_minor")
      .execute();
    const totalRevenue = revenues.reduce(
      (acc, r) => acc + BigInt((r.value_json as { totalMinor: string }).totalMinor),
      0n,
    );
    expect(totalRevenue).toBe(6000n);
  }, 120_000);

  it("finding 5: MESSAGING_COST allocates per successful OUTBOUND delivery", async () => {
    const personId = await makePerson(tenantMsg, userMsg);
    const scheduledFor = new Date(Date.now() - 3_600_000);
    const sentAt = new Date(Date.now() - 1_800_000);

    const campaignId = newId();
    await db
      .insertInto("growth.campaigns")
      .values({
        id: campaignId,
        tenant_id: tenantMsg,
        campaign_key: `mvfix-${tenantMsg.slice(-8)}`,
        name: "Mvfix Campaign",
        objective: null,
        status: "ACTIVE",
        current_version_id: null,
        created_at: scheduledFor,
        updated_at: scheduledFor,
      })
      .execute();
    const versionId = newId();
    await db
      .insertInto("growth.campaign_versions")
      .values({
        id: versionId,
        tenant_id: tenantMsg,
        campaign_id: campaignId,
        version_no: 1,
        status: "PUBLISHED",
        offer_snapshot_json: {},
        policy_snapshot_json: {},
        budget_cap_minor: "10000",
        unit_cost_minor: "250",
        currency: "BRL",
        published_at: scheduledFor,
        created_at: scheduledFor,
      })
      .execute();
    const intentId = newId();
    await db
      .insertInto("communication.message_intents")
      .values({
        id: intentId,
        tenant_id: tenantMsg,
        campaign_id: campaignId,
        campaign_version_id: versionId,
        audience_id: null,
        channel: "WHATSAPP",
        purpose_key: "MARKETING",
        template_ref: null,
        idempotency_key: `mvfix-intent-${tenantMsg.slice(-8)}`,
        scheduled_for: scheduledFor,
        status: "SCHEDULED",
        created_at: scheduledFor,
        updated_at: scheduledFor,
      })
      .execute();
    // One contact WITH a real send, one scheduled contact with no send.
    await db
      .insertInto("communication.scheduled_contacts")
      .values({
        id: newId(),
        tenant_id: tenantMsg,
        intent_id: intentId,
        person_id: personId,
        channel: "WHATSAPP",
        scheduled_for: scheduledFor,
        status: "SCHEDULED",
        block_reason: null,
        estimated_cost_minor: "250",
        sent_at: null,
        created_at: scheduledFor,
      })
      .execute();

    const conversationId = newId();
    await db
      .insertInto("communication.conversations")
      .values({
        id: conversationId,
        tenant_id: tenantMsg,
        person_id: personId,
        channel: "WHATSAPP",
        external_thread_id: null,
        status: "OPEN",
        control_mode: "HUMAN_CONTROL",
        last_message_at: sentAt,
        created_at: scheduledFor,
        updated_at: sentAt,
        resolved_at: null,
        archived_at: null,
      })
      .execute();
    const messageId = newId();
    await db
      .insertInto("communication.messages")
      .values({
        id: messageId,
        tenant_id: tenantMsg,
        conversation_id: conversationId,
        person_id: personId,
        direction: "OUTBOUND",
        channel: "WHATSAPP",
        sender_type: "HUMAN",
        external_message_id: null,
        idempotency_key: null,
        content_type: "TEXT",
        body_text: "mvfix hello",
        attachment_ref: null,
        metadata_json: {},
        occurred_at: sentAt,
        received_at: null,
        created_at: sentAt,
      })
      .execute();
    const deliveryId = newId();
    await db
      .insertInto("communication.message_deliveries")
      .values({
        id: deliveryId,
        tenant_id: tenantMsg,
        message_id: messageId,
        provider: "echo",
        status: "SENT",
        attempt_no: 1,
        external_delivery_id: null,
        error_code: null,
        error_detail_json: {},
        occurred_at: sentAt,
      })
      .execute();

    const first = await recomputeAllocations(db, tenantMsg);
    expect(first.byCostType["MESSAGING_COST"]?.inserted).toBe(1);

    const rows = await db
      .selectFrom("finance.cost_allocations")
      .select(["allocation_target_type", "allocation_target_id", "amount_minor"])
      .where("tenant_id", "=", tenantMsg)
      .where("cost_type", "=", "MESSAGING_COST")
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.allocation_target_type).toBe("MESSAGE_DELIVERY");
    expect(rows[0]?.allocation_target_id).toBe(deliveryId);
    expect(rows[0]?.amount_minor).toBe("250");
    expect(rows.some((r) => r.allocation_target_type === "SCHEDULED_CONTACT")).toBe(false);

    // Replay is idempotent: the anti-join excludes the allocated delivery
    // before the limit, so there is nothing left to tally.
    const replay = await recomputeAllocations(db, tenantMsg);
    expect(replay.inserted).toBe(0);
    expect(replay.byCostType["MESSAGING_COST"]).toBeUndefined();
    const again = await db
      .selectFrom("finance.cost_allocations")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("tenant_id", "=", tenantMsg)
      .where("cost_type", "=", "MESSAGING_COST")
      .executeTakeFirstOrThrow();
    expect(Number(again.n)).toBe(1);
  }, 120_000);
});
