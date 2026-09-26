import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
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
import { AgentPipeline } from "../src/agent/pipeline.js";
import { resetGatewayForTests } from "../src/communications/messaging-gateway.js";
import { WahaWebhookService } from "../src/communications/waha-webhook.service.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(0, 12)}@example.com`;
}

describe.skipIf(!hasDb)("Wave 3 agent shadow → approval → send (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let token = "";
  let tenantId = "";
  let userId = "";
  let bus: CommandBus;
  let pipeline: AgentPipeline;
  let webhooks: WahaWebhookService;

  function actor(): CommandActor {
    return {
      userId,
      isPlatformAdmin: false,
      tenantId,
      roleKeys: ["tenant_owner"],
      permissions: ["crm.person.read", "crm.lead.write", "conversation.reply", "agent.review.request", "agent.review.decide"],
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

  async function outboundCount(conversationId: string): Promise<number> {
    const rows = await db
      .selectFrom("communication.messages")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("conversation_id", "=", conversationId)
      .where("direction", "=", "OUTBOUND")
      .execute();
    return rows.length;
  }

  async function runCount(conversationId: string): Promise<number> {
    const rows = await db
      .selectFrom("agent.agent_runs")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("conversation_id", "=", conversationId)
      .execute();
    return rows.length;
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    delete process.env["WAHA_BASE_URL"];
    delete process.env["WAHA_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    resetGatewayForTests();
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);
    pipeline = app.get(AgentPipeline);
    webhooks = app.get(WahaWebhookService);

    const register = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w3"), password: "correct-horse-8", tenantName: "Wave3 Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;
  }, 120_000);

  afterAll(async () => {
    resetGatewayForTests();
    await app.close();
    await db.destroy();
  });

  it("autonomy capability is UNCERTIFIED/UNAVAILABLE by default (no autonomous send)", async () => {
    const cap = await db
      .selectFrom("platform.capabilities")
      .select(["availability", "certification_status"])
      .where("key", "=", "ai.reply_autonomous")
      .executeTakeFirstOrThrow();
    expect(cap.availability).toBe("UNAVAILABLE");
    expect(cap.certification_status).toBe("UNCERTIFIED");
  });

  it("inbound → SHADOW run persisted + HumanReview created; shadow NEVER sends", async () => {
    const person = (await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Cliente W3",
      identities: [{ identityType: "WHATSAPP", normalizedValue: "5511999990301" }],
    })) as { ok: true; data: { id: string } };
    const conv = (await bus.execute<{ id: string }>(actor(), "conversation.start_manual", {
      personId: person.data.id,
      channel: "WHATSAPP",
    })) as { ok: true; data: { id: string } };
    const conversationId = conv.data.id;
    // Return the conversation to the agent so evaluation is eligible.
    expect((await bus.execute(actor(), "conversation.release", { conversationId })).ok).toBe(true);

    const ingest = await bus.execute<{
      messageId: string | null;
      conversationId: string | null;
      exceptionId: string | null;
      duplicate: boolean;
    }>(actor(), "message.ingest", {
      channel: "WHATSAPP",
      externalMessageId: `wamsg-w3-${randomUUID()}`,
      from: "5511999990301@c.us",
      text: "Olá, quero saber mais",
      occurredAt: new Date().toISOString(),
    });
    expect(ingest.ok).toBe(true);

    const outcome = await pipeline.evaluateInbound({ tenantId, conversationId, inboundText: "Olá, quero saber mais" });
    expect(outcome).toMatchObject({ evaluated: true, mode: "SHADOW", sent: false });
    if (!outcome.evaluated) {
      throw new Error("expected evaluation");
    }

    const runs = await db
      .selectFrom("agent.agent_runs")
      .select(["id", "mode", "status", "release_key", "proposal_kind", "proposal_label", "human_review_request_id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", outcome.runId)
      .executeTakeFirstOrThrow();
    expect(runs.mode).toBe("SHADOW");
    expect(runs.status).toBe("PROPOSED");
    expect(runs.release_key).toBe("customer-agent-v1");
    expect(runs.human_review_request_id).toBe(outcome.reviewId);

    const review = await db
      .selectFrom("agent.human_review_requests")
      .select(["id", "status", "review_mode", "resource_type", "reason"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", outcome.reviewId as string)
      .executeTakeFirstOrThrow();
    expect(review).toMatchObject({ status: "REQUESTED", review_mode: "APPROVAL", resource_type: "agent_proposal" });

    // SHADOW NEVER sends: no outbound message exists.
    expect(await outboundCount(conversationId)).toBe(0);

    // Runs are visible on the endpoint.
    const listed = await inject({ method: "GET", url: `/v1/agent/runs?conversationId=${conversationId}`, token });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ runs: Array<{ id: string }> }>().runs.map((r) => r.id)).toContain(outcome.runId);
  });

  it("approve → resume path sends via message.send_manual (echo gateway)", async () => {
    const convId = (
      await db
        .selectFrom("communication.conversations")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow()
    ).id;
    const reviewId = (
      await db
        .selectFrom("agent.human_review_requests")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("resource_type", "=", "agent_proposal")
        .where("status", "=", "REQUESTED")
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow()
    ).id;

    const approved = await inject({ method: "POST", url: `/v1/agent/reviews/${reviewId}/approve`, token, payload: {} });
    expect(approved.statusCode).toBe(201);
    expect(approved.json<{ sent: boolean }>().sent).toBe(true);

    expect(await outboundCount(convId)).toBe(1);
    const delivery = await db
      .selectFrom("communication.message_deliveries")
      .select(["status", "provider"])
      .where("tenant_id", "=", tenantId)
      .orderBy("occurred_at", "desc")
      .executeTakeFirstOrThrow();
    expect(delivery.status).toBe("SENT");

    const run = await db
      .selectFrom("agent.agent_runs")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("human_review_request_id", "=", reviewId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe("SENT");

    // Registry-listed events only: review resolution + outbound send.
    const events = await db
      .selectFrom("platform.domain_events")
      .select(["event_type"])
      .where("tenant_id", "=", tenantId)
      .where("event_type", "in", ["hitl.review_resolved.v1", "message.sent.v1"])
      .execute();
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it("reject → discard logged, nothing sent", async () => {
    const convId = (
      await db
        .selectFrom("communication.conversations")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow()
    ).id;
    const before = await outboundCount(convId);
    const outcome = await pipeline.evaluateInbound({ tenantId, conversationId: convId, inboundText: "Olá de novo" });
    expect(outcome.evaluated).toBe(true);
    if (!outcome.evaluated) {
      throw new Error("expected evaluation");
    }
    const rejected = await inject({
      method: "POST",
      url: `/v1/agent/reviews/${outcome.reviewId as string}/reject`,
      token,
      payload: { note: "not appropriate" },
    });
    expect(rejected.statusCode).toBe(201);
    expect(await outboundCount(convId)).toBe(before);
    const run = await db
      .selectFrom("agent.agent_runs")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", outcome.runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe("DISCARDED");
  });

  it("takeover suppresses evaluation (no run, no review)", async () => {
    const convId = (
      await db
        .selectFrom("communication.conversations")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow()
    ).id;
    expect((await bus.execute(actor(), "conversation.assign", { conversationId: convId })).ok).toBe(true);
    const before = await runCount(convId);
    const outcome = await pipeline.evaluateInbound({ tenantId, conversationId: convId, inboundText: "alguém aí?" });
    expect(outcome).toEqual({ evaluated: false, reason: "takeover" });
    expect(await runCount(convId)).toBe(before);
    // Return to the agent for the remaining tests.
    expect((await bus.execute(actor(), "conversation.release", { conversationId: convId })).ok).toBe(true);
  });

  it("post-ingest webhook hook enqueues evaluation automatically", async () => {
    const convId = (
      await db
        .selectFrom("communication.conversations")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow()
    ).id;
    const before = await runCount(convId);
    const externalId = `wamsg-hook-${randomUUID()}`;
    const accepted = await webhooks.acceptRaw({
      tenantId,
      channel: "WHATSAPP",
      externalEventId: `waha:${externalId}`,
      payload: {
        event: "message",
        session: "default",
        payload: { id: externalId, from: "5511999990301@c.us", fromMe: false, body: "Olá via webhook", timestamp: 1758912000 },
      },
    });
    expect(accepted.inserted).toBe(true);
    await webhooks.processRow(tenantId, accepted.inboxId, {
      event: "message",
      session: "default",
      payload: { id: externalId, from: "5511999990301@c.us", fromMe: false, body: "Olá via webhook", timestamp: 1758912000 },
    });
    expect(await runCount(convId)).toBe(before + 1);
  });

  it("unauthorized tool/command use is denied by the bus", async () => {
    const weak = { ...actor(), permissions: ["crm.person.read"] };
    const result = await bus.execute(weak, "human_review.request", {
      resourceType: "agent_proposal",
      resourceId: newId(),
      reviewMode: "APPROVAL",
      reason: "RISK_REVIEW",
      summary: "no permission",
    });
    expect(result.ok ? null : result.code).toBe("forbidden");
  });

  it("evals endpoint returns a green fixture summary", async () => {
    const res = await inject({ method: "POST", url: "/v1/agent/evals/run", token, payload: {} });
    expect(res.statusCode).toBe(201);
    const summary = res.json<{ total: number; passed: number; failed: number }>();
    expect(summary.total).toBeGreaterThanOrEqual(6);
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(summary.total);
  });
});
