import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createDb, applyMigrations } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";
import { registerObservabilityHook } from "../src/observability-hook.js";
import { CommandBus } from "../src/commands/command-bus.js";
import { OutboxDrainer } from "../src/outbox/outbox-drainer.js";
import { SchedulerService } from "../src/scheduler/scheduler.service.js";
import { WahaWebhookService } from "../src/communications/waha-webhook.service.js";

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
  "trial.read",
  "trial.write",
  "provider.operation.read",
  "provider.operation.write",
  "commerce.order.write",
  "billing.read",
  "billing.charge.write",
  "subscription.read",
  "subscription.write",
  "agent.review.request",
  "agent.review.decide",
];

const ASAAS_SECRET = "sched-test-asaas-secret";

describe.skipIf(!hasDb)("Scheduler tick end-to-end (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let token = "";
  let tenantId = "";
  let userId = "";
  let bus: CommandBus;
  let drainer: OutboxDrainer;
  let scheduler: SchedulerService;

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

  /** ACTIVE trial whose expiry is forced into the past (SQL time travel). */
  async function seedExpiredTrial(): Promise<string> {
    const person = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Scheduler Person",
    });
    if (!person.ok) {
      throw new Error(`person.register failed: ${person.message}`);
    }
    const requested = await bus.execute<{ id: string | null }>(actor(), "trial.request", {
      personId: person.data.id,
      durationMinutes: 60,
    });
    if (!requested.ok || requested.data.id === null) {
      throw new Error(`trial.request failed: ${JSON.stringify(requested)}`);
    }
    const trialId = requested.data.id;
    const provisioned = await bus.execute<{ status: string }>(actor(), "trial.begin_provisioning", {
      trialId,
      adapter: "echo",
    });
    if (!provisioned.ok || provisioned.data.status !== "ACTIVE") {
      throw new Error(`begin_provisioning failed: ${JSON.stringify(provisioned)}`);
    }
    const activatedAt = new Date(Date.now() - 2 * 3_600_000);
    await db
      .updateTable("trial.trials")
      .set({ activated_at: activatedAt, expires_at: new Date(Date.now() - 3_600_000) })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", trialId)
      .execute();
    return trialId;
  }

  async function seedMonthlyPlan(): Promise<string> {
    const suffix = newId().replace(/-/g, "").slice(-12);
    const productId = newId();
    await db
      .insertInto("catalog.products")
      .values({
        id: productId,
        tenant_id: tenantId,
        product_key: `svc-${suffix}`,
        name: "Scheduler Service",
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
        name: "Scheduler Monthly",
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
        amount_minor: "3000",
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

  /** ACTIVE subscription whose open cycle is forced past grace (SQL time travel). */
  async function seedOverdueSubscription(): Promise<string> {
    const person = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Scheduler Subscriber",
    });
    if (!person.ok) {
      throw new Error(`person.register failed: ${person.message}`);
    }
    const planId = await seedMonthlyPlan();
    const quoted = await bus.execute<{ id: string }>(actor(), "offer.quote", {
      personId: person.data.id,
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
    const created = await bus.execute<{ id: string; providerChargeId: string | null }>(actor(), "charge.create", {
      orderId: quoted.data.id,
    });
    if (!created.ok || created.data.providerChargeId === null) {
      throw new Error(`charge.create failed: ${JSON.stringify(created)}`);
    }
    const delivered = await injectRaw({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}`,
      headers: { "x-asaas-secret": ASAAS_SECRET },
      payload: {
        event: "PAYMENT_RECEIVED",
        id: `evt-sched-${newId().slice(-12)}`,
        payment: { id: created.data.providerChargeId, value: 30.0, currency: "BRL" },
      },
    });
    expect(delivered.statusCode).toBe(202);
    const activated = await bus.execute<{ id: string }>(actor(), "subscription.activate_from_order", {
      orderId: quoted.data.id,
    });
    if (!activated.ok) {
      throw new Error(`activate_from_order failed: ${JSON.stringify(activated)}`);
    }
    const subscriptionId = activated.data.id;
    const requested = await bus.execute(actor(), "fulfillment.request_for_subscription", {
      subscriptionId,
      adapter: "manual",
    });
    if (!requested.ok) {
      throw new Error(`fulfillment request failed: ${JSON.stringify(requested)}`);
    }
    const operationId = (requested.data as { operationId: string }).operationId;
    const resolved = await bus.execute(actor(), "provider.resolve_operation", {
      operationId,
      outcome: "SUCCEEDED",
    });
    if (!resolved.ok) {
      throw new Error(`provider resolve failed: ${JSON.stringify(resolved)}`);
    }
    const startsAt = new Date(Date.now() - 50 * 86_400_000);
    const endsAt = new Date(Date.now() - 40 * 86_400_000);
    await db
      .updateTable("subscription.subscription_cycles")
      .set({ starts_at: startsAt, ends_at: endsAt })
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", subscriptionId)
      .execute();
    return subscriptionId;
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    // The W0 fail-closed gate (migration 044) registers `provider.cinevision`
    // as UNAVAILABLE, which forces every begin_provisioning onto the manual
    // path. This suite owns its arrange AVAILABLE (same pattern as the
    // dispatch suites) instead of free-riding on another suite's flip, so
    // the echo seeds below stay deterministic in any parallel schedule.
    // Production stays fail-closed until real certification.
    await db
      .updateTable("platform.capabilities")
      .set({ availability: "AVAILABLE", certification_status: "CERTIFIED" })
      .where("key", "=", "provider.cinevision")
      .execute();
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    delete process.env["API_SCHEDULER_ENABLED"];
    delete process.env["PROVIDER_OPS_ADAPTER"];
    delete process.env["ASAAS_ECHO_CREATE"];
    delete process.env["ASAAS_ECHO_RECONCILE"];
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    registerObservabilityHook(app);
    await app.init();
    bus = app.get(CommandBus);
    drainer = app.get(OutboxDrainer);
    scheduler = app.get(SchedulerService);

    const register = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("sched"), password: "correct-horse-8", tenantName: "Scheduler Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;
    void token;
  });

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

  it("scheduler is disabled by default (no env)", () => {
    expect(scheduler.isEnabled()).toBe(false);
  });

  it("tick expires the trial + overdue subscription and drains the outbox once", async () => {    const trialId = await seedExpiredTrial();
    const subscriptionId = await seedOverdueSubscription();

    const first = await scheduler.tick();
    expect(first.errors).toEqual([]);
    expect(first.tenants).toBeGreaterThanOrEqual(1);

    const trial = await db
      .selectFrom("trial.trials")
      .select(["lifecycle_status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", trialId)
      .executeTakeFirstOrThrow();
    expect(trial.lifecycle_status).toBe("ENDED");

    const subscription = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .executeTakeFirstOrThrow();
    // Default service policy denies suspension → ENDED at cycle end.
    expect(subscription.status).toBe("ENDED");

    const recovery = await db
      .selectFrom("renewal.recovery_tasks")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", subscriptionId)
      .execute();
    expect(recovery.length).toBeGreaterThanOrEqual(1);

    // Outbox drained by the same tick — CONVERGENCE within bounded ticks
    // FOR THIS TENANT. The tick's outbox drain is a GLOBAL, budget-capped
    // (25 rows) oldest-first pass shared with every other suite on the
    // integration DB, so under contention a single tick can spend its
    // whole budget on older rows from other tenants before reaching this
    // tenant's fresh rows (observed as CI-only flake). The documented
    // contract is multi-tick convergence ("repeated ticks are safe"),
    // which is also how production converges — the tick repeats on its
    // interval. Loop bounded REAL ticks (never a blind sleep) until our
    // tenant has no claimable rows left; each tick must stay error-free.
    const leftoverForTenant = async () =>
      db
        .selectFrom("platform.outbox_messages")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("state", "in", ["PENDING", "FAILED"])
        .where("next_attempt_at", "<=", new Date())
        .execute();
    let leftover = await leftoverForTenant();
    for (let extraTicks = 0; leftover.length > 0 && extraTicks < 20; extraTicks += 1) {
      const next = await scheduler.tick();
      expect(next.errors).toEqual([]);
      leftover = await leftoverForTenant();
    }
    expect(leftover).toHaveLength(0);

    // Idempotent second tick: no NEW transitions for this tenant and the
    // tenant stays converged. (`outbox.claimed` is GLOBAL by design — on a
    // contended shared DB any tick may legitimately claim other tenants'
    // rows — so only the tenant-scoped fixed point is assertable here.)
    const second = await scheduler.tick();
    expect(second.errors).toEqual([]);
    for (const counts of Object.values(second.commands)) {
      expect(counts.failed).toBe(0);
    }
    expect(await leftoverForTenant()).toHaveLength(0);
    expect(
      (await db
        .selectFrom("trial.trials")
        .select(["lifecycle_status"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", trialId)
        .executeTakeFirstOrThrow()).lifecycle_status,
    ).toBe("ENDED");
    // The tick scans every tenant with due rows on the shared integration DB —
    // it can exceed the vitest default on accumulated data.
  }, 180_000);

  it("one failing task does not prevent the others in the same tick", async () => {
    const trialId = await seedExpiredTrial();
    const waha = app.get(WahaWebhookService);
    const spy = vi.spyOn(waha, "drainPending").mockRejectedValueOnce(new Error("webhook drain boom"));
    try {
      const result = await scheduler.tick();
      expect(result.errors.some((e) => e.includes("webhook.waha.drainPending"))).toBe(true);
      const trial = await db
        .selectFrom("trial.trials")
        .select(["lifecycle_status"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", trialId)
        .executeTakeFirstOrThrow();
      expect(trial.lifecycle_status).toBe("ENDED");
    } finally {
      spy.mockRestore();
    }
  }, 180_000);

  it("tick revisits an ENDED tenant to cancel a queued reminder after its renewal order settles", async () => {
    // Fixture: ACTIVE subscription → reminder queued → renewal order settled
    // → subscription/cycle transitioned to ENDED/COMPLETED (payment settled
    // after the end), leaving no ACTIVE row for the tenant.
    const person = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Scheduler Stale Reminder",
    });
    if (!person.ok) {
      throw new Error(`person.register failed: ${JSON.stringify(person)}`);
    }
    const planId = await seedMonthlyPlan();
    const quoted = await bus.execute<{ id: string }>(actor(), "offer.quote", {
      personId: person.data.id,
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
    async function settleOrder(orderId: string): Promise<void> {
      const created = await bus.execute<{ id: string; providerChargeId: string | null }>(actor(), "charge.create", {
        orderId,
      });
      if (!created.ok || created.data.providerChargeId === null) {
        throw new Error(`charge.create failed: ${JSON.stringify(created)}`);
      }
      const delivered = await injectRaw({
        method: "POST",
        url: `/v1/webhooks/asaas/${tenantKey}`,
        headers: { "x-asaas-secret": ASAAS_SECRET },
        payload: {
          event: "PAYMENT_RECEIVED",
          id: `evt-sched-stale-${newId().replace(/-/g, "").slice(-12)}`,
          payment: { id: created.data.providerChargeId, value: 30.0, currency: "BRL" },
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
    await settleOrder(quoted.data.id);
    const activated = await bus.execute<{ id: string }>(actor(), "subscription.activate_from_order", {
      orderId: quoted.data.id,
    });
    if (!activated.ok) {
      throw new Error(`activate_from_order failed: ${JSON.stringify(activated)}`);
    }
    const subscriptionId = activated.data.id;
    const requested = await bus.execute(actor(), "fulfillment.request_for_subscription", {
      subscriptionId,
      adapter: "manual",
    });
    if (!requested.ok) {
      throw new Error(`fulfillment request failed: ${JSON.stringify(requested)}`);
    }
    const operationId = (requested.data as { operationId: string }).operationId;
    const resolved = await bus.execute(actor(), "provider.resolve_operation", {
      operationId,
      outcome: "SUCCEEDED",
    });
    if (!resolved.ok) {
      throw new Error(`provider resolve failed: ${JSON.stringify(resolved)}`);
    }
    // Move the open cycle into the reminder window and queue the reminder.
    const reminderEnd = new Date(Date.now() + 2 * 86_400_000);
    const reminderStart = new Date(reminderEnd.getTime() - 30 * 86_400_000);
    await db
      .updateTable("subscription.subscription_cycles")
      .set({ starts_at: reminderStart, ends_at: reminderEnd })
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", subscriptionId)
      .where("status", "in", ["PENDING", "ACTIVE"])
      .execute();
    await db
      .updateTable("subscription.subscriptions")
      .set({ current_period_start: reminderStart, current_period_end: reminderEnd })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .execute();
    const queued = await bus.execute<{ scanned: number; reminded: string[] }>(actor(), "renewal.reminders_due", {
      limit: 100,
    });
    if (!queued.ok) {
      throw new Error(`reminders_due failed: ${JSON.stringify(queued)}`);
    }
    expect(queued.data.reminded).toContain(subscriptionId);
    const cycle = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["id", "cycle_no"])
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", subscriptionId)
      .where("status", "in", ["PENDING", "ACTIVE"])
      .executeTakeFirstOrThrow();
    const messageKey = `renewal-reminder:${subscriptionId}:${cycle.id}`;
    const message = await db
      .selectFrom("communication.messages")
      .select(["id", "direction", "sender_type"])
      .where("tenant_id", "=", tenantId)
      .where("idempotency_key", "=", messageKey)
      .executeTakeFirstOrThrow();
    expect(message.direction).toBe("INTERNAL");
    expect(message.sender_type).toBe("SYSTEM");

    // Settle the linked renewal order AFTER the reminder was queued.
    const quote = await bus.execute<{ orderId: string }>(actor(), "renewal.quote", { subscriptionId });
    if (!quote.ok) {
      throw new Error(`renewal.quote failed: ${JSON.stringify(quote)}`);
    }
    const renewalOrderId = quote.data.orderId;
    await settleOrder(renewalOrderId);

    // Transition the subscription/cycle to ENDED/COMPLETED while preserving
    // the settled link (payment settled after the end). End every other
    // ACTIVE subscription of this tenant too so the pre-tick state has no
    // ACTIVE row at all — the scheduler must find the tenant via the stale
    // reminder scan, not via the ACTIVE-subscription scan.
    await db
      .updateTable("subscription.subscription_cycles")
      .set({ status: "COMPLETED" })
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", subscriptionId)
      .where("id", "=", cycle.id)
      .execute();
    await db
      .updateTable("subscription.subscriptions")
      .set({ status: "ENDED" })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .execute();
    await db
      .updateTable("subscription.subscription_cycles")
      .set({ status: "COMPLETED" })
      .where("tenant_id", "=", tenantId)
      .where("status", "in", ["PENDING", "ACTIVE"])
      .execute();
    await db
      .updateTable("subscription.subscriptions")
      .set({ status: "ENDED" })
      .where("tenant_id", "=", tenantId)
      .where("status", "=", "ACTIVE")
      .execute();
    const actives = await db
      .selectFrom("subscription.subscriptions")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("status", "=", "ACTIVE")
      .execute();
    expect(actives).toHaveLength(0);
    const beforeDeliveries = await db
      .selectFrom("communication.message_deliveries")
      .select(["status", "attempt_no"])
      .where("tenant_id", "=", tenantId)
      .where("message_id", "=", message.id)
      .orderBy("attempt_no", "asc")
      .execute();
    expect(beforeDeliveries).toHaveLength(1);
    expect(beforeDeliveries[0]?.status).toBe("QUEUED");
    const cyclesBefore = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", subscriptionId)
      .execute();
    expect(cyclesBefore).toHaveLength(1);

    // The scheduler tick must still revisit this tenant and append the
    // append-only CANCELLED attempt — no renewal, no outbound send, no
    // status updates/deletions.
    const result = await scheduler.tick();
    expect(result.errors).toEqual([]);
    expect(result.tenants).toBeGreaterThanOrEqual(1);

    const afterDeliveries = await db
      .selectFrom("communication.message_deliveries")
      .select(["status", "provider", "attempt_no", "error_code"])
      .where("tenant_id", "=", tenantId)
      .where("message_id", "=", message.id)
      .orderBy("attempt_no", "asc")
      .execute();
    expect(afterDeliveries).toHaveLength(2);
    expect(afterDeliveries[0]?.status).toBe("QUEUED");
    expect(afterDeliveries[0]?.attempt_no).toBe(1);
    expect(afterDeliveries[1]?.status).toBe("CANCELLED");
    expect(afterDeliveries[1]?.attempt_no).toBe(2);
    expect(afterDeliveries[1]?.provider).toBe("manual");
    expect(afterDeliveries[1]?.error_code).toBe("RENEWAL_ORDER_SETTLED");

    const notes = await db
      .selectFrom("communication.messages")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("idempotency_key", "=", messageKey)
      .execute();
    expect(notes).toHaveLength(1);

    const subscription = await db
      .selectFrom("subscription.subscriptions")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .executeTakeFirstOrThrow();
    expect(subscription.status).toBe("ENDED");
    const closedCycle = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["status", "renewal_order_id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", cycle.id)
      .executeTakeFirstOrThrow();
    expect(closedCycle.status).toBe("COMPLETED");
    expect(closedCycle.renewal_order_id).toBe(renewalOrderId);
    const cyclesAfter = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("subscription_id", "=", subscriptionId)
      .execute();
    expect(cyclesAfter).toHaveLength(cyclesBefore.length);
  }, 180_000);
});
