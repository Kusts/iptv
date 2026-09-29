import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
import {
  GatewayUnknownError,
  resetGatewayForTests,
  setGatewayForTests,
  type MessagingGatewayPort,
  type SendTextInput,
  type SendTextResult,
} from "../src/communications/messaging-gateway.js";
import { setRiskState } from "../src/communications/waha-risk-state.js";
import { bindSession, clearSessionBindingsForTests } from "../src/communications/waha-sessions.js";
import { WahaWebhookService } from "../src/communications/waha-webhook.service.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(0, 12)}@example.com`;
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, "fixtures", name), "utf8")) as unknown;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe.skipIf(!hasDb)("Wave 2 CRM + Communications (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let token = "";
  let tenantId = "";
  let userId = "";
  let bus: CommandBus;
  let drainer: OutboxDrainer;
  let webhooks: WahaWebhookService;

  const tenantKey = `w2-${randomUUID().slice(0, 8)}`;
  const webhookSecret = `w2-secret-${randomUUID().slice(0, 8)}`;

  function actor(): CommandActor {
    return {
      userId,
      isPlatformAdmin: false,
      tenantId,
      roleKeys: ["tenant_owner"],
      permissions: ["crm.person.read", "crm.lead.write", "conversation.reply"],
      actorType: "human",
    };
  }

  function inject(opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    /** Tenant-context precondition; defaults to "0" with a token, `null` omits it. */
    revision?: string | null;
    secret?: string;
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
      if (opts.revision !== null) {
        headers["x-tenant-context-revision"] = opts.revision ?? "0";
      }
    }
    if (opts.secret !== undefined) {
      headers["x-waha-secret"] = opts.secret;
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

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    delete process.env["WAHA_BASE_URL"];
    delete process.env["WAHA_API_KEY"];
    resetGatewayForTests();
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);
    drainer = app.get(OutboxDrainer);
    webhooks = app.get(WahaWebhookService);

    const register = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w2"), password: "correct-horse-8", tenantName: "Wave2 Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;

    await db
      .insertInto("communication.tenant_channels")
      .values({
        id: newId(),
        tenant_id: tenantId,
        channel: "WHATSAPP",
        tenant_key: tenantKey,
        webhook_secret_hash: sha256(webhookSecret),
        status: "ACTIVE",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
  }, 120_000);

  afterAll(async () => {
    resetGatewayForTests();
    // Hygiene: leave no PENDING outbox rows behind for other files that
    // assert on global outbox state.
    try {
      await drainer.drain(500);
    } catch {
      // Best effort; app close still runs below.
    }
    await app.close();
    await db.destroy();
  });

  it("CRM: register → capture → transition with registry events, invalid transition rejected", async () => {
    const person = await inject({
      method: "POST",
      url: "/v1/crm/persons",
      token,
      payload: { canonicalName: "Lead W2", identities: [{ identityType: "WHATSAPP", normalizedValue: "5511999990101" }] },
    });
    expect(person.statusCode).toBe(201);
    const personId = person.json<{ id: string }>().id;

    const got = await inject({ method: "GET", url: `/v1/crm/persons/${personId}`, token });
    expect(got.statusCode).toBe(200);
    expect(got.json<{ identities: unknown[] }>().identities).toHaveLength(1);

    const lead = await inject({
      method: "POST",
      url: "/v1/crm/leads",
      token,
      payload: { personId },
    });
    expect(lead.statusCode).toBe(201);
    const leadId = lead.json<{ id: string }>().id;

    const transition = await inject({
      method: "POST",
      url: `/v1/crm/leads/${leadId}/transition`,
      token,
      payload: { toStatus: "CONTACTED" },
    });
    expect(transition.statusCode).toBe(201);

    const invalid = await inject({
      method: "POST",
      url: `/v1/crm/leads/${leadId}/transition`,
      token,
      payload: { toStatus: "CONVERTED" },
    });
    expect(invalid.statusCode).toBe(409);

    const events = await db
      .selectFrom("platform.domain_events")
      .select(["event_type"])
      .where("tenant_id", "=", tenantId)
      .where("aggregate_id", "in", [personId, leadId])
      .execute();
    const types = events.map((e) => e.event_type).sort();
    expect(types).toEqual(["lead.created.v1", "person.created.v1"]);

    // No Customer row is ever created by this slice.
    const customers = await db
      .selectFrom("crm.customers")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .execute();
    expect(customers).toHaveLength(0);
  });

  it("webhook: 202 fast ack → normalize → message row; duplicate is a dedupe no-op", async () => {
    const payload = fixture("waha-message.json") as Record<string, unknown>;
    // Point the fixture at the person created above.
    const persons = await inject({ method: "GET", url: "/v1/crm/persons?limit=100", token });
    const known = (persons.json<{ persons: Array<{ id: string }> }>().persons[0] as { id: string }).id;
    await db
      .updateTable("identity.identities")
      .set({ normalized_value: "5511999990001" })
      .where("tenant_id", "=", tenantId)
      .where("person_id", "=", known)
      .execute();
    void known;

    // Open a conversation for the sender so ingest has a target.
    const start = await bus.execute<{ id: string }>(actor(), "conversation.start_manual", {
      personId: (await db.selectFrom("identity.persons").select(["id"]).where("tenant_id", "=", tenantId).orderBy("created_at", "asc").executeTakeFirstOrThrow()).id,
      channel: "WHATSAPP",
    });
    expect(start.ok).toBe(true);

    const first = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKey}`,
      secret: webhookSecret,
      payload,
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ accepted: true, deduped: false });

    const messages = await db
      .selectFrom("communication.messages")
      .select(["id", "direction", "body_text", "external_message_id"])
      .where("tenant_id", "=", tenantId)
      .where("external_message_id", "=", "wamsg-001")
      .execute();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.direction).toBe("INBOUND");

    const inbox = await db
      .selectFrom("platform.inbox_messages")
      .select(["id", "state"])
      .where("tenant_id", "=", tenantId)
      .where("provider", "=", "waha")
      .where("external_event_id", "=", "waha:wamsg-001")
      .execute();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.state).toBe("PROCESSED");

    const duplicate = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKey}`,
      secret: webhookSecret,
      payload,
    });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toEqual({ accepted: true, deduped: true });
    const again = await db
      .selectFrom("communication.messages")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("external_message_id", "=", "wamsg-001")
      .execute();
    expect(again).toHaveLength(1);
  });

  it("webhook: unknown senders queue exceptions; resolve maps them to a person", async () => {
    const payload = {
      event: "message",
      session: "default",
      payload: { id: `wamsg-unknown-${Date.now()}`, from: "5511888880099@c.us", fromMe: false, body: "alguém aí?", timestamp: 1758912000 },
    };
    const deferred = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKey}?defer=1`,
      secret: webhookSecret,
      payload,
    });
    expect(deferred.statusCode).toBe(202);
    // Deferred: accepted durably, nothing normalized yet.
    const before = await db
      .selectFrom("communication.messages")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("external_message_id", "=", payload.payload.id)
      .execute();
    expect(before).toHaveLength(0);

    const drained = await webhooks.drainPending();
    expect(drained.processed).toBeGreaterThanOrEqual(1);

    const queue = await inject({ method: "GET", url: "/v1/communications/exceptions", token });
    expect(queue.statusCode).toBe(200);
    const items = queue.json<{ exceptions: Array<{ id: string; status: string; fromAddress: string }> }>().exceptions;
    const item = items.find((e) => e.fromAddress === "5511888880099@c.us");
    expect(item?.status).toBe("OPEN");

    const personId = (
      await db
        .selectFrom("identity.persons")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .orderBy("created_at", "asc")
        .executeTakeFirstOrThrow()
    ).id;
    const resolved = await inject({
      method: "POST",
      url: `/v1/communications/exceptions/${item?.id}/resolve`,
      token,
      payload: { action: "map", personId },
    });
    expect(resolved.statusCode).toBe(201);
    expect(resolved.json<{ status: string }>().status).toBe("RESOLVED");
  });

  it("webhook: unknown event types still 202 without domain mutation; bad secret is 401", async () => {
    const before = await db
      .selectFrom("communication.messages")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .execute();
    const res = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKey}`,
      secret: webhookSecret,
      payload: fixture("waha-unknown-event.json") as Record<string, unknown>,
    });
    expect(res.statusCode).toBe(202);
    const after = await db
      .selectFrom("communication.messages")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .execute();
    expect(after).toHaveLength(before.length);

    const badSecret = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKey}`,
      secret: "wrong",
      payload: fixture("waha-message.json") as Record<string, unknown>,
    });
    expect(badSecret.statusCode).toBe(401);

    const unknownKey = await inject({
      method: "POST",
      url: "/v1/webhooks/waha/no-such-key",
      secret: webhookSecret,
      payload: fixture("waha-message.json") as Record<string, unknown>,
    });
    expect(unknownKey.statusCode).toBe(404);
  });

  it("webhook: shared WAHA_WEBHOOK_SECRET fallback no longer authenticates a channel without a secret (503)", async () => {
    const fallbackKey = `w2-nofallback-${randomUUID().slice(0, 8)}`;
    await db
      .insertInto("communication.tenant_channels")
      .values({
        id: newId(),
        tenant_id: tenantId,
        channel: "WHATSAPP",
        tenant_key: fallbackKey,
        webhook_secret_hash: null,
        status: "ACTIVE",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const messageId = `wamsg-nofallback-${randomUUID().slice(0, 8)}`;
    const prior = process.env["WAHA_WEBHOOK_SECRET"];
    const fallbackSecret = `fallback-${randomUUID().slice(0, 8)}`;
    process.env["WAHA_WEBHOOK_SECRET"] = fallbackSecret;
    try {
      const res = await inject({
        method: "POST",
        url: `/v1/webhooks/waha/${fallbackKey}`,
        secret: fallbackSecret,
        payload: {
          event: "message",
          session: "default",
          payload: { id: messageId, from: "5511999990001@c.us", fromMe: false, body: "fallback?", timestamp: 1758912000 },
        },
      });
      expect(res.statusCode).toBe(503);
      const inbox = await db
        .selectFrom("platform.inbox_messages")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("provider", "=", "waha")
        .where("external_event_id", "=", `waha:${messageId}`)
        .execute();
      expect(inbox).toHaveLength(0);
    } finally {
      if (prior === undefined) {
        delete process.env["WAHA_WEBHOOK_SECRET"];
      } else {
        process.env["WAHA_WEBHOOK_SECRET"] = prior;
      }
    }
  });

  it("send_manual: happy path (echo), suppressed recipient, and unknown-effect reconcile", async () => {
    const personId = (
      await db
        .selectFrom("identity.persons")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .orderBy("created_at", "asc")
        .executeTakeFirstOrThrow()
    ).id;
    const conv = await inject({
      method: "POST",
      url: "/v1/communications/conversations",
      token,
      payload: { personId, channel: "WHATSAPP" },
    });
    expect(conv.statusCode).toBe(201);
    const conversationId = conv.json<{ id: string }>().id;

    const sent = await inject({
      method: "POST",
      url: `/v1/communications/conversations/${conversationId}/send-manual`,
      token,
      payload: { text: "Olá, sou humano" },
    });
    expect(sent.statusCode).toBe(201);
    const sentBody = sent.json<{ deliveryStatus: string; providerMessageId: string }>();
    expect(sentBody.deliveryStatus).toBe("SENT");
    expect(sentBody.providerMessageId.startsWith("echo:")).toBe(true);

    // Suppressed recipient → forbidden, nothing sent.
    await db
      .insertInto("communication.communication_suppressions")
      .values({
        id: newId(),
        tenant_id: tenantId,
        person_id: personId,
        identity_id: null,
        channel: "WHATSAPP",
        purpose_key: null,
        reason: "test suppression",
        starts_at: new Date(Date.now() - 1000),
        ends_at: null,
        created_at: new Date(),
      })
      .execute();
    const blocked = await inject({
      method: "POST",
      url: `/v1/communications/conversations/${conversationId}/send-manual`,
      token,
      payload: { text: "should not send" },
    });
    expect(blocked.statusCode).toBe(403);
    await db.deleteFrom("communication.communication_suppressions").where("tenant_id", "=", tenantId).execute();

    // Unknown gateway effect → QUEUED + PAUSED/RECONCILE_REQUIRED, no retry.
    setGatewayForTests({
      name: "flaky",
      sendText() {
        throw new GatewayUnknownError();
      },
    });
    try {
      const uncertain = await inject({
        method: "POST",
        url: `/v1/communications/conversations/${conversationId}/send-manual`,
        token,
        payload: { text: "uncertain send" },
      });
      expect(uncertain.statusCode).toBe(201);
      expect(uncertain.json<{ deliveryStatus: string }>().deliveryStatus).toBe("QUEUED");
      const convRow = await db
        .selectFrom("communication.conversations")
        .select(["control_mode"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", conversationId)
        .executeTakeFirstOrThrow();
      expect(convRow.control_mode).toBe("PAUSED");
      const controls = await db
        .selectFrom("communication.conversation_control_events")
        .select(["to_mode", "reason"])
        .where("tenant_id", "=", tenantId)
        .where("conversation_id", "=", conversationId)
        .orderBy("occurred_at", "desc")
        .execute();
      expect(controls[0]).toMatchObject({ to_mode: "PAUSED", reason: "RECONCILE_REQUIRED" });
    } finally {
      resetGatewayForTests();
    }
  });

  it("takeover/return control events are append-only and queries are tenant-isolated", async () => {
    const personId = (
      await db
        .selectFrom("identity.persons")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .orderBy("created_at", "asc")
        .executeTakeFirstOrThrow()
    ).id;
    const conv = await inject({
      method: "POST",
      url: "/v1/communications/conversations",
      token,
      payload: { personId, channel: "WHATSAPP" },
    });
    const conversationId = conv.json<{ id: string }>().id;

    // start_manual opens in HUMAN_CONTROL; release returns to AI.
    const release = await inject({
      method: "POST",
      url: `/v1/communications/conversations/${conversationId}/release`,
      token,
      payload: {},
    });
    expect(release.statusCode).toBe(201);
    expect(release.json()).toMatchObject({ controlMode: "AI_CONTROL", already: false });
    const assign = await inject({
      method: "POST",
      url: `/v1/communications/conversations/${conversationId}/assign`,
      token,
      payload: {},
    });
    expect(assign.json()).toMatchObject({ controlMode: "HUMAN_CONTROL", already: false });

    const events = await db
      .selectFrom("communication.conversation_control_events")
      .select(["to_mode"])
      .where("tenant_id", "=", tenantId)
      .where("conversation_id", "=", conversationId)
      .orderBy("occurred_at", "asc")
      .execute();
    expect(events.map((e) => e.to_mode)).toEqual(["HUMAN_CONTROL", "AI_CONTROL", "HUMAN_CONTROL"]);

    // Conversation get carries the last message.
    const detail = await inject({ method: "GET", url: `/v1/communications/conversations/${conversationId}`, token });
    expect(detail.statusCode).toBe(200);

    // A stranger tenant sees nothing.
    const stranger = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w2-stranger"), password: "correct-horse-8", tenantName: "Other" },
    });
    const strangerToken = stranger.json<{ token: string }>().token;
    const foreignList = await inject({ method: "GET", url: "/v1/communications/conversations", token: strangerToken });
    expect(foreignList.json<{ conversations: unknown[] }>().conversations).toHaveLength(0);
    const foreignGet = await inject({ method: "GET", url: `/v1/communications/conversations/${conversationId}`, token: strangerToken });
    expect(foreignGet.statusCode).toBe(404);
    const foreignPersons = await inject({ method: "GET", url: "/v1/crm/persons", token: strangerToken });
    expect(foreignPersons.json<{ persons: unknown[] }>().persons).toHaveLength(0);
  });

  it("F05: capped channel defers new outreach while inbound and existing conversations continue", async () => {
    const personId = (
      await db
        .selectFrom("identity.persons")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .orderBy("created_at", "asc")
        .executeTakeFirstOrThrow()
    ).id;
    const pre = await inject({
      method: "POST",
      url: "/v1/communications/conversations",
      token,
      payload: { personId, channel: "WHATSAPP" },
    });
    expect(pre.statusCode).toBe(201);
    const existingId = pre.json<{ id: string }>().id;
    const freshPre = await inject({
      method: "POST",
      url: "/v1/communications/conversations",
      token,
      payload: { personId, channel: "WHATSAPP" },
    });
    expect(freshPre.statusCode).toBe(201);
    const freshId = freshPre.json<{ id: string }>().id;
    const warmup = await inject({
      method: "POST",
      url: `/v1/communications/conversations/${existingId}/send-manual`,
      token,
      payload: { text: "warmup before cap" },
    });
    expect(warmup.statusCode).toBe(201);
    setRiskState(tenantId, "WHATSAPP", "CAPPED", "integration timelock");
    try {
      const blockedStart = await inject({
        method: "POST",
        url: "/v1/communications/conversations",
        token,
        payload: { personId, channel: "WHATSAPP" },
      });
      expect(blockedStart.statusCode).toBe(409);
      const blockedSend = await inject({
        method: "POST",
        url: `/v1/communications/conversations/${freshId}/send-manual`,
        token,
        payload: { text: "new outreach under cap" },
      });
      expect(blockedSend.statusCode).toBe(409);
      const followup = await inject({
        method: "POST",
        url: `/v1/communications/conversations/${existingId}/send-manual`,
        token,
        payload: { text: "follow-up under cap" },
      });
      expect(followup.statusCode).toBe(201);
      const inboundId = `wamsg-f05-${randomUUID().slice(0, 8)}`;
      const inbound = await inject({
        method: "POST",
        url: `/v1/webhooks/waha/${tenantKey}`,
        secret: webhookSecret,
        payload: {
          event: "message",
          session: "default",
          payload: {
            id: inboundId,
            from: "5511999990001@c.us",
            fromMe: false,
            body: "client reply under cap",
            timestamp: 1758912000,
          },
        },
      });
      expect(inbound.statusCode).toBe(202);
      const rows = await db
        .selectFrom("communication.messages")
        .select(["id", "direction"])
        .where("tenant_id", "=", tenantId)
        .where("external_message_id", "=", inboundId)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.direction).toBe("INBOUND");
    } finally {
      clearSessionBindingsForTests();
    }
  });

  it("F06: restart keeps tenant session routing without cross-session mixup", async () => {
    bindSession(tenantId, "tenant-f06-a");
    const sentInputs: SendTextInput[] = [];
    const recording: MessagingGatewayPort = {
      name: "recording-f06",
      async sendText(input: SendTextInput): Promise<SendTextResult> {
        sentInputs.push(input);
        return { ok: true, providerMessageId: "recording-f06:1" };
      },
    };
    setGatewayForTests(recording);
    try {
      const personId = (
        await db
          .selectFrom("identity.persons")
          .select(["id"])
          .where("tenant_id", "=", tenantId)
          .orderBy("created_at", "asc")
          .executeTakeFirstOrThrow()
      ).id;
      const conv = await inject({
        method: "POST",
        url: "/v1/communications/conversations",
        token,
        payload: { personId, channel: "WHATSAPP" },
      });
      expect(conv.statusCode).toBe(201);
      const conversationId = conv.json<{ id: string }>().id;
      const foreignId = `wamsg-f06-foreign-${randomUUID().slice(0, 8)}`;
      const foreign = await inject({
        method: "POST",
        url: `/v1/webhooks/waha/${tenantKey}`,
        secret: webhookSecret,
        payload: {
          event: "message",
          session: "tenant-f06-b",
          payload: {
            id: foreignId,
            from: "5511999990001@c.us",
            fromMe: false,
            body: "foreign session",
            timestamp: 1758912000,
          },
        },
      });
      expect(foreign.statusCode).toBe(202);
      const leaked = await db
        .selectFrom("communication.messages")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("external_message_id", "=", foreignId)
        .execute();
      expect(leaked).toHaveLength(0);
      const quarantined = await db
        .selectFrom("communication.exceptions")
        .select(["id", "status", "reason"])
        .where("tenant_id", "=", tenantId)
        .where("external_message_id", "=", foreignId)
        .execute();
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0]?.status).toBe("OPEN");
      expect(quarantined[0]?.reason ?? "").toContain("session mismatch");
      const ownId = `wamsg-f06-own-${randomUUID().slice(0, 8)}`;
      const own = await inject({
        method: "POST",
        url: `/v1/webhooks/waha/${tenantKey}`,
        secret: webhookSecret,
        payload: {
          event: "message",
          session: "tenant-f06-a",
          payload: {
            id: ownId,
            from: "5511999990001@c.us",
            fromMe: false,
            body: "own session",
            timestamp: 1758912000,
          },
        },
      });
      expect(own.statusCode).toBe(202);
      const landed = await db
        .selectFrom("communication.messages")
        .select(["id", "conversation_id"])
        .where("tenant_id", "=", tenantId)
        .where("external_message_id", "=", ownId)
        .execute();
      expect(landed).toHaveLength(1);
      const sent = await inject({
        method: "POST",
        url: `/v1/communications/conversations/${conversationId}/send-manual`,
        token,
        payload: { text: "post-restart follow-up" },
      });
      expect(sent.statusCode).toBe(201);
      expect(sentInputs).toHaveLength(1);
      expect(sentInputs[0]?.session).toBe("tenant-f06-a");
    } finally {
      resetGatewayForTests();
      clearSessionBindingsForTests();
    }
  });
});
