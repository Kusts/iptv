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
import { METRIC_DEFINITIONS } from "../src/analytics/analytics-catalog.js";

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
  "billing.charge.write",
  "commerce.order.write",
  "support.ticket.read",
  "support.ticket.write",
  "subscription.read",
  "subscription.write",
];

/**
 * Wave 14 Analytics/Control Center (requires TEST_DATABASE_URL).
 *
 * Analytics only READS domain facts, so fixtures are authored directly
 * (no sale/payment flow needed): trials, a settled order, an active
 * subscription + cycle, tickets, referrals, campaign touch/conversion,
 * provider operations, an agent run pair, a scheduled intent and an open
 * recovery task. Asserts: idempotent recompute, correct series, summary
 * aggregates, cross-tenant isolation and the F14 degraded path.
 */
describe.skipIf(!hasDb)("Wave 14 Analytics/Control Center (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let tokenA = "";
  let tenantA = "";
  let userA = "";
  let bus: CommandBus;
  let drainer: OutboxDrainer;

  let tokenB = "";
  let tenantB = "";

  function actor(): CommandActor {
    return {
      userId: userA,
      isPlatformAdmin: false,
      tenantId: tenantA,
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
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = {};
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

  async function snapshotCount(tenantId: string): Promise<number> {
    const row = await db
      .selectFrom("analytics.metric_snapshots")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("tenant_id", "=", tenantId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
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

    const registerA = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w14a"), password: "correct-horse-8", tenantName: "Wave14 Tenant A" },
    });
    expect(registerA.statusCode).toBe(201);
    const bodyA = registerA.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    tokenA = bodyA.token;
    tenantA = bodyA.activeTenantId;
    userA = bodyA.user.id;

    const registerB = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w14b"), password: "correct-horse-8", tenantName: "Wave14 Tenant B" },
    });
    expect(registerB.statusCode).toBe(201);
    const bodyB = registerB.json<{ token: string; activeTenantId: string }>();
    tokenB = bodyB.token;
    tenantB = bodyB.activeTenantId;
    expect(tenantB).not.toBe(tenantA);

    const now = new Date();
    const mkPerson = async (): Promise<string> => {
      const result = await bus.execute<{ id: string }>(actor(), "person.register", {
        canonicalName: "Wave14 Person",
      });
      if (!result.ok) {
        throw new Error(`person.register failed: ${result.message}`);
      }
      return result.data.id;
    };
    const personP1 = await mkPerson();
    const personP2 = await mkPerson();
    const personP3 = await mkPerson();

    const customerC1 = newId();
    await db
      .insertInto("crm.customers")
      .values({
        id: customerC1,
        tenant_id: tenantA,
        person_id: personP1,
        status: "ACTIVE",
        customer_since: now,
        last_reactivated_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    // Catalog: monthly plan at 3000 minor (FIN-01 → 3000 MRR).
    const productId = newId();
    await db
      .insertInto("catalog.products")
      .values({
        id: productId,
        tenant_id: tenantA,
        product_key: `svc-${customerC1.slice(-8)}`,
        name: "Wave14 Service",
        product_type: "SERVICE",
        status: "ACTIVE",
        metadata_json: {},
        created_at: now,
        updated_at: now,
      })
      .execute();
    const planId = newId();
    await db
      .insertInto("catalog.plans")
      .values({
        id: planId,
        tenant_id: tenantA,
        product_id: productId,
        plan_key: `monthly-${customerC1.slice(-8)}`,
        name: "Wave14 Monthly",
        billing_interval_unit: "MONTH",
        billing_interval_count: 1,
        status: "ACTIVE",
        metadata_json: {},
        created_at: now,
        updated_at: now,
      })
      .execute();

    // Settled order: 6000 minor revenue.
    const orderId = newId();
    await db
      .insertInto("commerce.orders")
      .values({
        id: orderId,
        tenant_id: tenantA,
        person_id: personP1,
        customer_id: customerC1,
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

    // Active subscription + cycle (MRR population).
    const subscriptionId = newId();
    await db
      .insertInto("subscription.subscriptions")
      .values({
        id: subscriptionId,
        tenant_id: tenantA,
        customer_id: customerC1,
        plan_id: planId,
        originating_order_id: orderId,
        status: "ACTIVE",
        started_at: now,
        current_period_start: now,
        current_period_end: new Date(now.getTime() + 29 * 86_400_000),
        cancel_at_period_end: false,
        cancelled_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const cycleId = newId();
    await db
      .insertInto("subscription.subscription_cycles")
      .values({
        id: cycleId,
        tenant_id: tenantA,
        subscription_id: subscriptionId,
        cycle_no: 1,
        starts_at: now,
        ends_at: new Date(now.getTime() + 29 * 86_400_000),
        renewal_order_id: null,
        status: "ACTIVE",
        base_revenue_minor: "3000",
        base_provider_cost_minor: "900",
        currency: "BRL",
        created_at: now,
      })
      .execute();

    // Trials: P2 activated + PASSED, P3 requested + FAILED.
    const trial1 = newId();
    await db
      .insertInto("trial.trials")
      .values({
        id: trial1,
        tenant_id: tenantA,
        person_id: personP2,
        lead_id: null,
        previous_trial_id: null,
        trial_kind: "TRIAL",
        retrial_reason: null,
        lifecycle_status: "ACTIVE",
        technical_outcome: "PASSED",
        requested_duration_minutes: 60,
        adult_content_enabled: false,
        provider_account_id: null,
        provider_binding_id: null,
        activated_at: now,
        expires_at: new Date(now.getTime() + 3_600_000),
        ended_at: null,
        invalidated_reason: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const trial2 = newId();
    await db
      .insertInto("trial.trials")
      .values({
        id: trial2,
        tenant_id: tenantA,
        person_id: personP3,
        lead_id: null,
        previous_trial_id: null,
        trial_kind: "TRIAL",
        retrial_reason: null,
        lifecycle_status: "REQUESTED",
        technical_outcome: "FAILED",
        requested_duration_minutes: 60,
        adult_content_enabled: false,
        provider_account_id: null,
        provider_binding_id: null,
        activated_at: null,
        expires_at: null,
        ended_at: null,
        invalidated_reason: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    for (const [trialId, outcome] of [[trial1, "PASSED"], [trial2, "FAILED"]] as const) {
      await db
        .insertInto("trial.trial_technical_results")
        .values({
          id: newId(),
          tenant_id: tenantA,
          trial_id: trialId,
          installation_success: true,
          authentication_success: true,
          playback_success: outcome === "PASSED",
          buffering_observed: false,
          summary_outcome: outcome,
          assessed_at: now,
          assessment_version: "v1",
        })
        .execute();
    }

    // Tickets: 1 open + 2 resolved (agent-only vs human attempt).
    const ticketOpen = newId();
    await db
      .insertInto("support.support_tickets")
      .values({
        id: ticketOpen,
        tenant_id: tenantA,
        person_id: personP1,
        customer_id: customerC1,
        conversation_id: null,
        status: "NEW",
        priority: "NORMAL",
        category: null,
        summary: "Wave14 open ticket",
        assignee_user_id: null,
        first_response_at: null,
        resolved_at: null,
        closed_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const ticketAi = newId();
    await db
      .insertInto("support.support_tickets")
      .values({
        id: ticketAi,
        tenant_id: tenantA,
        person_id: personP1,
        customer_id: customerC1,
        conversation_id: null,
        status: "RESOLVED",
        priority: "NORMAL",
        category: null,
        summary: "Wave14 AI-resolved ticket",
        assignee_user_id: null,
        first_response_at: now,
        resolved_at: now,
        closed_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("support.solution_attempts")
      .values({
        id: newId(),
        tenant_id: tenantA,
        support_ticket_id: ticketAi,
        solution_id: null,
        procedure_key: "restart-app",
        attempt_no: 1,
        actor_type: "agent",
        actor_id: null,
        outcome: "SUCCEEDED",
        context_json: {},
        evidence_json: {},
        started_at: now,
        completed_at: now,
      })
      .execute();
    const ticketHuman = newId();
    await db
      .insertInto("support.support_tickets")
      .values({
        id: ticketHuman,
        tenant_id: tenantA,
        person_id: personP2,
        customer_id: null,
        conversation_id: null,
        status: "RESOLVED",
        priority: "HIGH",
        category: null,
        summary: "Wave14 human-resolved ticket",
        assignee_user_id: null,
        first_response_at: now,
        resolved_at: now,
        closed_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("support.solution_attempts")
      .values({
        id: newId(),
        tenant_id: tenantA,
        support_ticket_id: ticketHuman,
        solution_id: null,
        procedure_key: "manual-fix",
        attempt_no: 1,
        actor_type: "human",
        actor_id: null,
        outcome: "SUCCEEDED",
        context_json: {},
        evidence_json: {},
        started_at: now,
        completed_at: now,
      })
      .execute();

    // Referrals: 1 confirmed + 1 created.
    const programId = newId();
    await db
      .insertInto("referral.referral_programs")
      .values({
        id: programId,
        tenant_id: tenantA,
        name: "Wave14 Program",
        status: "ACTIVE",
        rules_version: "v1",
        rules_json: {},
        starts_at: now,
        ends_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("referral.referrals")
      .values({
        id: newId(),
        tenant_id: tenantA,
        program_id: programId,
        advocate_customer_id: customerC1,
        referred_person_id: personP2,
        referral_code: `W14-${customerC1.slice(-8)}`,
        status: "CONFIRMED",
        source_context: null,
        created_at: now,
        attributed_at: now,
        confirmed_at: now,
        expired_at: null,
        reversed_at: null,
      })
      .execute();
    await db
      .insertInto("referral.referrals")
      .values({
        id: newId(),
        tenant_id: tenantA,
        program_id: programId,
        advocate_customer_id: customerC1,
        referred_person_id: personP3,
        referral_code: `W14b-${customerC1.slice(-8)}`,
        status: "CREATED",
        source_context: null,
        created_at: now,
        attributed_at: null,
        confirmed_at: null,
        expired_at: null,
        reversed_at: null,
      })
      .execute();

    // Campaign + touch + conversions (1 attributed, 1 unattributed).
    const campaignId = newId();
    await db
      .insertInto("growth.campaigns")
      .values({
        id: campaignId,
        tenant_id: tenantA,
        campaign_key: `w14-${customerC1.slice(-8)}`,
        name: "Wave14 Campaign",
        objective: null,
        status: "ACTIVE",
        current_version_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const versionId = newId();
    await db
      .insertInto("growth.campaign_versions")
      .values({
        id: versionId,
        tenant_id: tenantA,
        campaign_id: campaignId,
        version_no: 1,
        status: "PUBLISHED",
        offer_snapshot_json: {},
        policy_snapshot_json: {},
        budget_cap_minor: "10000",
        unit_cost_minor: "250",
        currency: "BRL",
        published_at: now,
        created_at: now,
      })
      .execute();
    await db
      .updateTable("growth.campaigns")
      .set({ current_version_id: versionId })
      .where("tenant_id", "=", tenantA)
      .where("id", "=", campaignId)
      .execute();
    await db
      .insertInto("growth.attribution_touches")
      .values({
        id: newId(),
        tenant_id: tenantA,
        person_id: personP1,
        campaign_id: campaignId,
        campaign_version_id: versionId,
        touch_type: "CLICK",
        occurred_at: now,
        created_at: now,
      })
      .execute();
    await db
      .insertInto("growth.conversion_events")
      .values({
        id: newId(),
        tenant_id: tenantA,
        person_id: personP1,
        campaign_id: campaignId,
        campaign_version_id: versionId,
        conversion_type: "ORDER_SETTLED",
        order_id: orderId,
        amount_minor: "6000",
        currency: "BRL",
        idempotency_key: `w14-conv-${customerC1.slice(-8)}`,
        occurred_at: now,
        created_at: now,
      })
      .execute();
    await db
      .insertInto("growth.conversion_events")
      .values({
        id: newId(),
        tenant_id: tenantA,
        person_id: personP2,
        campaign_id: null,
        campaign_version_id: null,
        conversion_type: "TRIAL_ACTIVATED",
        order_id: null,
        amount_minor: null,
        currency: null,
        idempotency_key: `w14-conv-u-${customerC1.slice(-8)}`,
        occurred_at: now,
        created_at: now,
      })
      .execute();

    // Scheduled outreach (1 intent + 1 contact).
    const intentId = newId();
    await db
      .insertInto("communication.message_intents")
      .values({
        id: intentId,
        tenant_id: tenantA,
        campaign_id: campaignId,
        campaign_version_id: versionId,
        audience_id: null,
        channel: "WHATSAPP",
        purpose_key: "MARKETING",
        template_ref: null,
        idempotency_key: `w14-intent-${customerC1.slice(-8)}`,
        scheduled_for: new Date(now.getTime() + 3_600_000),
        status: "SCHEDULED",
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("communication.scheduled_contacts")
      .values({
        id: newId(),
        tenant_id: tenantA,
        intent_id: intentId,
        person_id: personP1,
        channel: "WHATSAPP",
        scheduled_for: new Date(now.getTime() + 3_600_000),
        status: "SCHEDULED",
        block_reason: null,
        estimated_cost_minor: "250",
        sent_at: null,
        created_at: now,
      })
      .execute();

    // Provider ops: 1 succeeded + 1 failed → 5000 bps.
    const providerId = newId();
    await db
      .insertInto("provider.providers")
      .values({
        id: providerId,
        provider_key: `w14-${customerC1.slice(-12)}`,
        name: "Wave14 Provider",
        provider_type: "IPTV",
        status: "ACTIVE",
        created_at: now,
      })
      .execute();
    const accountId = newId();
    await db
      .insertInto("provider.provider_accounts")
      .values({
        id: accountId,
        tenant_id: tenantA,
        provider_id: providerId,
        name: "Wave14 Account",
        status: "ACTIVE",
        secret_ref: "test-ref",
        settings_json: {},
        last_recharge_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    for (const [status, certainty] of [["SUCCEEDED", "KNOWN_APPLIED"], ["FAILED", "KNOWN_NOT_APPLIED"]] as const) {
      await db
        .insertInto("provider.provider_operations")
        .values({
          id: newId(),
          tenant_id: tenantA,
          provider_account_id: accountId,
          action: "CREATE_LOGIN",
          entity_type: "subscription",
          entity_id: subscriptionId,
          status,
          idempotency_key: `w14-op-${status}-${customerC1.slice(-8)}`,
          execution_channel: null,
          adapter_version: null,
          requested_payload_json: {},
          result_summary_json: {},
          requested_at: now,
          started_at: now,
          completed_at: now,
          correlation_id: newId(),
          effect_certainty: certainty,
        })
        .execute();
    }

    // Agent runs: 2 in the last 7d.
    for (const status of ["SENT", "FAILED"] as const) {
      await db
        .insertInto("agent.agent_runs")
        .values({
          id: newId(),
          tenant_id: tenantA,
          conversation_id: null,
          release_key: "support-agent",
          release_version: 1,
          mode: "LIVE",
          model: "test-model",
          status,
          proposal_kind: null,
          proposal_label: null,
          proposal_text: null,
          tool_calls_json: [],
          usage_json: {},
          trace_json: [],
          human_review_request_id: null,
          created_at: now,
          decided_at: now,
        })
        .execute();
    }

    // Recovery queue + trust grant (RET family).
    await db
      .insertInto("renewal.recovery_tasks")
      .values({
        id: newId(),
        tenant_id: tenantA,
        subscription_id: subscriptionId,
        cycle_id: cycleId,
        renewal_order_id: null,
        reason: "PAYMENT_FAILED",
        status: "OPEN",
        outcome: null,
        resolved_by: null,
        created_at: now,
        updated_at: now,
        resolved_at: null,
      })
      .execute();
    await db
      .insertInto("subscription.trust_renewal_grants")
      .values({
        id: newId(),
        tenant_id: tenantA,
        subscription_id: subscriptionId,
        cycle_id: cycleId,
        extension_days: 3,
        previous_ends_at: new Date(now.getTime() + 29 * 86_400_000),
        new_ends_at: new Date(now.getTime() + 32 * 86_400_000),
        review_request_id: null,
        granted_by: null,
        created_at: now,
      })
      .execute();
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
    await (db as unknown as { destroy: () => Promise<void> }).destroy?.().catch(() => undefined);
  });

  function windowQuery(): string {
    const from = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const to = new Date(Date.now() + 2 * 86_400_000).toISOString();
    return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  }

  it("recompute is idempotent: replay writes exactly the same rows", async () => {
    const first = await injectRaw({ method: "POST", url: "/v1/analytics/recompute", token: tokenA, payload: {} });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{ snapshotsWritten: number; degradedFamilies: string[] }>();
    expect(firstBody.degradedFamilies).toEqual([]);
    expect(firstBody.snapshotsWritten).toBeGreaterThan(0);
    const countAfterFirst = await snapshotCount(tenantA);

    const replay = await injectRaw({ method: "POST", url: "/v1/analytics/recompute", token: tokenA, payload: {} });
    expect(replay.statusCode).toBe(201);
    expect(replay.json<{ degradedFamilies: string[] }>().degradedFamilies).toEqual([]);
    expect(await snapshotCount(tenantA)).toBe(countAfterFirst);
  }, 30000);

  it("catalog lists the registered definitions and series carry correct values", async () => {
    const catalog = await injectRaw({ method: "GET", url: "/v1/metrics", token: tokenA });
    expect(catalog.statusCode).toBe(200);
    const catalogBody = catalog.json<{ items: Array<{ key: string }>; seeded: boolean }>();
    expect(catalogBody.seeded).toBe(true);
    expect(catalogBody.items).toHaveLength(METRIC_DEFINITIONS.length);

    const revenue = await injectRaw({
      method: "GET",
      url: `/v1/metrics/sales.settled_revenue_minor?${windowQuery()}`,
      token: tokenA,
    });
    expect(revenue.statusCode).toBe(200);
    const revenuePoints = revenue.json<{ points: Array<{ valueMinor: string; value: { totalMinor: string } }> }>().points;
    const dayTotal = revenuePoints.reduce((acc, p) => acc + BigInt(p.valueMinor ?? "0"), 0n);
    expect(dayTotal).toBe(6000n);

    const passRate = await injectRaw({
      method: "GET",
      url: `/v1/metrics/trial.technical_pass_rate_bps?${windowQuery()}`,
      token: tokenA,
    });
    expect(passRate.statusCode).toBe(200);
    const passPoints = passRate.json<{ points: Array<{ value: { passRateBps: string | null } }> }>().points;
    const rated = passPoints.filter((p) => p.value.passRateBps !== null);
    expect(rated).toHaveLength(1);
    expect(rated[0]?.value.passRateBps).toBe("5000");

    const ful = await injectRaw({
      method: "GET",
      url: `/v1/metrics/ful.success_rate_bps?${windowQuery()}`,
      token: tokenA,
    });
    expect(ful.statusCode).toBe(200);
    const fulPoints = ful.json<{ points: Array<{ value: { successRateBps: string | null } }> }>().points;
    expect(fulPoints.filter((p) => p.value.successRateBps !== null)[0]?.value.successRateBps).toBe("5000");

    const unknown = await injectRaw({ method: "GET", url: "/v1/metrics/nope.not_real", token: tokenA });
    expect(unknown.statusCode).toBe(404);
  });

  it("overview carries the latest gauges and control-center aggregates correctly", async () => {
    const overview = await injectRaw({ method: "GET", url: "/v1/analytics/overview", token: tokenA });
    expect(overview.statusCode).toBe(200);
    const overviewBody = overview.json<{
      trackedMetrics: number;
      totalMetrics: number;
      dataQuality: string;
      metrics: Record<string, { valueMinor: string | null } | null>;
    }>();
    expect(overviewBody.trackedMetrics).toBe(overviewBody.totalMetrics);
    expect(overviewBody.dataQuality).toBe("OK");
    expect(overviewBody.metrics["fin.mrr_minor"]?.valueMinor).toBe("3000");

    const summary = await injectRaw({ method: "GET", url: "/v1/control-center/summary", token: tokenA });
    expect(summary.statusCode).toBe(200);
    const body = summary.json<{
      operation: { openItems: number; bySource: Record<string, number>; openTickets: number; worstSla: string };
      business: { mrrMinor: string; monthRevenueMinor: string; activeSubscriptions: number };
      aiActivity: { runs7d: number };
      scheduledWork: { scheduledIntents: number };
      dataQuality: { status: string; unattributedConversionRateBps: string | null };
      degradedSections: string[];
      dataQualityOverall: string;
    }>();
    expect(body.degradedSections).toEqual([]);
    expect(body.dataQualityOverall).toBe("OK");
    expect(body.operation.bySource["recovery_task"]).toBe(1);
    expect(body.operation.openTickets).toBe(1);
    expect(body.operation.worstSla).toBe("OK");
    expect(body.business.mrrMinor).toBe("3000");
    expect(body.business.monthRevenueMinor).toBe("6000");
    expect(body.business.activeSubscriptions).toBe(1);
    expect(body.aiActivity.runs7d).toBe(2);
    expect(body.scheduledWork.scheduledIntents).toBe(1);
    expect(body.dataQuality.status).toBe("OK");
    expect(body.dataQuality.unattributedConversionRateBps).toBe("5000");
  });

  it("cross-tenant isolation: another tenant sees empty analytics", async () => {
    const series = await injectRaw({
      method: "GET",
      url: `/v1/metrics/ref.confirmed?${windowQuery()}`,
      token: tokenB,
    });
    expect(series.statusCode).toBe(200);
    expect(series.json<{ points: unknown[] }>().points).toEqual([]);

    const summary = await injectRaw({ method: "GET", url: "/v1/control-center/summary", token: tokenB });
    expect(summary.statusCode).toBe(200);
    const body = summary.json<{
      operation: { openItems: number };
      business: { mrrMinor: string; monthRevenueMinor: string };
      aiActivity: { runs7d: number };
      dataQuality: { status: string };
    }>();
    expect(body.operation.openItems).toBe(0);
    expect(body.business.mrrMinor).toBe("0");
    expect(body.business.monthRevenueMinor).toBe("0");
    expect(body.aiActivity.runs7d).toBe(0);
    expect(body.dataQuality.status).toBe("EMPTY");
    expect(await snapshotCount(tenantB)).toBe(0);
  });

  it("F14: a failing family degrades the payload without sinking the summary", async () => {
    const recomputed = await injectRaw({
      method: "POST",
      url: "/v1/analytics/recompute",
      token: tokenA,
      payload: { failFamily: "REF" },
    });
    expect(recomputed.statusCode).toBe(201);
    expect(recomputed.json<{ degradedFamilies: string[] }>().degradedFamilies).toEqual(["REF"]);

    // Other families survived the faulty recompute.
    const revenue = await injectRaw({
      method: "GET",
      url: `/v1/metrics/sales.settled_revenue_minor?${windowQuery()}`,
      token: tokenA,
    });
    expect(revenue.statusCode).toBe(200);
    expect(revenue.json<{ points: unknown[] }>().points.length).toBeGreaterThan(0);

    const summary = await injectRaw({ method: "GET", url: "/v1/control-center/summary", token: tokenA });
    expect(summary.statusCode).toBe(200);
    const body = summary.json<{
      dataQualityOverall: string;
      degradedSections: string[];
      dataQuality: { status: string; degradedMetrics: string[] };
      business: { mrrMinor: string };
    }>();
    expect(body.dataQualityOverall).toBe("DEGRADED");
    expect(body.degradedSections).toContain("dataQuality");
    expect(body.dataQuality.degradedMetrics).toContain("ref.created");
    // Non-snapshot sections stay healthy.
    expect(body.business.mrrMinor).toBe("3000");

    // Healthy recompute clears the marker: idempotent recovery.
    const healed = await injectRaw({ method: "POST", url: "/v1/analytics/recompute", token: tokenA, payload: {} });
    expect(healed.statusCode).toBe(201);
    expect(healed.json<{ degradedFamilies: string[] }>().degradedFamilies).toEqual([]);
    const healedSummary = await injectRaw({ method: "GET", url: "/v1/control-center/summary", token: tokenA });
    expect(healedSummary.json<{ dataQualityOverall: string }>().dataQualityOverall).toBe("OK");
  }, 30000);
});
