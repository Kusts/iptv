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

const OWNER_PERMS = [
  "crm.person.read",
  "crm.lead.write",
  "conversation.reply",
  "support.ticket.read",
  "support.ticket.write",
  "agent.review.request",
  "agent.review.decide",
  "billing.read",
  "subscription.read",
];

/**
 * Wave 14-COPILOT Tenant Copilot (requires TEST_DATABASE_URL, gate MVP-PILOT G18).
 *
 * Covers: permission-scoped context (silent per-section denial), ask as a
 * read-only deterministic stub, execute through the authorized pipeline
 * (direct MEDIUM, denied without permission, HIGH-risk parked in HITL with
 * nothing executed, stale expectedStatus → 409, unknown → 404, cross-tenant
 * → 404), and the G18 golden flow (filtered view → explain → prepare →
 * execute allowed command, approval-gated where risk requires it).
 */
describe.skipIf(!hasDb)("Wave 14-COPILOT Tenant Copilot (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let tokenOwner = "";
  let tenantA = "";
  let userOwner = "";
  let tokenOperator = "";
  let tokenDecider = "";
  let revisionDecider = "";
  let tokenTenantB = "";
  let tenantB = "";
  let bus: CommandBus;

  function ownerActor(): CommandActor {
    return {
      userId: userOwner,
      isPlatformAdmin: false,
      tenantId: tenantA,
      roleKeys: ["tenant_owner"],
      permissions: OWNER_PERMS,
      actorType: "human",
    };
  }

  function inject(opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    revision?: string | null;
    headers?: Record<string, string>;
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
      if (opts.revision !== null) {
        headers["x-tenant-context-revision"] = opts.revision ?? "0";
      }
    }
    if (opts.headers !== undefined) {
      Object.assign(headers, opts.headers);
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

  async function sessionRevision(token: string): Promise<string> {
    const res = await inject({ method: "GET", url: "/v1/auth/session", token, revision: null });
    expect(res.statusCode).toBe(200);
    return res.json<{ tenantContextRevision: string }>().tenantContextRevision;
  }

  async function makePerson(): Promise<string> {
    const result = await bus.execute<{ id: string }>(ownerActor(), "person.register", {
      canonicalName: "Copilot Person",
    });
    if (!result.ok) {
      throw new Error(`person.register failed: ${result.message}`);
    }
    return result.data.id;
  }

  async function ticketStatus(ticketId: string): Promise<string> {
    const row = await db
      .selectFrom("support.support_tickets")
      .select(["status"])
      .where("tenant_id", "=", tenantA)
      .where("id", "=", ticketId)
      .executeTakeFirstOrThrow();
    return row.status;
  }

  async function openReviewsFor(command: string): Promise<Array<{ id: string; status: string }>> {    const rows = await db
      .selectFrom("agent.human_review_requests")
      .select(["id", "status", "context_json"])
      .where("tenant_id", "=", tenantA)
      .where("resource_type", "=", "copilot_command")
      .where("status", "in", ["REQUESTED", "QUEUED", "ACKNOWLEDGED", "IN_REVIEW"])
      .execute();
    return rows.filter((r) => (r.context_json as Record<string, unknown>)["copilotCommand"] === command);
  }

  /** Approval by the second user (never the requester: self-approval is forbidden). */
  function approveReview(reviewId: string) {
    return inject({
      method: "POST",
      url: `/v1/human-reviews/${reviewId}/approve`,
      token: tokenDecider,
      revision: revisionDecider,
      payload: {},
    });
  }

  /** Approval attempt by the requester themselves (must be rejected). */
  function approveReviewAsRequester(reviewId: string) {
    return inject({
      method: "POST",
      url: `/v1/human-reviews/${reviewId}/approve`,
      token: tokenOwner,
      payload: {},
    });
  }

  /** Drive a ticket to honestly resolvable state (IN_PROGRESS + attempt). */
  async function prepareResolvable(ticketId: string): Promise<void> {
    for (const toStatus of ["TRIAGING", "IN_PROGRESS"] as const) {
      expect((await bus.execute(ownerActor(), "support.ticket.transition", { ticketId, toStatus })).ok).toBe(true);
    }
    const attempt = await bus.execute(ownerActor(), "support.ticket.add_solution_attempt", {
      ticketId,
      procedureKey: "restart-app",
      outcome: "SUCCEEDED",
    });
    expect(attempt.ok).toBe(true);
  }
  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);

    const registerA = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("copilot-owner"), password: "correct-horse-8", tenantName: "Copilot Tenant A" },
    });
    expect(registerA.statusCode).toBe(201);
    const bodyA = registerA.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    tokenOwner = bodyA.token;
    tenantA = bodyA.activeTenantId;
    userOwner = bodyA.user.id;

    const registerB = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("copilot-other"), password: "correct-horse-8", tenantName: "Copilot Tenant B" },
    });
    expect(registerB.statusCode).toBe(201);
    const bodyB = registerB.json<{ token: string; activeTenantId: string }>();
    tokenTenantB = bodyB.token;
    tenantB = bodyB.activeTenantId;
    expect(tenantB).not.toBe(tenantA);

    // Limited operator inside tenant A: register (own tenant) then grant an
    // ACTIVE tenant_operator membership in A and switch to it.
    const registerOp = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("copilot-op"), password: "correct-horse-8", tenantName: "Copilot Operator Home" },
    });
    expect(registerOp.statusCode).toBe(201);
    const bodyOp = registerOp.json<{ token: string; user: { id: string } }>();
    tokenOperator = bodyOp.token;
    await db
      .insertInto("control.tenant_memberships")
      .values({
        id: newId(),
        tenant_id: tenantA,
        user_id: bodyOp.user.id,
        role_key: "tenant_operator",
        status: "ACTIVE",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const opRevision = await sessionRevision(tokenOperator);
    const switched = await inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/switch`,
      token: tokenOperator,
      revision: opRevision,
    });
    expect(switched.statusCode).toBe(200);

    // Second approver inside tenant A (tenant_admin holds
    // agent.review.decide): copilot_command reviews forbid self-approval,
    // so approvals below come from this user, never the requester.
    const registerDec = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("copilot-decider"), password: "correct-horse-8", tenantName: "Copilot Decider Home" },
    });
    expect(registerDec.statusCode).toBe(201);
    const bodyDec = registerDec.json<{ token: string; user: { id: string } }>();
    tokenDecider = bodyDec.token;
    await db
      .insertInto("control.tenant_memberships")
      .values({
        id: newId(),
        tenant_id: tenantA,
        user_id: bodyDec.user.id,
        role_key: "tenant_admin",
        status: "ACTIVE",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    revisionDecider = await sessionRevision(tokenDecider);
    const decSwitched = await inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/switch`,
      token: tokenDecider,
      revision: revisionDecider,
    });
    expect(decSwitched.statusCode).toBe(200);
    revisionDecider = await sessionRevision(tokenDecider);
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await (db as unknown as { destroy: () => Promise<void> }).destroy?.().catch(() => undefined);
  });

  it("context is permission-scoped: sections without permission are silently omitted", async () => {
    const owner = await inject({ method: "GET", url: "/v1/agent/copilot/context?route=/support", token: tokenOwner });
    expect(owner.statusCode).toBe(200);
    const ownerKeys = owner.json<{ sections: Array<{ key: string }> }>().sections.map((s) => s.key);
    expect(ownerKeys).toEqual(expect.arrayContaining(["tickets", "conversations", "orders", "subscriptions", "reviews"]));

    const operator = await inject({
      method: "GET",
      url: "/v1/agent/copilot/context?route=/support",
      token: tokenOperator,
      revision: await sessionRevision(tokenOperator),
    });
    expect(operator.statusCode).toBe(200);
    const opKeys = operator.json<{ sections: Array<{ key: string }> }>().sections.map((s) => s.key);
    // tenant_operator holds support.ticket.read + crm.person.read +
    // subscription.read + agent.review.request, but NOT billing.read.
    expect(opKeys).toEqual(expect.arrayContaining(["tickets", "conversations", "subscriptions", "reviews"]));
    expect(opKeys).not.toContain("orders");
  });

  it("context entity reads are tenant-isolated (foreign id resolves to null, no leak)", async () => {
    const personId = await makePerson();
    const opened = await bus.execute<{ id: string }>(ownerActor(), "support.ticket.open", {
      personId,
      summary: "isolation probe",
    });
    if (!opened.ok) {
      throw new Error(`ticket.open failed: ${opened.message}`);
    }
    const ticketId = opened.data.id;

    const own = await inject({
      method: "GET",
      url: `/v1/agent/copilot/context?route=/support&entityKind=ticket&entityId=${ticketId}`,
      token: tokenOwner,
    });
    expect(own.statusCode).toBe(200);
    const ownTickets = own.json<{ sections: Array<{ key: string; entity: { id: string } | null }> }>().sections.find(
      (s) => s.key === "tickets",
    );
    expect(ownTickets?.entity?.id).toBe(ticketId);

    const foreign = await inject({
      method: "GET",
      url: `/v1/agent/copilot/context?route=/support&entityKind=ticket&entityId=${ticketId}`,
      token: tokenTenantB,
    });
    expect(foreign.statusCode).toBe(200);
    const foreignTickets = foreign
      .json<{ sections: Array<{ key: string; entity: { id: string } | null }> }>()
      .sections.find((s) => s.key === "tickets");
    expect(foreignTickets?.entity).toBeNull();
  });

  it("ask explains the screen and writes no domain rows", async () => {
    const ticketsBefore = await db
      .selectFrom("support.support_tickets")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("tenant_id", "=", tenantA)
      .executeTakeFirstOrThrow();
    const reviewsBefore = await db
      .selectFrom("agent.human_review_requests")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("tenant_id", "=", tenantA)
      .executeTakeFirstOrThrow();

    const res = await inject({
      method: "POST",
      url: "/v1/agent/copilot/ask",
      token: tokenOwner,
      payload: { question: "explique esta tela", screen: { route: "/support", filters: { status: "NEW" } } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      summary: string;
      confidence: string;
      sectionsUsed: string[];
      suggestions: Array<{ kind: string }>;
      deepLinks: Array<{ label: string; href: string }>;
    }>();
    expect(body.summary).toContain("/support");
    expect(body.confidence).toBe("OBSERVED");
    expect(body.sectionsUsed).toContain("tickets");
    expect(body.suggestions.length).toBeGreaterThan(0);
    expect(body.deepLinks.length).toBeGreaterThan(0);

    const ticketsAfter = await db
      .selectFrom("support.support_tickets")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("tenant_id", "=", tenantA)
      .executeTakeFirstOrThrow();
    const reviewsAfter = await db
      .selectFrom("agent.human_review_requests")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("tenant_id", "=", tenantA)
      .executeTakeFirstOrThrow();
    expect(Number(ticketsAfter.n)).toBe(Number(ticketsBefore.n));
    expect(Number(reviewsAfter.n)).toBe(Number(reviewsBefore.n));
  });

  it("execute runs an allowed MEDIUM command through the pipeline (G18 direct path)", async () => {
    const personId = await makePerson();
    const res = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      payload: { command: "support.ticket.open", input: { personId, summary: "copilot opened" } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; data: { id: string } }>();
    expect(body.status).toBe("executed");
    const row = await db
      .selectFrom("support.support_tickets")
      .select(["id", "status"])
      .where("tenant_id", "=", tenantA)
      .where("id", "=", body.data.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("NEW");
  });

  it("execute denies a command whose target permission the caller lacks (nothing created)", async () => {
    // tenant_operator holds support/billing-refund permissions but NOT
    // subscription.write: the target permission gate denies before any
    // review is created or anything executes.
    const before = await openReviewsFor("subscription.cancel_at_period_end");
    const res = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOperator,
      revision: await sessionRevision(tokenOperator),
      payload: { command: "subscription.cancel_at_period_end", input: { subscriptionId: newId() } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe("DENIED");
    expect(await openReviewsFor("subscription.cancel_at_period_end")).toHaveLength(before.length);
  });

  it("execute parks a HIGH-risk command in HITL and executes nothing", async () => {
    const personId = await makePerson();
    const opened = await bus.execute<{ id: string }>(ownerActor(), "support.ticket.open", {
      personId,
      summary: "hitl probe",
    });
    if (!opened.ok) {
      throw new Error(`ticket.open failed: ${opened.message}`);
    }
    const res = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      payload: { command: "support.ticket.resolve", input: { ticketId: opened.data.id } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ status: string; reviewId: string }>();
    expect(body.status).toBe("pending_review");
    expect(typeof body.reviewId).toBe("string");

    const review = await db
      .selectFrom("agent.human_review_requests")
      .select(["resource_type", "review_mode", "status"])
      .where("tenant_id", "=", tenantA)
      .where("id", "=", body.reviewId)
      .executeTakeFirstOrThrow();
    expect(review.resource_type).toBe("copilot_command");
    expect(review.review_mode).toBe("APPROVAL");
    // Nothing executed: the ticket is still NEW.
    expect(await ticketStatus(opened.data.id)).toBe("NEW");
  });

  it("approved HIGH-risk review authorizes the later execution (G18 approval path)", async () => {
    const personId = await makePerson();
    const opened = await bus.execute<{ id: string }>(ownerActor(), "support.ticket.open", {
      personId,
      summary: "approval probe",
    });
    if (!opened.ok) {
      throw new Error(`ticket.open failed: ${opened.message}`);
    }
    const ticketId = opened.data.id;
    // Attempts belong to active work and only IN_PROGRESS (and waiting
    // states) resolve: NEW → TRIAGING → IN_PROGRESS first.
    for (const toStatus of ["TRIAGING", "IN_PROGRESS"] as const) {
      expect((await bus.execute(ownerActor(), "support.ticket.transition", { ticketId, toStatus })).ok).toBe(true);
    }
    const attempt = await bus.execute(ownerActor(), "support.ticket.add_solution_attempt", {
      ticketId,
      procedureKey: "restart-app",
      outcome: "SUCCEEDED",
    });
    expect(attempt.ok).toBe(true);

    const parked = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      payload: { command: "support.ticket.resolve", input: { ticketId } },
    });
    expect(parked.statusCode).toBe(201);
    const reviewId = parked.json<{ reviewId: string }>().reviewId;

    const approved = await approveReview(reviewId);
    expect(approved.statusCode).toBe(201);

    const executed = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      payload: { command: "support.ticket.resolve", input: { ticketId }, reviewId },
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json<{ status: string }>().status).toBe("executed");
    expect(await ticketStatus(ticketId)).toBe("RESOLVED");
  });

  it("execute rejects a stale expectedStatus with 409 and changes nothing", async () => {
    const personId = await makePerson();
    const opened = await bus.execute<{ id: string }>(ownerActor(), "support.ticket.open", {
      personId,
      summary: "stale probe",
    });
    if (!opened.ok) {
      throw new Error(`ticket.open failed: ${opened.message}`);
    }
    const res = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      payload: {
        command: "support.ticket.resolve",
        input: { ticketId: opened.data.id, expectedStatus: "IN_PROGRESS" },
        reviewId: newId(),
      },
    });
    // Review id is unknown here, but the stale/unknown-review guard fires
    // before any execution either way: assert the ticket is untouched and
    // the rejection carries the NOT_FOUND code.
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe("NOT_FOUND");
    expect(await ticketStatus(opened.data.id)).toBe("NEW");

    // Same command with a mismatched expectedStatus on the MEDIUM path is
    // not applicable (resolve is HIGH); assert the direct stale guard via
    // an approved-review mismatch instead: resolve was requested above for
    // the approval-probe ticket, reuse is input-bound so a tampered input
    // hash is stale.
    const probe = await bus.execute<{ id: string }>(ownerActor(), "support.ticket.open", {
      personId,
      summary: "stale probe 2",
    });
    if (!probe.ok) {
      throw new Error(`ticket.open failed: ${probe.message}`);
    }
    // Bring the probe to honest IN_PROGRESS before parking the approval.
    for (const toStatus of ["TRIAGING", "IN_PROGRESS"] as const) {
      expect(
        (await bus.execute(ownerActor(), "support.ticket.transition", { ticketId: probe.data.id, toStatus })).ok,
      ).toBe(true);
    }
    const parked = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      payload: { command: "support.ticket.resolve", input: { ticketId: probe.data.id, expectedStatus: "IN_PROGRESS" } },
    });
    expect(parked.statusCode).toBe(201);
    const parkedReview = parked.json<{ reviewId: string }>().reviewId;
    const parkedApproval = await approveReview(parkedReview);
    expect(parkedApproval.statusCode).toBe(201);
    // Mutate the ticket out from under the approval, then execute with the
    // now-stale expectedStatus: the guard must refuse.
    await bus.execute(ownerActor(), "support.ticket.transition", {
      ticketId: probe.data.id,
      toStatus: "WAITING_CUSTOMER",
    });
    const staleExec = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      payload: {
        command: "support.ticket.resolve",
        input: { ticketId: probe.data.id, expectedStatus: "IN_PROGRESS" },
        reviewId: parkedReview,
      },
    });
    expect(staleExec.statusCode).toBe(409);
    expect(staleExec.json<{ code: string }>().code).toBe("STALE");
    expect(await ticketStatus(probe.data.id)).toBe("WAITING_CUSTOMER");
  });

  it("execute rejects unknown commands and cross-tenant targets", async () => {
    const unknown = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      payload: { command: "billing.refund.execute", input: {} },
    });
    expect(unknown.statusCode).toBe(404);

    // Foreign ticket id through a HIGH-risk command without review parks in
    // HITL (no existence oracle); through close with a forged approval the
    // tenant scope yields not_found. Use close + fabricated review → 404.
    const personId = await makePerson();
    const opened = await bus.execute<{ id: string }>(ownerActor(), "support.ticket.open", {
      personId,
      summary: "x-tenant probe",
    });
    if (!opened.ok) {
      throw new Error(`ticket.open failed: ${opened.message}`);
    }
    const foreign = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenTenantB,
      payload: { command: "support.ticket.close", input: { ticketId: opened.data.id }, reviewId: newId() },
    });
    expect(foreign.statusCode).toBe(404);
    expect(await ticketStatus(opened.data.id)).toBe("NEW");
  });

  it("G18: filtered view → explain → prepare → execute allowed command with approval where required", async () => {
    const personId = await makePerson();
    // (1) Filtered view context.
    const context = await inject({
      method: "GET",
      url: "/v1/agent/copilot/context?route=/support&filters=%7B%22status%22%3A%22NEW%22%7D",
      token: tokenOwner,
    });
    expect(context.statusCode).toBe(200);
    expect(context.json<{ route: string }>().route).toBe("/support");

    // (2) Copilot explains the filtered screen.
    const ask = await inject({
      method: "POST",
      url: "/v1/agent/copilot/ask",
      token: tokenOwner,
      payload: {
        question: "explique os tickets novos e abra um ticket para acompanhamento",
        screen: { route: "/support", filters: { status: "NEW" } },
      },
    });
    expect(ask.statusCode).toBe(201);
    const draft = ask
      .json<{ suggestions: Array<{ kind: string; draftCommand?: string; draftInput?: Record<string, unknown> }> }>()
      .suggestions.find((s) => s.draftCommand === "support.ticket.open");
    expect(draft).toBeDefined();

    // (3) Prepare + execute the allowed command through the same pipeline.
    const opened = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      payload: { command: "support.ticket.open", input: { personId, summary: "G18 follow-up" } },
    });
    expect(opened.statusCode).toBe(200);
    const ticketId = opened.json<{ data: { id: string } }>().data.id;
    expect(await ticketStatus(ticketId)).toBe("NEW");

    // (4) Sensitive follow-up requires approval: park, approve, execute.
    for (const toStatus of ["TRIAGING", "IN_PROGRESS"] as const) {
      expect((await bus.execute(ownerActor(), "support.ticket.transition", { ticketId, toStatus })).ok).toBe(true);
    }
    const attempt = await bus.execute(ownerActor(), "support.ticket.add_solution_attempt", {
      ticketId,
      procedureKey: "restart-app",
      outcome: "SUCCEEDED",
    });
    expect(attempt.ok).toBe(true);
    const parked = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      payload: { command: "support.ticket.resolve", input: { ticketId } },
    });
    expect(parked.statusCode).toBe(201);
    const reviewId = parked.json<{ reviewId: string }>().reviewId;
    expect(await ticketStatus(ticketId)).toBe("IN_PROGRESS");

    const approved = await approveReview(reviewId);
    expect(approved.statusCode).toBe(201);

    const executed = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      payload: { command: "support.ticket.resolve", input: { ticketId }, reviewId },
    });
    expect(executed.statusCode).toBe(200);
    expect(await ticketStatus(ticketId)).toBe("RESOLVED");
  });

  it("self-approval of a copilot_command review is forbidden; another approver succeeds", async () => {
    const personId = await makePerson();
    const opened = await bus.execute<{ id: string }>(ownerActor(), "support.ticket.open", {
      personId,
      summary: "self-approval probe",
    });
    if (!opened.ok) {
      throw new Error(`ticket.open failed: ${opened.message}`);
    }
    await prepareResolvable(opened.data.id);
    const parked = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      payload: { command: "support.ticket.resolve", input: { ticketId: opened.data.id } },
    });
    expect(parked.statusCode).toBe(201);
    const reviewId = parked.json<{ reviewId: string }>().reviewId;

    // The requester cannot approve their own review…
    const self = await approveReviewAsRequester(reviewId);
    expect(self.statusCode).toBe(409);
    expect(self.json<{ code: string }>().code).toBe("PRECONDITION_FAILED");
    const stillOpen = await db
      .selectFrom("agent.human_review_requests")
      .select(["status"])
      .where("tenant_id", "=", tenantA)
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();
    expect(["REQUESTED", "QUEUED", "ACKNOWLEDGED", "IN_REVIEW"]).toContain(stillOpen.status);

    // …but a different approver can, and the execution then succeeds.
    const other = await approveReview(reviewId);
    expect(other.statusCode).toBe(201);
    const executed = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      payload: { command: "support.ticket.resolve", input: { ticketId: opened.data.id }, reviewId },
    });
    expect(executed.statusCode).toBe(200);
    expect(await ticketStatus(opened.data.id)).toBe("RESOLVED");
  });

  it("an approved review authorizes exactly one execution (re-execute → 409 CONSUMED)", async () => {
    const personId = await makePerson();
    const opened = await bus.execute<{ id: string }>(ownerActor(), "support.ticket.open", {
      personId,
      summary: "single-use probe",
    });
    if (!opened.ok) {
      throw new Error(`ticket.open failed: ${opened.message}`);
    }
    await prepareResolvable(opened.data.id);
    const parked = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      payload: { command: "support.ticket.resolve", input: { ticketId: opened.data.id } },
    });
    expect(parked.statusCode).toBe(201);
    const reviewId = parked.json<{ reviewId: string }>().reviewId;
    expect((await approveReview(reviewId)).statusCode).toBe(201);

    const first = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      payload: { command: "support.ticket.resolve", input: { ticketId: opened.data.id }, reviewId },
    });
    expect(first.statusCode).toBe(200);
    expect(await ticketStatus(opened.data.id)).toBe("RESOLVED");

    // Same reviewId again: the approval is consumed, nothing re-executes.
    const again = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      payload: { command: "support.ticket.resolve", input: { ticketId: opened.data.id }, reviewId },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ code: string }>().code).toBe("CONSUMED");
    expect(await ticketStatus(opened.data.id)).toBe("RESOLVED");
    const consumptions = await db
      .selectFrom("agent.copilot_review_consumptions")
      .select(["human_review_request_id"])
      .where("tenant_id", "=", tenantA)
      .where("human_review_request_id", "=", reviewId)
      .execute();
    expect(consumptions).toHaveLength(1);
  });

  it("execute honors the Idempotency-Key header (replay returns the same ticket)", async () => {
    const personId = await makePerson();
    const key = `copilot-probe-${newId()}`;
    const payload = { command: "support.ticket.open", input: { personId, summary: "idempotency probe" } };
    const first = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      headers: { "idempotency-key": key },
      payload,
    });
    expect(first.statusCode).toBe(200);
    const second = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      headers: { "idempotency-key": key },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ data: { id: string } }>().data.id).toBe(first.json<{ data: { id: string } }>().data.id);
  });

  it("execute propagates the HTTP request id as the bus correlationId", async () => {
    const personId = await makePerson();
    const res = await inject({
      method: "POST",
      url: "/v1/agent/copilot/execute",
      token: tokenOwner,
      payload: { command: "support.ticket.open", input: { personId, summary: "correlation probe" } },
    });
    expect(res.statusCode).toBe(200);
    const requestId = res.headers["x-request-id"];
    expect(typeof requestId).toBe("string");
    const audit = await db
      .selectFrom("platform.audit_log")
      .select(["correlation_id"])
      .where("tenant_id", "=", tenantA)
      .where("action_key", "=", "support.ticket.open")
      .orderBy("occurred_at", "desc")
      .executeTakeFirstOrThrow();
    expect(audit.correlation_id).toBe(requestId);
  });
});
