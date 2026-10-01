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
  "agent.review.request",
  "agent.review.decide",
];

const ASAAS_SECRET = "wave5-test-asaas-secret";

describe.skipIf(!hasDb)("Wave 5 Commerce + Billing (requires TEST_DATABASE_URL)", () => {
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
    return {
      userId: approverId,
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
      canonicalName: "Wave5 Person",
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
        name: "Wave5 Service",
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
        name: "Wave5 Monthly",
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

  async function createCharge(orderId: string): Promise<{ chargeId: string; providerChargeId: string }> {
    const created = await bus.execute<{ id: string; status: string; providerChargeId: string | null }>(
      actor(),
      "charge.create",
      { orderId },
    );
    if (!created.ok || created.data.providerChargeId === null) {
      throw new Error(`charge.create failed: ${JSON.stringify(created)}`);
    }
    expect(created.data.status).toBe("PROCESSING");
    return { chargeId: created.data.id, providerChargeId: created.data.providerChargeId };
  }

  async function setupAsaasChannel(): Promise<string> {
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
    return tenantKey;
  }

  function paidPayload(providerChargeId: string, eventId: string, value: number | string): Record<string, unknown> {
    return {
      event: "PAYMENT_RECEIVED",
      id: eventId,
      payment: { id: providerChargeId, value, currency: "BRL" },
    };
  }

  async function postAsaas(tenantKey: string, payload: Record<string, unknown>, secret = ASAAS_SECRET) {
    return injectRaw({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}`,
      headers: { "asaas-access-token": secret },
      payload,
    });
  }

  async function paymentsForOrder(orderId: string) {
    return db
      .selectFrom("billing.payments")
      .select(["id", "status", "amount_minor"])
      .where("tenant_id", "=", tenantId)
      .where("order_id", "=", orderId)
      .execute();
  }

  /** Every finance transaction of this tenant must balance per currency. */
  async function assertLedgerBalancedDb(): Promise<void> {
    const txs = await db
      .selectFrom("finance.financial_transactions")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .execute();
    expect(txs.length).toBeGreaterThan(0);
    for (const tx of txs) {
      const entries = await db
        .selectFrom("finance.financial_ledger_entries")
        .select(["direction", "amount_minor", "currency"])
        .where("tenant_id", "=", tenantId)
        .where("financial_transaction_id", "=", tx.id)
        .execute();
      expect(entries.length).toBeGreaterThanOrEqual(2);
      const net = new Map<string, bigint>();
      for (const e of entries) {
        const amount = BigInt(e.amount_minor);
        expect(amount > 0n).toBe(true);
        const signed = e.direction === "DEBIT" ? amount : -amount;
        net.set(e.currency, (net.get(e.currency) ?? 0n) + signed);
      }
      for (const [, value] of net) {
        expect(value).toBe(0n);
      }
    }
  }

  async function requestRefund(paymentId: string, amountMinor: string, key: string) {
    return bus.execute<{ id: string; status: string; reviewRequestId: string }>(actor(), "refund.request", {
      paymentId,
      amountMinor,
      currency: "BRL",
      reason: "customer asked for a partial refund",
      idempotencyKey: key,
    });
  }

  async function approveRefund(reviewRequestId: string) {
    return bus.execute(approver(), "human_review.approve", { requestId: reviewRequestId });
  }

  async function executeRefund(refundRequestId: string) {
    return bus.execute<{ refundId: string; status: string; effectCertainty: string }>(
      actor(),
      "refund.execute_approved",
      { refundRequestId },
    );
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
    delete process.env["REFUND_APPROVAL_TTL_HOURS"];
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);
    drainer = app.get(OutboxDrainer);

    const register = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w5"), password: "correct-horse-8", tenantName: "Wave5 Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;

    // Second tenant member: the refund approver (requester cannot self-approve,
    // and review actions FK to a real membership).
    approverId = newId();
    await db
      .insertInto("control.users")
      .values({
        id: approverId,
        auth_subject: `email:${email("w5second")}`,
        display_name: "Wave5 Approver",
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
    delete process.env["ASAAS_ECHO_CREATE"];
    delete process.env["ASAAS_ECHO_RECONCILE"];
    delete process.env["ASAAS_ECHO_REFUND"];
    delete process.env["ASAAS_ECHO_REFUND_RECONCILE"];
    delete process.env["REFUND_APPROVAL_TTL_HOURS"];
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

  it("happy path: quote → submit → charge → webhook PAID → payment → balanced ledger → SETTLED → customer (idempotent)", async () => {
    const tenantKey = await setupAsaasChannel();
    const personId = await makePerson();
    const planId = await seedPlan("3000");
    const { orderId, net } = await quoteAndSubmit(personId, planId, 2);
    expect(net).toBe("6000");

    const { chargeId, providerChargeId } = await createCharge(orderId);
    const eventId = `evt-happy-${newId().slice(-12)}`;
    const delivered = await postAsaas(tenantKey, paidPayload(providerChargeId, eventId, 60.0));
    expect(delivered.statusCode).toBe(202);
    expect(delivered.json<{ deduped: boolean }>().deduped).toBe(false);

    const payments = await paymentsForOrder(orderId);
    expect(payments).toHaveLength(1);
    const [confirmed] = payments;
    if (confirmed === undefined) {
      throw new Error("expected a payment");
    }
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.amount_minor).toBe("6000");

    const charge = await db
      .selectFrom("billing.charges")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", chargeId)
      .executeTakeFirstOrThrow();
    expect(charge.status).toBe("PAID");

    await assertLedgerBalancedDb();

    const order = await db
      .selectFrom("commerce.orders")
      .select(["status", "settled_amount_minor"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", orderId)
      .executeTakeFirstOrThrow();
    expect(order.status).toBe("SETTLED");
    expect(order.settled_amount_minor).toBe("6000");

    const customers = await db
      .selectFrom("crm.customers")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("person_id", "=", personId)
      .execute();
    expect(customers).toHaveLength(1);

    // A second settled order for the same person converts idempotently.
    const second = await quoteAndSubmit(personId, planId, 1);
    const secondCharge = await createCharge(second.orderId);
    const again = await postAsaas(
      tenantKey,
      paidPayload(secondCharge.providerChargeId, `evt-happy2-${newId().slice(-12)}`, 30.0),
    );
    expect(again.statusCode).toBe(202);
    const customersAfter = await db
      .selectFrom("crm.customers")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("person_id", "=", personId)
      .execute();
    expect(customersAfter).toHaveLength(1);

    const got = await injectRaw({ method: "GET", url: `/v1/orders/${orderId}`, token });
    expect(got.statusCode).toBe(200);
    expect(got.json<{ order: { status: string } }>().order.status).toBe("SETTLED");
  });

  it("duplicate webhook delivery is a no-op (inbox dedupe + idempotent confirm)", async () => {
    const tenantKey = await setupAsaasChannel();
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const { orderId } = await quoteAndSubmit(personId, planId, 1);
    const { providerChargeId } = await createCharge(orderId);
    const eventId = `evt-dupe-${newId().slice(-12)}`;
    const first = await postAsaas(tenantKey, paidPayload(providerChargeId, eventId, 10.0));
    expect(first.statusCode).toBe(202);

    const txCount = (
      await db
        .selectFrom("finance.financial_transactions")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .execute()
    ).length;

    const second = await postAsaas(tenantKey, paidPayload(providerChargeId, eventId, 10.0));
    expect(second.statusCode).toBe(202);
    expect(second.json<{ deduped: boolean }>().deduped).toBe(true);

    expect(await paymentsForOrder(orderId)).toHaveLength(1);
    const txCountAfter = (
      await db
        .selectFrom("finance.financial_transactions")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .execute()
    ).length;
    expect(txCountAfter).toBe(txCount);
    await assertLedgerBalancedDb();
  });

  it("tampered webhook amounts become exceptions (never a confirmation)", async () => {
    const tenantKey = await setupAsaasChannel();
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const { orderId } = await quoteAndSubmit(personId, planId, 1);
    const { chargeId, providerChargeId } = await createCharge(orderId);

    const tampered = await postAsaas(
      tenantKey,
      paidPayload(providerChargeId, `evt-tamper-${newId().slice(-12)}`, 10.01),
    );
    expect(tampered.statusCode).toBe(202);

    expect(await paymentsForOrder(orderId)).toHaveLength(0);
    const charge = await db
      .selectFrom("billing.charges")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", chargeId)
      .executeTakeFirstOrThrow();
    expect(charge.status).toBe("PROCESSING");

    const exceptions = await db
      .selectFrom("billing.exceptions")
      .select(["id", "kind", "status"])
      .where("tenant_id", "=", tenantId)
      .where("charge_id", "=", chargeId)
      .where("kind", "=", "AMOUNT_MISMATCH")
      .execute();
    expect(exceptions).toHaveLength(1);
    const [mismatch] = exceptions;
    if (mismatch === undefined) {
      throw new Error("expected an exception");
    }
    expect(mismatch.status).toBe("OPEN");

    const resolved = await bus.execute(actor(), "billing.exception_resolve", {
      exceptionId: mismatch.id,
      decision: "RESOLVED",
    });
    expect(resolved.ok).toBe(true);
  });

  it("webhook for an unknown external charge becomes an exception (still 202)", async () => {
    const tenantKey = await setupAsaasChannel();
    const delivered = await postAsaas(
      tenantKey,
      paidPayload("pay_unknown_xyz", `evt-unknown-${newId().slice(-12)}`, 5.0),
    );
    expect(delivered.statusCode).toBe(202);
    const rows = await db
      .selectFrom("billing.exceptions")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("kind", "=", "UNKNOWN_CHARGE")
      .where("status", "=", "OPEN")
      .execute();
    expect(rows.length).toBeGreaterThan(0);
  });

  it("webhook auth rejects bad secrets and unknown endpoints", async () => {
    const tenantKey = await setupAsaasChannel();
    const badSecret = await postAsaas(tenantKey, paidPayload("pay_x", "evt-x", 1.0), "wrong-secret");
    expect(badSecret.statusCode).toBe(401);
    const unknown = await postAsaas("no-such-endpoint", paidPayload("pay_x", "evt-x", 1.0));
    expect(unknown.statusCode).toBe(404);
  });

  it("legacy x-asaas-secret alias still authenticates", async () => {
    const tenantKey = await setupAsaasChannel();
    const delivered = await injectRaw({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}`,
      headers: { "x-asaas-secret": ASAAS_SECRET },
      payload: paidPayload("pay_legacy_xyz", `evt-legacy-${newId().slice(-12)}`, 5.0),
    });
    expect(delivered.statusCode).toBe(202);
  });

  it("canonical asaas-access-token takes precedence over the legacy alias", async () => {
    const tenantKey = await setupAsaasChannel();
    const rejected = await injectRaw({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}`,
      headers: { "asaas-access-token": "wrong-secret", "x-asaas-secret": ASAAS_SECRET },
      payload: paidPayload("pay_x", "evt-x", 1.0),
    });
    expect(rejected.statusCode).toBe(401);
  });

  it("shared ASAAS_WEBHOOK_SECRET fallback no longer authenticates a channel without a secret (503)", async () => {
    const tenantKey = `asaas-${newId().replace(/-/g, "").slice(-12)}`;
    await db
      .insertInto("billing.tenant_channels")
      .values({
        id: newId(),
        tenant_id: tenantId,
        channel: "ASAAS",
        tenant_key: tenantKey,
        webhook_secret_hash: null,
        status: "ACTIVE",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const eventId = `evt-nofallback-${newId().replace(/-/g, "").slice(-12)}`;
    const prior = process.env["ASAAS_WEBHOOK_SECRET"];
    const fallbackSecret = `fallback-${newId().replace(/-/g, "").slice(-12)}`;
    process.env["ASAAS_WEBHOOK_SECRET"] = fallbackSecret;
    try {
      const res = await injectRaw({
        method: "POST",
        url: `/v1/webhooks/asaas/${tenantKey}`,
        headers: { "asaas-access-token": fallbackSecret },
        payload: paidPayload("pay_nofallback_xyz", eventId, 5.0),
      });
      expect(res.statusCode).toBe(503);
      const inbox = await db
        .selectFrom("platform.inbox_messages")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("provider", "=", "asaas")
        .where("external_event_id", "=", eventId)
        .execute();
      expect(inbox).toHaveLength(0);
    } finally {
      if (prior === undefined) {
        delete process.env["ASAAS_WEBHOOK_SECRET"];
      } else {
        process.env["ASAAS_WEBHOOK_SECRET"] = prior;
      }
    }
  });

  it("two concurrent partial refunds both succeed; a third over-refund is rejected", async () => {
    const tenantKey = await setupAsaasChannel();
    const personId = await makePerson();
    const planId = await seedPlan("3000");
    const { orderId } = await quoteAndSubmit(personId, planId, 2);
    const { providerChargeId } = await createCharge(orderId);
    await postAsaas(tenantKey, paidPayload(providerChargeId, `evt-ref-${newId().slice(-12)}`, 60.0));
    const [payment] = await paymentsForOrder(orderId);
    if (payment === undefined) {
      throw new Error("expected a payment");
    }

    const first = await requestRefund(payment.id, "2000", `rk-a-${newId().slice(-12)}`);
    const second = await requestRefund(payment.id, "2000", `rk-b-${newId().slice(-12)}`);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error("refund requests failed");
    }
    // Duplicate idempotency key on a second request is rejected.
    const dupeKey = `rk-dupe-${newId().slice(-12)}`;
    const dupeFirst = await requestRefund(payment.id, "100", dupeKey);
    expect(dupeFirst.ok).toBe(true);
    const dupeSecond = await requestRefund(payment.id, "100", dupeKey);
    expect(dupeSecond.ok).toBe(false);
    expect(dupeSecond.ok ? null : dupeSecond.code).toBe("precondition_failed");

    expect(await approveRefund(first.data.reviewRequestId)).toMatchObject({ ok: true });
    expect(await approveRefund(second.data.reviewRequestId)).toMatchObject({ ok: true });

    // Per-payment serialization: both fit in the 6000 remainder, so both land.
    const [runA, runB] = await Promise.all([
      executeRefund(first.data.id),
      executeRefund(second.data.id),
    ]);
    expect(runA).toMatchObject({ ok: true });
    expect(runB).toMatchObject({ ok: true });

    const after = await db
      .selectFrom("billing.payments")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", payment.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe("PARTIALLY_REFUNDED");

    const third = await requestRefund(payment.id, "3000", `rk-c-${newId().slice(-12)}`);
    expect(third.ok).toBe(false);
    expect(third.ok ? null : third.code).toBe("precondition_failed");
    await assertLedgerBalancedDb();
  });

  it("self-approval is rejected and the requester cannot execute without approval", async () => {
    const tenantKey = await setupAsaasChannel();
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const { orderId } = await quoteAndSubmit(personId, planId, 1);
    const { providerChargeId } = await createCharge(orderId);
    await postAsaas(tenantKey, paidPayload(providerChargeId, `evt-self-${newId().slice(-12)}`, 10.0));
    const [payment] = await paymentsForOrder(orderId);
    if (payment === undefined) {
      throw new Error("expected a payment");
    }
    const requested = await requestRefund(payment.id, "500", `rk-self-${newId().slice(-12)}`);
    if (!requested.ok) {
      throw new Error("refund request failed");
    }
    const selfApproved = await bus.execute(actor(), "human_review.approve", {
      requestId: requested.data.reviewRequestId,
    });
    expect(selfApproved.ok).toBe(false);
    expect(selfApproved.ok ? null : selfApproved.code).toBe("precondition_failed");

    const executed = await executeRefund(requested.data.id);
    expect(executed.ok).toBe(false);
  });

  it("stale approval is rejected after the payment is drained by another refund", async () => {
    const tenantKey = await setupAsaasChannel();
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const { orderId } = await quoteAndSubmit(personId, planId, 1);
    const { providerChargeId } = await createCharge(orderId);
    await postAsaas(tenantKey, paidPayload(providerChargeId, `evt-stale-${newId().slice(-12)}`, 10.0));
    const [payment] = await paymentsForOrder(orderId);
    if (payment === undefined) {
      throw new Error("expected a payment");
    }
    const fullA = await requestRefund(payment.id, "1000", `rk-stale-a-${newId().slice(-12)}`);
    const fullB = await requestRefund(payment.id, "1000", `rk-stale-b-${newId().slice(-12)}`);
    if (!fullA.ok || !fullB.ok) {
      throw new Error("refund requests failed");
    }
    expect(await approveRefund(fullA.data.reviewRequestId)).toMatchObject({ ok: true });
    expect(await executeRefund(fullA.data.id)).toMatchObject({ ok: true });

    // The second full approval is now stale: nothing remains refundable.
    const stale = await approveRefund(fullB.data.reviewRequestId);
    expect(stale.ok).toBe(false);
    expect(stale.ok ? null : stale.code).toBe("precondition_failed");

    const paymentAfter = await db
      .selectFrom("billing.payments")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", payment.id)
      .executeTakeFirstOrThrow();
    expect(paymentAfter.status).toBe("REFUNDED");
    await assertLedgerBalancedDb();
  });

  it("cross-customer refund within the same tenant is rejected", async () => {
    const tenantKey = await setupAsaasChannel();
    const personId = await makePerson();
    const otherPerson = await makePerson();
    const planId = await seedPlan("1000");
    const { orderId } = await quoteAndSubmit(personId, planId, 1);
    const { providerChargeId } = await createCharge(orderId);
    await postAsaas(tenantKey, paidPayload(providerChargeId, `evt-xcust-${newId().slice(-12)}`, 10.0));
    const [payment] = await paymentsForOrder(orderId);
    if (payment === undefined) {
      throw new Error("expected a payment");
    }
    const cross = await bus.execute(actor(), "refund.request", {
      paymentId: payment.id,
      amountMinor: "100",
      currency: "BRL",
      reason: "wrong customer",
      personId: otherPerson,
      idempotencyKey: `rk-xcust-${newId().slice(-12)}`,
    });
    expect(cross.ok).toBe(false);
    expect(cross.ok ? null : cross.code).toBe("precondition_failed");
  });

  it("UNKNOWN refund effect holds the reservation, then reconciles to applied", async () => {
    process.env["ASAAS_ECHO_REFUND"] = "unknown";
    try {
      const tenantKey = await setupAsaasChannel();
      const personId = await makePerson();
      const planId = await seedPlan("1000");
      const { orderId } = await quoteAndSubmit(personId, planId, 1);
      const { providerChargeId } = await createCharge(orderId);
      await postAsaas(tenantKey, paidPayload(providerChargeId, `evt-unk-${newId().slice(-12)}`, 10.0));
      const [payment] = await paymentsForOrder(orderId);
      if (payment === undefined) {
        throw new Error("expected a payment");
      }
      const requested = await requestRefund(payment.id, "400", `rk-unk-${newId().slice(-12)}`);
      if (!requested.ok) {
        throw new Error("refund request failed");
      }
      expect(await approveRefund(requested.data.reviewRequestId)).toMatchObject({ ok: true });
      const executed = await executeRefund(requested.data.id);
      expect(executed).toMatchObject({ ok: true, data: { status: "RECONCILING", effectCertainty: "UNKNOWN" } });
      if (!executed.ok) {
        throw new Error("expected reconciling");
      }
      const refundId = executed.data.refundId;

      const held = await db
        .selectFrom("billing.exceptions")
        .select(["id", "status"])
        .where("tenant_id", "=", tenantId)
        .where("refund_id", "=", refundId)
        .where("kind", "=", "REFUND_UNKNOWN_EFFECT")
        .execute();
      expect(held).toHaveLength(1);
      const [unknownEffect] = held;
      if (unknownEffect === undefined) {
        throw new Error("expected an exception");
      }
      expect(unknownEffect.status).toBe("OPEN");

      process.env["ASAAS_ECHO_REFUND_RECONCILE"] = "applied";
      const reconciled = await bus.execute(actor(), "refund.reconcile", { refundId });
      expect(reconciled).toMatchObject({ ok: true, data: { effectCertainty: "KNOWN_APPLIED" } });

      const resolved = await db
        .selectFrom("billing.exceptions")
        .select(["status"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", unknownEffect.id)
        .executeTakeFirstOrThrow();
      expect(resolved.status).toBe("RESOLVED");
      await assertLedgerBalancedDb();
    } finally {
      delete process.env["ASAAS_ECHO_REFUND"];
      delete process.env["ASAAS_ECHO_REFUND_RECONCILE"];
    }
  });

  it("chargeback follows the distinct path (CHARGEBACK status + loss posting + review exception)", async () => {
    const tenantKey = await setupAsaasChannel();
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const { orderId } = await quoteAndSubmit(personId, planId, 1);
    const { providerChargeId } = await createCharge(orderId);
    await postAsaas(tenantKey, paidPayload(providerChargeId, `evt-cb-${newId().slice(-12)}`, 10.0));
    const [payment] = await paymentsForOrder(orderId);
    if (payment === undefined) {
      throw new Error("expected a payment");
    }
    const cb = await postAsaas(tenantKey, {
      event: "PAYMENT_CHARGEBACK",
      id: `evt-cb-dup-${newId().slice(-12)}`,
      payment: { id: providerChargeId, value: 10.0 },
    });
    expect(cb.statusCode).toBe(202);

    const after = await db
      .selectFrom("billing.payments")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", payment.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe("CHARGEBACK");

    const review = await db
      .selectFrom("billing.exceptions")
      .select(["kind", "status"])
      .where("tenant_id", "=", tenantId)
      .where("payment_id", "=", payment.id)
      .where("kind", "=", "CHARGEBACK")
      .execute();
    expect(review).toHaveLength(1);
    const [chargebackReview] = review;
    if (chargebackReview === undefined) {
      throw new Error("expected an exception");
    }
    expect(chargebackReview.status).toBe("OPEN");
    await assertLedgerBalancedDb();
  });

  it("order and charge expiry move past-due rows without touching money", async () => {
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const quoted = await bus.execute<{ id: string }>(actor(), "offer.quote", {
      personId,
      items: [{ sellableType: "PLAN", sellableId: planId, quantity: 1 }],
      orderType: "NEW_SUBSCRIPTION",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    if (!quoted.ok) {
      throw new Error("quote failed");
    }
    const expired = await bus.execute<{ expired: string[] }>(actor(), "order.expire_due", {});
    expect(expired.ok).toBe(true);
    if (!expired.ok) {
      throw new Error("expire failed");
    }
    expect(expired.data.expired).toContain(quoted.data.id);

    const { orderId } = await quoteAndSubmit(personId, planId, 1);
    const created = await bus.execute<{ id: string }>(actor(), "charge.create", { orderId });
    if (!created.ok) {
      throw new Error("charge create failed");
    }
    await db
      .updateTable("billing.charges")
      .set({ due_at: new Date(Date.now() - 1000) })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", created.data.id)
      .execute();
    const expiredCharges = await bus.execute<{ expired: string[] }>(actor(), "charge.expire_due", {});
    expect(expiredCharges).toMatchObject({ ok: true, data: { expired: [created.data.id] } });
  });

  it("tenant isolation: another tenant cannot see or mutate this tenant's orders", async () => {
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const { orderId } = await quoteAndSubmit(personId, planId, 1);

    const registerB = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w5b"), password: "correct-horse-8", tenantName: "Wave5 Other" },
    });
    expect(registerB.statusCode).toBe(201);
    const bodyB = registerB.json<{ token: string }>();

    const foreign = await injectRaw({ method: "GET", url: `/v1/orders/${orderId}`, token: bodyB.token });
    expect(foreign.statusCode).toBe(404);
  });
});
