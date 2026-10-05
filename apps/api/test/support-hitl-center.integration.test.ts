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

function suffix(): string {
  return newId().replace(/-/g, "").slice(-12);
}

const PERMISSIONS = [
  "crm.person.read",
  "crm.lead.write",
  "conversation.reply",
  "settings.manage",
  "support.ticket.read",
  "support.ticket.write",
  "support.incident.write",
  "knowledge.read",
  "knowledge.write",
  "agent.review.request",
  "agent.review.decide",
];

describe.skipIf(!hasDb)("Wave 8 Support + HITL center (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let token = "";
  let tenantId = "";
  let userId = "";
  let otherToken = "";
  let otherTenantId = "";
  /**
   * A member of THIS tenant holding only `tenant_operator` (support-capable,
   * no `provider.operation.read`) — the caller whose unfiltered center must
   * omit provider rows and whose explicit provider filter must be a 403.
   */
  let supportOnlyToken = "";
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

  async function ok<T>(result: { ok: boolean; data?: T; message?: string }, what: string): Promise<T> {
    if (!result.ok) {
      throw new Error(`${what} failed: ${(result as { message: string }).message}`);
    }
    return (result as { ok: true; data: T }).data;
  }

  async function makePerson(): Promise<string> {
    return (await ok<{ id: string }>(await bus.execute(actor(), "person.register", {
      canonicalName: "Wave8 Person",
    }), "person.register")).id;
  }

  /** Minimal subscription chain for a recovery_task fixture (direct rows). */
  async function seedRecoveryTask(reason: string): Promise<string> {
    const personId = await makePerson();
    const customerId = newId();
    await db
      .insertInto("crm.customers")
      .values({
        id: customerId,
        tenant_id: tenantId,
        person_id: personId,
        status: "ACTIVE",
        customer_since: new Date(),
        last_reactivated_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const sfx = suffix();
    const productId = newId();
    await db
      .insertInto("catalog.products")
      .values({
        id: productId,
        tenant_id: tenantId,
        product_key: `svc-${sfx}`,
        name: "Wave8 Service",
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
        plan_key: `monthly-${sfx}`,
        name: "Wave8 Monthly",
        billing_interval_unit: "MONTH",
        billing_interval_count: 1,
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const subscriptionId = newId();
    await db
      .insertInto("subscription.subscriptions")
      .values({
        id: subscriptionId,
        tenant_id: tenantId,
        customer_id: customerId,
        plan_id: planId,
        originating_order_id: null,
        status: "ENDED",
        started_at: new Date(),
        current_period_start: null,
        current_period_end: null,
        cancel_at_period_end: false,
        cancelled_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const taskId = newId();
    await db
      .insertInto("renewal.recovery_tasks")
      .values({
        id: taskId,
        tenant_id: tenantId,
        subscription_id: subscriptionId,
        cycle_id: null,
        renewal_order_id: null,
        reason,
        status: "OPEN",
        outcome: null,
        resolved_by: null,
        created_at: new Date(),
        updated_at: new Date(),
        resolved_at: null,
      })
      .execute();
    return taskId;
  }

  /**
   * Provider account + operations parked in `HUMAN_REQUIRED` for the center.
   * `action` is deliberately non-secret; the payload/result JSONs carry
   * sentinel values that must NEVER appear in any center response.
   */
  async function seedProviderOperations(): Promise<{
    accountId: string;
    humanRequiredId: string;
    succeededId: string;
    runningId: string;
    otherTenantHumanRequiredId: string;
    payloadSentinel: string;
    resultSentinel: string;
  }> {
    const nowDate = new Date();
    const providerId = newId();
    await db
      .insertInto("provider.providers")
      .values({
        id: providerId,
        provider_key: `w8-prov-${suffix()}`,
        name: "Wave8 Provider",
        provider_type: "IPTV",
        status: "ACTIVE",
        created_at: nowDate,
      })
      .execute();
    const accountId = newId();
    const accountSentinel = `w8-secret-${suffix()}`;
    await db
      .insertInto("provider.provider_accounts")
      .values({
        id: accountId,
        tenant_id: tenantId,
        provider_id: providerId,
        name: "Wave8 Provider Account",
        status: "ACTIVE",
        secret_ref: accountSentinel,
        settings_json: {},
        last_recharge_at: null,
        created_at: nowDate,
        updated_at: nowDate,
      })
      .execute();

    const payloadSentinel = `w8-payload-${suffix()}`;
    const resultSentinel = `w8-result-${suffix()}`;
    const sfx = suffix();

    async function insertOperation(input: {
      tenant: string;
      status: "HUMAN_REQUIRED" | "SUCCEEDED" | "RUNNING";
      certainty: "UNKNOWN" | "KNOWN_APPLIED" | "KNOWN_NOT_APPLIED";
      ageHours: number;
    }): Promise<string> {
      const id = newId();
      await db
        .insertInto("provider.provider_operations")
        .values({
          id,
          tenant_id: input.tenant,
          provider_account_id: accountId,
          action: "CREATE_TRIAL",
          entity_type: "trial",
          entity_id: newId(),
          status: input.status,
          idempotency_key: `w8-op-${sfx}-${input.status}-${id.slice(-6)}`,
          execution_channel: "BROWSER",
          adapter_version: "w8-adapter",
          requested_payload_json: {
            customer_reference: payloadSentinel,
            credential_pin: "998877",
          },
          result_summary_json: input.status === "SUCCEEDED" ? { note: "n/a" } : { raw_adapter_error: resultSentinel },
          requested_at: new Date(Date.now() - input.ageHours * 3_600_000),
          started_at: null,
          completed_at: input.status === "SUCCEEDED" ? nowDate : null,
          correlation_id: newId(),
          effect_certainty: input.certainty,
        })
        .execute();
      return id;
    }

    const humanRequiredId = await insertOperation({
      tenant: tenantId,
      status: "HUMAN_REQUIRED",
      certainty: "UNKNOWN",
      ageHours: 5,
    });
    const succeededId = await insertOperation({
      tenant: tenantId,
      status: "SUCCEEDED",
      certainty: "KNOWN_APPLIED",
      ageHours: 6,
    });
    const runningId = await insertOperation({
      tenant: tenantId,
      status: "RUNNING",
      certainty: "UNKNOWN",
      ageHours: 7,
    });
    // Cross-tenant park under the other tenant's own account, so the only
    // thing keeping it out of our center is the tenant predicate.
    const otherProviderId = newId();
    await db
      .insertInto("provider.providers")
      .values({
        id: otherProviderId,
        provider_key: `w8-other-prov-${suffix()}`,
        name: "Wave8 Other Provider",
        provider_type: "IPTV",
        status: "ACTIVE",
        created_at: nowDate,
      })
      .execute();
    const otherAccountId = newId();
    await db
      .insertInto("provider.provider_accounts")
      .values({
        id: otherAccountId,
        tenant_id: otherTenantId,
        provider_id: otherProviderId,
        name: "Wave8 Other Account",
        status: "ACTIVE",
        secret_ref: `w8-other-secret-${suffix()}`,
        settings_json: {},
        last_recharge_at: null,
        created_at: nowDate,
        updated_at: nowDate,
      })
      .execute();
    const otherTenantHumanRequiredId = newId();
    await db
      .insertInto("provider.provider_operations")
      .values({
        id: otherTenantHumanRequiredId,
        tenant_id: otherTenantId,
        provider_account_id: otherAccountId,
        action: "CREATE_TRIAL",
        entity_type: "trial",
        entity_id: newId(),
        status: "HUMAN_REQUIRED",
        idempotency_key: `w8-op-${sfx}-other`,
        execution_channel: "BROWSER",
        adapter_version: "w8-adapter",
        requested_payload_json: { customer_reference: payloadSentinel },
        result_summary_json: { raw_adapter_error: resultSentinel },
        requested_at: new Date(Date.now() - 8 * 3_600_000),
        started_at: null,
        completed_at: null,
        correlation_id: newId(),
        effect_certainty: "UNKNOWN",
      })
      .execute();

    return {
      accountId,
      humanRequiredId,
      succeededId,
      runningId,
      otherTenantHumanRequiredId,
      payloadSentinel,
      resultSentinel,
    };
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
    void drainer;

    const register = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w8"), password: "correct-horse-8", tenantName: "Wave8 Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;

    const other = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w8other"), password: "correct-horse-8", tenantName: "Wave8 Other" },
    });
    expect(other.statusCode).toBe(201);
    const otherBody = other.json<{ token: string; activeTenantId: string }>();
    otherToken = otherBody.token;
    otherTenantId = otherBody.activeTenantId;

    // Support-only member of THIS tenant: register without a tenant, attach a
    // `tenant_operator` membership (no `provider.operation.read` in that role)
    // and log in so the session's active tenant is ours.
    const supportEmail = email("w8support");
    const supportUser = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: supportEmail, password: "correct-horse-8" },
    });
    expect(supportUser.statusCode).toBe(201);
    const supportUserId = supportUser.json<{ user: { id: string } }>().user.id;
    await db
      .insertInto("control.tenant_memberships")
      .values({
        id: newId(),
        tenant_id: tenantId,
        user_id: supportUserId,
        role_key: "tenant_operator",
        status: "ACTIVE",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const supportLogin = await injectRaw({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: supportEmail, password: "correct-horse-8" },
    });
    expect(supportLogin.statusCode).toBe(200);
    const supportSession = supportLogin.json<{ token: string; activeTenantId: string | null }>();
    expect(supportSession.activeTenantId).toBe(tenantId);
    supportOnlyToken = supportSession.token;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it("runs the full ticket lifecycle with solution evidence", async () => {
    const personId = await makePerson();

    const opened = await ok<{ id: string; status: string }>(
      await bus.execute(actor(), "support.ticket.open", {
        personId,
        priority: "HIGH",
        summary: "Playback trava no app durante a noite",
      }),
      "ticket.open",
    );
    expect(opened.status).toBe("NEW");
    const ticketId = opened.id;

    // Assignment records the first response and requires a tenant member.
    const assigned = await ok<{ id: string; assigneeUserId: string }>(
      await bus.execute(actor(), "support.ticket.assign", { ticketId, assigneeUserId: userId }),
      "ticket.assign",
    );
    expect(assigned.assigneeUserId).toBe(userId);
    const badAssign = await bus.execute(actor(), "support.ticket.assign", {
      ticketId,
      assigneeUserId: newId(),
    });
    expect(badAssign.ok).toBe(false);
    if (!badAssign.ok) {
      expect(badAssign.code).toBe("precondition_failed");
    }

    // NEW resolves to nothing — the canonical path starts at TRIAGING.
    const directResolve = await bus.execute(actor(), "support.ticket.resolve", { ticketId });
    expect(directResolve.ok).toBe(false);

    await ok(await bus.execute(actor(), "support.ticket.transition", { ticketId, toStatus: "TRIAGING" }), "to triaging");
    const badJump = await bus.execute(actor(), "support.ticket.transition", {
      ticketId,
      toStatus: "RESOLVED",
    });
    expect(badJump.ok).toBe(false);
    await ok(await bus.execute(actor(), "support.ticket.transition", { ticketId, toStatus: "IN_PROGRESS" }), "to progress");

    // Resolve without evidence is rejected; a FAILED attempt does not unlock.
    await ok(
      await bus.execute(actor(), "support.ticket.add_solution_attempt", {
        ticketId,
        procedureKey: "restart-app",
        outcome: "FAILED",
      }),
      "attempt failed",
    );
    const premature = await bus.execute(actor(), "support.ticket.resolve", { ticketId });
    expect(premature.ok).toBe(false);
    if (!premature.ok) {
      expect(premature.message).toMatch(/SUCCEEDED or PARTIAL/);
    }

    // A SOLUTION knowledge item gives tickets something to link outcomes to.
    const knowledge = await ok<{ id: string }>(
      await bus.execute(actor(), "knowledge.item.create", {
        knowledgeType: "SOLUTION",
        canonicalKey: `w8-playback-fix-${suffix()}`,
        contentText: "Playback trava a noite: reinicie o app e limpe o cache; trava some",
        structuredContent: { tags: ["playback", "trava"], procedure: { steps: ["restart", "clear-cache"] } },
      }),
      "knowledge create",
    );
    const solutionRow = await db
      .selectFrom("knowledge.solutions")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("knowledge_item_id", "=", knowledge.id)
      .executeTakeFirst();
    expect(solutionRow).toBeDefined();

    await ok(
      await bus.execute(actor(), "support.ticket.add_solution_attempt", {
        ticketId,
        solutionId: solutionRow?.id,
        outcome: "SUCCEEDED",
      }),
      "attempt succeeded",
    );
    const resolved = await ok<{ id: string; status: string; outcomeId: string | null }>(
      await bus.execute(actor(), "support.ticket.resolve", {
        ticketId,
        solutionId: solutionRow?.id,
        outcome: "SUCCEEDED",
      }),
      "ticket.resolve",
    );
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.outcomeId).not.toBeNull();

    // Diagnostics read joins attempts + observed outcomes (with trial refs).
    const detail = await injectRaw({ method: "GET", url: `/v1/tickets/${ticketId}`, token });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json<{
      ticket: { status: string; assigneeUserId: string };
      attempts: Array<{ outcome: string | null }>;
      solutionOutcomes: Array<{ outcome: string; trialId: string | null }>;
    }>();
    expect(detailBody.ticket.status).toBe("RESOLVED");
    expect(detailBody.ticket.assigneeUserId).toBe(userId);
    expect(detailBody.attempts.map((a) => a.outcome)).toEqual(["FAILED", "SUCCEEDED"]);
    expect(detailBody.solutionOutcomes).toHaveLength(1);

    // my-work still lists it while open… resolve first: close then reopen.
    await ok(await bus.execute(actor(), "support.ticket.close", { ticketId }), "close");
    const myWorkClosed = await injectRaw({ method: "GET", url: "/v1/tickets/my-work", token });
    expect(myWorkClosed.json<{ tickets: unknown[] }>().tickets).toHaveLength(0);
    await ok(await bus.execute(actor(), "support.ticket.reopen", { ticketId }), "reopen");
    const myWork = await injectRaw({ method: "GET", url: "/v1/tickets/my-work", token });
    const mine = myWork.json<{ tickets: Array<{ id: string; status: string }> }>().tickets;
    expect(mine.map((t) => t.id)).toContain(ticketId);
    expect(mine.find((t) => t.id === ticketId)?.status).toBe("IN_PROGRESS");

    // WAITING_CUSTOMER detour then resolve again (evidence persists).
    await ok(
      await bus.execute(actor(), "support.ticket.transition", { ticketId, toStatus: "WAITING_CUSTOMER" }),
      "to waiting",
    );
    await ok(
      await bus.execute(actor(), "support.ticket.resolve", { ticketId }),
      "resolve again",
    );
    await ok(await bus.execute(actor(), "support.ticket.close", { ticketId }), "close again");

    // Registry-listed ticket events exist for this tenant.
    const events = await db
      .selectFrom("platform.domain_events")
      .select(["event_type"])
      .where("tenant_id", "=", tenantId)
      .where("aggregate_id", "=", ticketId)
      .execute();
    const types = events.map((e) => e.event_type);
    for (const expected of [
      "support.ticket_created.v1",
      "support.triage_started.v1",
      "support.work_started.v1",
      "support.resolved.v1",
      "support.closed.v1",
      "support.reopened.v1",
      "support.waiting_customer.v1",
    ]) {
      expect(types).toContain(expected);
    }
  });

  it("links incidents and problems to tickets with canonical incident states", async () => {
    const personId = await makePerson();
    const opened = await ok<{ id: string }>(
      await bus.execute(actor(), "support.ticket.open", { personId, summary: "Sem sinal no servidor leste" }),
      "ticket.open",
    );
    const incident = await ok<{ id: string; status: string }>(
      await bus.execute(actor(), "support.incident.open", {
        severity: "HIGH",
        title: "Queda parcial leste",
      }),
      "incident.open",
    );
    expect(incident.status).toBe("DETECTED");
    // DETECTED cannot resolve or skip straight to MONITORING.
    expect((await bus.execute(actor(), "support.incident.resolve", { incidentId: incident.id })).ok).toBe(false);
    expect(
      (await bus.execute(actor(), "support.incident.update_status", { incidentId: incident.id, toStatus: "MONITORING" })).ok,
    ).toBe(false);
    await ok(
      await bus.execute(actor(), "support.incident.update_status", { incidentId: incident.id, toStatus: "CONFIRMED" }),
      "confirm",
    );
    const linked = await ok<{ already: boolean }>(
      await bus.execute(actor(), "support.ticket.link_incident", { ticketId: opened.id, incidentId: incident.id }),
      "link incident",
    );
    expect(linked.already).toBe(false);
    const relink = await ok<{ already: boolean }>(
      await bus.execute(actor(), "support.ticket.link_incident", { ticketId: opened.id, incidentId: incident.id }),
      "relink incident",
    );
    expect(relink.already).toBe(true);

    const problem = await ok<{ id: string }>(
      await bus.execute(actor(), "support.problem.open", {
        title: "Timeout recorrente no handshake leste",
        rootCause: "balanceador saturado no pico",
      }),
      "problem.open",
    );
    await ok(
      await bus.execute(actor(), "support.ticket.link_problem", { ticketId: opened.id, problemId: problem.id }),
      "link problem",
    );
    await ok(await bus.execute(actor(), "support.incident.resolve", { incidentId: incident.id }), "incident resolve");

    const detail = await injectRaw({ method: "GET", url: `/v1/tickets/${opened.id}`, token });
    const body = detail.json<{
      incidents: Array<{ id: string; status: string }>;
      problems: Array<{ id: string }>;
    }>();
    expect(body.incidents.map((r) => r.id)).toContain(incident.id);
    expect(body.incidents.find((r) => r.id === incident.id)?.status).toBe("RESOLVED");
    expect(body.problems.map((r) => r.id)).toContain(problem.id);

    const incidents = await injectRaw({ method: "GET", url: "/v1/incidents?status=RESOLVED", token });
    expect(incidents.json<{ incidents: Array<{ id: string }> }>().incidents.map((r) => r.id)).toContain(incident.id);
  });

  it("aggregates the four queues in the center with SLA flags, claim and no leakage", async () => {
    // One item per queue.
    const review = await ok<{ id: string }>(
      await bus.execute(actor(), "human_review.request", {
        resourceType: `w8-center-${suffix()}`,
        resourceId: newId(),
        reviewMode: "REVIEW",
        reason: "RISK_REVIEW",
        summary: "Center review fixture",
      }),
      "review.request",
    );
    const commId = newId();
    await db
      .insertInto("communication.exceptions")
      .values({
        id: commId,
        tenant_id: tenantId,
        kind: "UNMATCHED_INBOUND",
        status: "OPEN",
        channel: "WHATSAPP",
        external_message_id: `w8-${suffix()}`,
        from_address: "5511999999999",
        conversation_id: null,
        person_id: null,
        reason: "unknown sender wave8",
        payload_json: {},
        created_at: new Date(),
        updated_at: new Date(),
        resolved_at: null,
      })
      .execute();
    const billingId = newId();
    await db
      .insertInto("billing.exceptions")
      .values({
        id: billingId,
        tenant_id: tenantId,
        kind: "CHARGEBACK",
        status: "OPEN",
        charge_id: null,
        payment_id: null,
        refund_id: null,
        reason: "chargeback wave8",
        payload_json: {},
        created_at: new Date(Date.now() - 25 * 3_600_000),
        updated_at: new Date(),
        resolved_at: null,
      })
      .execute();
    const recoveryId = await seedRecoveryTask(`OVERDUE_NO_RENEWAL_W8_${suffix()}`);

    // Age the review into WARN (5h) — stale surfacing without waiting.
    await db
      .updateTable("agent.human_review_requests")
      .set({ created_at: new Date(Date.now() - 5 * 3_600_000) })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", review.id)
      .execute();

    const center = await injectRaw({ method: "GET", url: "/v1/human-reviews/center", token });
    expect(center.statusCode).toBe(200);
    const body = center.json<{
      items: Array<{ source: string; id: string; kind: string; summary: string; ageMinutes: number; sla: string; deepLink: string }>;
      slaPolicy: { warnAfterHours: number; breachAfterHours: number; ref: string };
    }>();
    expect(body.slaPolicy).toMatchObject({ warnAfterHours: 4, breachAfterHours: 24, ref: "default-v1" });
    const byId = new Map(body.items.map((i) => [i.id, i]));
    expect(byId.get(review.id)).toMatchObject({ source: "human_review", sla: "WARN" });
    expect(byId.get(commId)?.source).toBe("comm_exception");
    expect(byId.get(billingId)).toMatchObject({ source: "billing_exception", sla: "BREACH" });
    expect(byId.get(recoveryId)?.source).toBe("recovery_task");
    for (const item of body.items) {
      expect(item.deepLink.length).toBeGreaterThan(0);
      expect(item.ageMinutes).toBeGreaterThanOrEqual(0);
    }

    // Source filter narrows; unknown source 400s.
    const filtered = await injectRaw({ method: "GET", url: "/v1/human-reviews/center?source=billing_exception", token });
    expect(filtered.json<{ items: Array<{ source: string }> }>().items.every((i) => i.source === "billing_exception")).toBe(true);
    expect((await injectRaw({ method: "GET", url: "/v1/human-reviews/center?source=nope", token })).statusCode).toBe(400);

    // Claim assigns + acknowledges; same-user reclaim is idempotent.
    const claim = await injectRaw({ method: "POST", url: `/v1/human-reviews/${review.id}/claim`, token });
    expect(claim.statusCode).toBe(201);
    expect(claim.json()).toMatchObject({ id: review.id, assigneeUserId: userId, already: false });
    const reclaim = await injectRaw({ method: "POST", url: `/v1/human-reviews/${review.id}/claim`, token });
    expect(reclaim.json()).toMatchObject({ already: true });
    const stored = await db
      .selectFrom("agent.human_review_requests")
      .select(["status", "assigned_to_user_id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", review.id)
      .executeTakeFirstOrThrow();
    expect(stored.status).toBe("ACKNOWLEDGED");
    expect(stored.assigned_to_user_id).toBe(userId);

    // Another member cannot steal the claim.
    const secondId = newId();
    await db
      .insertInto("control.users")
      .values({
        id: secondId,
        auth_subject: `email:${email("w8second")}`,
        display_name: "Wave8 Second",
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
        user_id: secondId,
        role_key: "tenant_owner",
        status: "ACTIVE",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const steal = await bus.execute({ ...actor(), userId: secondId }, "human_review.claim", {
      requestId: review.id,
    });
    expect(steal.ok).toBe(false);

    // Cross-tenant: the other tenant sees an empty center and none of ours.
    const otherCenter = await injectRaw({ method: "GET", url: "/v1/human-reviews/center", token: otherToken });
    expect(otherCenter.statusCode).toBe(200);
    expect(otherCenter.json<{ items: unknown[] }>().items).toHaveLength(0);
    expect((await injectRaw({ method: "GET", url: `/v1/tickets/${review.id}`, token: otherToken })).statusCode).toBe(404);
    // Other tenant lacks nothing to claim — the row simply is not theirs.
    const otherClaim = await bus.execute(
      { ...actor(), userId: "00000000-0000-0000-0000-000000000000", tenantId: otherTenantId },
      "human_review.claim",
      { requestId: review.id },
    );
    expect(otherClaim.ok).toBe(false);
    void otherTenantId;
  });

  it("surfaces only own HUMAN_REQUIRED provider operations, minimally, behind provider.operation.read", async () => {
    const fixture = await seedProviderOperations();

    // Authorized owner (tenant_owner holds provider.operation.read) sees the
    // parked op as a minimal item...
    const center = await injectRaw({ method: "GET", url: "/v1/human-reviews/center", token });
    expect(center.statusCode).toBe(200);
    const centerBody = center.json<{
      items: Array<{ source: string; id: string; kind: string; summary: string; deepLink: string; createdAt: string }>;
    }>();
    const ids = centerBody.items.map((i) => i.id);
    expect(ids).toContain(fixture.humanRequiredId);
    // ...and nothing that is not parked, or not ours.
    expect(ids).not.toContain(fixture.succeededId);
    expect(ids).not.toContain(fixture.runningId);
    expect(ids).not.toContain(fixture.otherTenantHumanRequiredId);

    const providerItems = centerBody.items.filter((i) => i.source === "provider_operation");
    expect(providerItems).toHaveLength(1);
    expect(providerItems[0]).toMatchObject({
      id: fixture.humanRequiredId,
      kind: "provider_operation/CREATE_TRIAL",
      // Fixed generic summary — no interpolated provider data.
      summary: "provider operation awaiting human resolution",
      deepLink: `/v1/provider/operations/${fixture.humanRequiredId}`,
    });
    // Only the three source fields plus the shared item shape: no payload,
    // result summary, secret ref, account id, entity id or correlation id.
    expect(Object.keys(providerItems[0] ?? {}).sort()).toEqual([
      "ageMinutes",
      "createdAt",
      "deepLink",
      "id",
      "kind",
      "priority",
      "sla",
      "source",
      "summary",
    ]);
    const serialized = JSON.stringify(center.json());
    expect(serialized).not.toContain(fixture.payloadSentinel);
    expect(serialized).not.toContain(fixture.resultSentinel);
    expect(serialized).not.toContain("credential_pin");
    expect(serialized).not.toContain("raw_adapter_error");
    expect(serialized).not.toContain("customer_reference");
    expect(serialized).not.toContain(fixture.accountId);
    expect(serialized).not.toContain(fixture.otherTenantHumanRequiredId);

    // Explicit filter for an authorized caller returns exactly that source.
    const filtered = await injectRaw({
      method: "GET",
      url: "/v1/human-reviews/center?source=provider_operation",
      token,
    });
    expect(filtered.statusCode).toBe(200);
    const filteredBody = filtered.json<{ items: Array<{ source: string; id: string }> }>();
    expect(filteredBody.items.map((i) => i.id)).toEqual([fixture.humanRequiredId]);
    expect(filteredBody.items.every((i) => i.source === "provider_operation")).toBe(true);

    // The other tenant's parked op stays invisible even filtered.
    const otherCenter = await injectRaw({
      method: "GET",
      url: "/v1/human-reviews/center?source=provider_operation",
      token: otherToken,
    });
    expect(otherCenter.statusCode).toBe(200);
    expect(otherCenter.json<{ items: Array<{ id: string }> }>().items.map((i) => i.id)).toEqual([
      fixture.otherTenantHumanRequiredId,
    ]);

    // Unknown source is still 400 for the authorized caller.
    expect(
      (await injectRaw({ method: "GET", url: "/v1/human-reviews/center?source=nope", token })).statusCode,
    ).toBe(400);
  });

  it("support-only member sees no provider rows unfiltered and is 403 on the explicit source", async () => {
    const fixture = await seedProviderOperations();

    // Unfiltered: the four support sources still aggregate, provider rows do not.
    const center = await injectRaw({ method: "GET", url: "/v1/human-reviews/center", token: supportOnlyToken });
    expect(center.statusCode).toBe(200);
    const body = center.json<{ items: Array<{ source: string; id: string }> }>();
    expect(body.items.map((i) => i.source)).not.toContain("provider_operation");
    expect(body.items.map((i) => i.id)).not.toContain(fixture.humanRequiredId);
    // Tenant scoping is unchanged for the other sources.
    expect(body.items.some((i) => i.source === "human_review" || i.source === "billing_exception")).toBe(true);

    // Explicit provider source without the permission: 403, no provider data.
    const forbidden = await injectRaw({
      method: "GET",
      url: "/v1/human-reviews/center?source=provider_operation",
      token: supportOnlyToken,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json<{ code: string; message: string }>()).toMatchObject({
      code: "FORBIDDEN",
      message: "missing permission: provider.operation.read",
    });
    const forbiddenBody = JSON.stringify(forbidden.json());
    expect(forbiddenBody).not.toContain(fixture.humanRequiredId);
    expect(forbiddenBody).not.toContain(fixture.payloadSentinel);
    expect(forbiddenBody).not.toContain(fixture.resultSentinel);

    // A legacy explicit filter still works for this caller (no widened source set).
    const legacy = await injectRaw({
      method: "GET",
      url: "/v1/human-reviews/center?source=billing_exception",
      token: supportOnlyToken,
    });
    expect(legacy.statusCode).toBe(200);
    expect(
      legacy.json<{ items: Array<{ source: string }> }>().items.every((i) => i.source === "billing_exception"),
    ).toBe(true);

    // Unknown source stays 400 (not 403) even without the permission.
    expect(
      (await injectRaw({ method: "GET", url: "/v1/human-reviews/center?source=nope", token: supportOnlyToken }))
        .statusCode,
    ).toBe(400);
  });

  it("versions, searches and suggests knowledge without leaking tenants", async () => {
    const key = `w8-faq-${suffix()}`;
    const created = await ok<{ id: string; version: number }>(
      await bus.execute(actor(), "knowledge.item.create", {
        knowledgeType: "FAQ",
        canonicalKey: key,
        contentText: "Como reemitir a credencial do app: perfil, dispositivos, gerar nova credencial",
        structuredContent: { tags: ["credencial", "app"], title: "Reemitir credencial" },
      }),
      "faq create",
    );
    expect(created.version).toBe(1);
    // Duplicate canonical keys collide per tenant.
    const dup = await bus.execute(actor(), "knowledge.item.create", {
      knowledgeType: "FAQ",
      canonicalKey: key,
      contentText: "duplicata",
    });
    expect(dup.ok).toBe(false);

    const updated = await ok<{ id: string; version: number }>(
      await bus.execute(actor(), "knowledge.item.update", {
        itemId: created.id,
        contentText: "Como reemitir a credencial do app v2: perfil, dispositivos, gerar nova credencial",
        expectedVersion: 1,
      }),
      "faq update",
    );
    expect(updated.version).toBe(2);
    const stale = await bus.execute(actor(), "knowledge.item.update", {
      itemId: created.id,
      contentText: "stale write",
      expectedVersion: 1,
    });
    expect(stale.ok).toBe(false);

    const search = await injectRaw({ method: "GET", url: "/v1/knowledge/search?q=credencial", token });
    expect(search.json<{ items: Array<{ id: string }> }>().items.map((i) => i.id)).toContain(created.id);
    const tagged = await injectRaw({ method: "GET", url: "/v1/knowledge/items?tag=app", token });
    expect(tagged.json<{ items: Array<{ id: string }> }>().items.map((i) => i.id)).toContain(created.id);

    // Suggest-only endpoint surfaces the item for a matching ticket.
    const personId = await makePerson();
    const ticket = await ok<{ id: string }>(
      await bus.execute(actor(), "support.ticket.open", {
        personId,
        summary: "Perdi minha credencial do app, preciso gerar nova",
      }),
      "suggest ticket",
    );
    const suggest = await injectRaw({ method: "GET", url: `/v1/knowledge/suggest-for-ticket/${ticket.id}`, token });
    expect(suggest.statusCode).toBe(200);
    const suggestBody = suggest.json<{
      heuristic: string;
      suggestions: Array<{ itemId: string; matchedTerms: string[] }>;
    }>();
    expect(suggestBody.heuristic).toMatch(/suggest-only/);
    expect(suggestBody.suggestions.map((s) => s.itemId)).toContain(created.id);

    await ok(await bus.execute(actor(), "knowledge.item.archive", { itemId: created.id }), "archive");
    const archived = await injectRaw({ method: "GET", url: `/v1/knowledge/items/${created.id}`, token });
    expect(archived.json<{ item: { status: string; version: number } }>().item).toMatchObject({
      status: "DEPRECATED",
      version: 2,
    });
    // Archived items leave search + suggestions.
    expect(
      (await injectRaw({ method: "GET", url: "/v1/knowledge/search?q=credencial", token })).json<{
        items: Array<{ id: string }>;
      }>().items.map((i) => i.id),
    ).not.toContain(created.id);

    // The other tenant sees none of this.
    const otherSearch = await injectRaw({ method: "GET", url: "/v1/knowledge/search?q=credencial", token: otherToken });
    expect(otherSearch.json<{ items: unknown[] }>().items).toHaveLength(0);
    expect((await injectRaw({ method: "GET", url: `/v1/knowledge/items/${created.id}`, token: otherToken })).statusCode).toBe(404);
  });
});
