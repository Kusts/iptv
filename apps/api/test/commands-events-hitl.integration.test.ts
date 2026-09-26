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
import { OutboxDrainer } from "../src/outbox/outbox-drainer.js";
import { InboxProcessor } from "../src/inbox/inbox-processor.js";
import { LocalTransport } from "../src/outbox/transport.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(0, 12)}@example.com`;
}

describe.skipIf(!hasDb)("commands → events → outbox → inbox → audit + HITL (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  const user = { email: email("w1-cmd"), password: "correct-horse-8" };
  let token = "";
  let tenantId = "";
  let userId = "";

  let bus: CommandBus;
  let drainer: OutboxDrainer;
  let inbox: InboxProcessor;
  let transport: LocalTransport;

  function actor(): CommandActor {
    return {
      userId,
      isPlatformAdmin: false,
      tenantId,
      roleKeys: ["tenant_owner"],
      permissions: [
        "crm.person.read",
        "crm.lead.write",
        "conversation.reply",
        "settings.manage",
        "tenant.member.manage",
        "billing.read",
        "audit.read",
        "support.ticket.write",
        "agent.review.request",
        "agent.review.decide",
      ],
      actorType: "human",
    };
  }

  function inject(opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    payload?: Record<string, unknown>;
    idempotencyKey?: string;
  }) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
    }
    if (opts.idempotencyKey !== undefined) {
      headers["idempotency-key"] = opts.idempotencyKey;
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

  function reviewInput(summary: string) {
    return {
      resourceType: "refund_request",
      resourceId: newId(),
      reviewMode: "APPROVAL",
      reason: "FINANCIAL_REVIEW",
      summary,
    };
  }

  async function outboxStates(): Promise<Record<string, number>> {
    const rows = await db.selectFrom("platform.outbox_messages").select(["state"]).execute();
    const counts: Record<string, number> = {};
    for (const r of rows) {
      counts[r.state] = (counts[r.state] ?? 0) + 1;
    }
    return counts;
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
    inbox = app.get(InboxProcessor);
    transport = app.get("TRANSPORT");

    expect(bus.names()).toEqual([
      "human_review.request",
      "human_review.approve",
      "human_review.reject",
      "policy.publish",
      "capability.register",
      "capability.set_availability",
      "person.register",
      "lead.capture",
      "lead.transition",
      "conversation.start_manual",
      "message.send_manual",
      "message.ingest",
      "conversation.assign",
      "conversation.release",
      "conversation.close",
      "exception.resolve",
    ]);

    const register = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: user.email, password: user.password, tenantName: "Command Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it("command writes state + domain event + outbox in one transaction", async () => {
    const correlationId = newId();
    const result = await bus.execute<{ id: string }>(actor(), "human_review.request", reviewInput("chain one"), {
      correlationId,
      idempotencyKey: `chain-${correlationId}`,
    });
    expect(result.ok).toBe(true);
    const id = (result as { ok: true; data: { id: string } }).data.id;

    const events = await db
      .selectFrom("platform.domain_events")
      .select(["event_type", "aggregate_version", "schema_version", "correlation_id"])
      .where("tenant_id", "=", tenantId)
      .where("aggregate_id", "=", id)
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe("hitl.review_requested.v1");
    expect(Number(events[0]?.aggregate_version)).toBe(1);
    expect(events[0]?.schema_version).toBe(1);

    const outbox = await db
      .selectFrom("platform.outbox_messages")
      .select(["state", "topic"])
      .where("tenant_id", "=", tenantId)
      .execute();
    expect(outbox.some((r) => r.state === "PENDING" && r.topic === "hitl.review_requested.v1")).toBe(true);

    const audits = await db
      .selectFrom("platform.audit_log")
      .select(["action_key", "correlation_id"])
      .where("tenant_id", "=", tenantId)
      .where("correlation_id", "=", correlationId)
      .execute();
    expect(audits.some((r) => r.action_key === "human_review.request")).toBe(true);
  });

  it("idempotency replay returns the same result without re-executing", async () => {
    const key = `replay-${newId()}`;
    const input = reviewInput("replay me");
    const first = await bus.execute<{ id: string }>(actor(), "human_review.request", input, { idempotencyKey: key });
    expect(first.ok).toBe(true);
    const before = await db
      .selectFrom("platform.domain_events")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .execute();
    const second = await bus.execute(actor(), "human_review.request", input, { idempotencyKey: key });
    expect(second).toEqual(first);
    const after = await db
      .selectFrom("platform.domain_events")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .execute();
    expect(after).toHaveLength(before.length);
  });

  it("parallel drains process disjoint rows (SKIP LOCKED)", async () => {
    for (let i = 0; i < 4; i += 1) {
      const r = await bus.execute(actor(), "human_review.request", reviewInput(`parallel ${i}`));
      expect(r.ok).toBe(true);
    }
    const [a, b] = await Promise.all([drainer.drain(10), drainer.drain(10)]);
    const ids = [...a.eventIds, ...b.eventIds];
    // 4 fresh rows + leftovers from earlier tests drain here too; every
    // claimed row is published exactly once across both drains.
    expect(new Set(ids).size).toBe(ids.length);
    expect(a.published + b.published).toBe(ids.length);
    expect(a.published + b.published).toBeGreaterThanOrEqual(4);
    const states = await outboxStates();
    expect(states["PENDING"] ?? 0).toBe(0);
    expect(states["PUBLISHING"] ?? 0).toBe(0);
  });

  it("inbox accepts once: second accept is a dedupe no-op", async () => {
    const delivered = transport.published.filter((e) => e.tenant_id === tenantId);
    expect(delivered.length).toBeGreaterThan(0);
    const envelope = delivered[0] as (typeof delivered)[number];
    let calls = 0;
    inbox.on(envelope.event_type, async () => {
      calls += 1;
    });
    const payload = JSON.parse(JSON.stringify(envelope)) as unknown;
    const first = await inbox.accept({
      tenantId,
      provider: "local-outbox",
      externalEventId: envelope.event_id,
      payload,
      correlationId: envelope.correlation_id,
    });
    expect(first.status).toBe("processed");
    const second = await inbox.accept({
      tenantId,
      provider: "local-outbox",
      externalEventId: envelope.event_id,
      payload,
      correlationId: envelope.correlation_id,
    });
    expect(second.status).toBe("duplicate");
    expect(second.inboxId).toBe(first.inboxId);
    expect(calls).toBe(1);
    const rows = await db
      .selectFrom("platform.inbox_messages")
      .select(["id", "state"])
      .where("tenant_id", "=", tenantId)
      .where("provider", "=", "local-outbox")
      .where("external_event_id", "=", envelope.event_id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("PROCESSED");
  });

  it("stale approvals are rejected; fresh decision resolves with version 2", async () => {
    const created = await bus.execute<{ id: string }>(actor(), "human_review.request", reviewInput("stale check"));
    expect(created.ok).toBe(true);
    const id = (created as { ok: true; data: { id: string } }).data.id;

    const stale = await bus.execute(actor(), "human_review.approve", { requestId: id, expectedStatus: "QUEUED" });
    expect(stale.ok ? null : stale.code).toBe("precondition_failed");

    const approved = await bus.execute<{ id: string; resolution: string }>(actor(), "human_review.approve", {
      requestId: id,
      expectedStatus: "REQUESTED",
      note: "verified, approve",
    });
    expect(approved).toEqual({ ok: true, data: { id, resolution: "APPROVED" } });

    const versions = await db
      .selectFrom("platform.domain_events")
      .select(["event_type", "aggregate_version"])
      .where("tenant_id", "=", tenantId)
      .where("aggregate_id", "=", id)
      .orderBy("aggregate_version", "asc")
      .execute();
    expect(versions.map((v) => `${v.event_type}#${Number(v.aggregate_version)}`)).toEqual([
      "hitl.review_requested.v1#1",
      "hitl.review_resolved.v1#2",
    ]);

    const again = await bus.execute(actor(), "human_review.reject", { requestId: id });
    expect(again.ok ? null : again.code).toBe("precondition_failed");

    const actions = await db
      .selectFrom("agent.human_review_actions")
      .select(["action_type"])
      .where("tenant_id", "=", tenantId)
      .where("human_review_request_id", "=", id)
      .execute();
    expect(actions.map((a) => a.action_type)).toEqual(["APPROVE"]);
  });

  it("HTTP queue is tenant-scoped and the drain endpoint is platform-admin-only", async () => {
    const posted = await inject({
      method: "POST",
      url: "/v1/human-reviews",
      token,
      payload: reviewInput("http queue item"),
    });
    expect(posted.statusCode).toBe(201);

    const queue = await inject({ method: "GET", url: "/v1/human-reviews?status=PENDING", token });
    expect(queue.statusCode).toBe(200);
    const summaries = queue.json<{ reviews: Array<{ summary: string }> }>().reviews.map((r) => r.summary);
    expect(summaries).toContain("http queue item");

    const badStatus = await inject({ method: "GET", url: "/v1/human-reviews?status=NOPE", token });
    expect(badStatus.statusCode).toBe(400);

    const forbiddenDrain = await inject({ method: "POST", url: "/v1/admin/outbox/drain", token, payload: {} });
    expect(forbiddenDrain.statusCode).toBe(403);

    await db.updateTable("control.users").set({ is_platform_admin: true }).where("id", "=", userId).execute();
    const drained = await inject({ method: "POST", url: "/v1/admin/outbox/drain", token, payload: { limit: 10 } });
    expect(drained.statusCode).toBe(200);
    await db.updateTable("control.users").set({ is_platform_admin: false }).where("id", "=", userId).execute();

    const stranger = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w1-stranger"), password: "correct-horse-8", tenantName: "Other" },
    });
    const strangerToken = stranger.json<{ token: string }>().token;
    const foreignQueue = await inject({ method: "GET", url: "/v1/human-reviews?status=PENDING", token: strangerToken });
    expect(foreignQueue.statusCode).toBe(200);
    expect(foreignQueue.json<{ reviews: unknown[] }>().reviews).toHaveLength(0);
  });
});
