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
import {
  GatewayUnknownError,
  resetGatewayForTests,
  setGatewayForTests,
  type SendTextInput,
  type SendTextResult,
} from "../src/communications/messaging-gateway.js";

/**
 * G01 golden communication loop — single-journey chain on a CONTROLLED
 * adapter (no live WhatsApp actions, no network: the gateway is a recording
 * double):
 *
 * inbound webhook (auth + dedupe) → sender-identity match → conversation →
 * inbound persist → manual reply command → adapter send → verifiable delivery
 * confirmation recorded on the SAME conversation.
 *
 * Asserts: exactly-once reply, correct tenant/identity, no send after
 * invalid auth, safe retry (duplicate webhook → no duplicate reply), and
 * UNKNOWN (gateway timeout) persisted distinctly from success text.
 *
 * Deterministic fixtures: counters only, never UUID-head slices.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

let counter = 0;
function tag(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, "0")}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const WAHA_FIXTURE_TOKEN = "g01 test fixture, not a credential";
const SENDER = "5511999990101";

/** Controlled adapter: records sends, returns verifiable confirmations. */
const sentInputs: SendTextInput[] = [];
const recordingGateway = {
  name: "g01-recording",
  async sendText(input: SendTextInput): Promise<SendTextResult> {
    sentInputs.push(input);
    return { ok: true, providerMessageId: `g01-confirm-${sentInputs.length}` };
  },
};

let unknownCalls = 0;
const unknownGateway = {
  name: "g01-unknown",
  async sendText(): Promise<SendTextResult> {
    unknownCalls += 1;
    throw new GatewayUnknownError();
  },
};

describe.skipIf(!hasDb)("G01 manual-reply chain (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let token = "";
  let tenantId = "";
  let userId = "";
  let bus: CommandBus;

  const tenantKey = `g01-${tag("key")}`;
  const journey = { personId: "", conversationId: "", inboundId: tag("wamsg-inbound") };

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
    secret?: string;
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
      headers["x-tenant-context-revision"] = "0";
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

  function inboundPayload() {
    return {
      event: "message",
      session: "default",
      payload: {
        id: journey.inboundId,
        from: `${SENDER}@c.us`,
        fromMe: false,
        body: "quero falar com um humano",
        timestamp: 1758912000,
      },
    };
  }

  async function inboundRows(): Promise<Array<{ id: string; direction: string; conversation_id: string; person_id: string }>> {
    return db
      .selectFrom("communication.messages")
      .select(["id", "direction", "conversation_id", "person_id"])
      .where("tenant_id", "=", tenantId)
      .where("external_message_id", "=", journey.inboundId)
      .execute() as unknown as Array<{ id: string; direction: string; conversation_id: string; person_id: string }>;
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    delete process.env["WAHA_BASE_URL"];
    delete process.env["WAHA_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    setGatewayForTests(recordingGateway);
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);

    const register = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: `g01-${tag("mail")}@example.com`, password: "correct-horse-8", tenantName: "G01 Chain Tenant" },
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
        webhook_secret_hash: sha256Hex(WAHA_FIXTURE_TOKEN),
        status: "ACTIVE",
        waha_session_name: null,
        waha_status: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    const person = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "G01 Chain Customer",
      identities: [{ identityType: "WHATSAPP", normalizedValue: SENDER }],
    });
    if (!person.ok) {
      throw new Error(`person.register failed: ${JSON.stringify(person)}`);
    }
    journey.personId = person.data.id;
    const conv = await bus.execute<{ id: string }>(actor(), "conversation.start_manual", {
      personId: journey.personId,
      channel: "WHATSAPP",
    });
    if (!conv.ok) {
      throw new Error(`conversation.start_manual failed: ${JSON.stringify(conv)}`);
    }
    journey.conversationId = conv.data.id;
  }, 120_000);

  afterAll(async () => {
    resetGatewayForTests();
    await app?.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
  });

  it("inbound webhook (auth) persists on the SAME conversation with correct identity", async () => {
    const res = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKey}`,
      secret: WAHA_FIXTURE_TOKEN,
      payload: inboundPayload(),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true, deduped: false });

    const rows = await inboundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.direction).toBe("INBOUND");
    // Same conversation, same tenant person — the journey identity binding.
    expect(rows[0]?.conversation_id).toBe(journey.conversationId);
    expect(rows[0]?.person_id).toBe(journey.personId);
    const delivery = await db
      .selectFrom("communication.message_deliveries")
      .select(["status", "provider"])
      .where("tenant_id", "=", tenantId)
      .where("message_id", "=", rows[0]?.id as string)
      .execute();
    expect(delivery).toMatchObject([{ status: "DELIVERED", provider: "waha" }]);
  });

  it("duplicate webhook is deduped: safe retry creates no duplicate inbound and no reply", async () => {
    const retry = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKey}`,
      secret: WAHA_FIXTURE_TOKEN,
      payload: inboundPayload(),
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual({ accepted: true, deduped: true });
    expect(await inboundRows()).toHaveLength(1);
    // No reply was ever triggered by the retry path.
    expect(sentInputs).toHaveLength(0);
  });

  it("invalid auth sends nothing and persists nothing", async () => {
    const rejected = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKey}`,
      secret: "wrong-secret",
      payload: inboundPayload(),
    });
    expect(rejected.statusCode).toBe(401);
    expect(sentInputs).toHaveLength(0);
    expect(await inboundRows()).toHaveLength(1);
  });

  it("unknown events are acked without domain mutation (UNKNOWN ≠ success text)", async () => {
    const messagesBefore = await db
      .selectFrom("communication.messages")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .execute();
    const exceptionsBefore = await db
      .selectFrom("communication.exceptions")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .execute();
    const ack = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKey}`,
      secret: WAHA_FIXTURE_TOKEN,
      payload: { event: "message.ack", session: "default", payload: { id: tag("wamsg-ack"), fromMe: false } },
    });
    expect(ack.statusCode).toBe(202);
    const messagesAfter = await db
      .selectFrom("communication.messages")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .execute();
    const exceptionsAfter = await db
      .selectFrom("communication.exceptions")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .execute();
    expect(messagesAfter).toHaveLength(messagesBefore.length);
    expect(exceptionsAfter).toHaveLength(exceptionsBefore.length);
  });

  it("manual reply delivers exactly once on the SAME conversation with verifiable confirmation", async () => {
    const sent = await inject({
      method: "POST",
      url: `/v1/communications/conversations/${journey.conversationId}/send-manual`,
      token,
      payload: { text: "Olá! Um humano assumiu por aqui." },
    });
    expect(sent.statusCode).toBe(201);
    const body = sent.json<{ messageId: string; deliveryStatus: string; providerMessageId: string }>();
    expect(body.deliveryStatus).toBe("SENT");
    expect(body.providerMessageId).toBe("g01-confirm-1");

    // Exactly once at the adapter, with correct tenant + session identity.
    expect(sentInputs).toHaveLength(1);
    expect(sentInputs[0]?.tenantId).toBe(tenantId);
    expect(sentInputs[0]?.session).toBe("default");
    expect(sentInputs[0]?.conversationId).toBe(journey.conversationId);

    // Verifiable confirmation recorded on the SAME conversation.
    const outbound = await db
      .selectFrom("communication.messages")
      .select(["id", "direction", "conversation_id"])
      .where("tenant_id", "=", tenantId)
      .where("conversation_id", "=", journey.conversationId)
      .where("direction", "=", "OUTBOUND")
      .execute();
    expect(outbound).toHaveLength(1);
    const delivery = await db
      .selectFrom("communication.message_deliveries")
      .select(["status", "external_delivery_id", "error_code"])
      .where("tenant_id", "=", tenantId)
      .where("message_id", "=", outbound[0]?.id as string)
      .execute();
    expect(delivery).toMatchObject([{ status: "SENT", external_delivery_id: "g01-confirm-1", error_code: null }]);

    // Journey order on the conversation: inbound first, reply second.
    const ordered = await db
      .selectFrom("communication.messages")
      .select(["direction", "occurred_at"])
      .where("tenant_id", "=", tenantId)
      .where("conversation_id", "=", journey.conversationId)
      .orderBy("occurred_at", "asc")
      .execute();
    expect(ordered.map((m) => m.direction)).toEqual(["INBOUND", "OUTBOUND"]);
  });

  it("gateway UNKNOWN persists QUEUED distinctly from the success text (safe retry: no blind resend)", async () => {
    setGatewayForTests(unknownGateway);
    try {
      const uncertain = await inject({
        method: "POST",
        url: `/v1/communications/conversations/${journey.conversationId}/send-manual`,
        token,
        payload: { text: "resposta sob timeout" },
      });
      expect(uncertain.statusCode).toBe(201);
      expect(uncertain.json<{ deliveryStatus: string }>().deliveryStatus).toBe("QUEUED");
    } finally {
      setGatewayForTests(recordingGateway);
    }
    expect(unknownCalls).toBe(1);
    // The recording adapter saw only the single success send — the UNKNOWN
    // attempt never fell back to a blind resend through another gateway.
    expect(sentInputs).toHaveLength(1);

    const deliveries = await db
      .selectFrom("communication.message_deliveries")
      .select(["status", "error_code"])
      .where("tenant_id", "=", tenantId)
      .orderBy("occurred_at", "asc")
      .execute();
    const outboundDeliveries = deliveries.filter((d) => d.status !== "DELIVERED");
    // SENT success text vs QUEUED unknown-effect: distinct rows, same journey.
    expect(outboundDeliveries).toMatchObject([
      { status: "SENT", error_code: null },
      { status: "QUEUED", error_code: "UNKNOWN_EFFECT" },
    ]);
    const convRow = await db
      .selectFrom("communication.conversations")
      .select(["control_mode"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", journey.conversationId)
      .executeTakeFirstOrThrow();
    expect(convRow.control_mode).toBe("PAUSED");
  });

  it("replay after UNKNOWN is refused until reconciliation (fail-closed, no second send)", async () => {
    // The conversation is still PAUSED from the UNKNOWN above: a sequential
    // re-POST of a send must NOT produce a second adapter call — the
    // provider may already have applied the first attempt.
    const retry = await inject({
      method: "POST",
      url: `/v1/communications/conversations/${journey.conversationId}/send-manual`,
      token,
      payload: { text: "replay após timeout" },
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json<{ message: string }>().message).toMatch(/reconcile_required/);
    expect(sentInputs).toHaveLength(1);
    expect(unknownCalls).toBe(1);
    // LIMITATION (declared, not proven): this is fail-closed refusal, not
    // exactly-once delivery. It blocks the unreconciled retry; it proves
    // nothing about provider-side duplication of the first attempt, which
    // only out-of-band reconciliation can settle.
  });

  it("a second tenant sees nothing of the journey (tenant isolation)", async () => {
    const other = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: `g01-other-${tag("mail")}@example.com`, password: "correct-horse-8", tenantName: "G01 Other" },
    });
    expect(other.statusCode).toBe(201);
    const otherToken = other.json<{ token: string }>().token;
    const foreignConv = await inject({
      method: "GET",
      url: `/v1/communications/conversations/${journey.conversationId}`,
      token: otherToken,
    });
    expect(foreignConv.statusCode).toBe(404);
    const foreignMessages = await inject({
      method: "GET",
      url: `/v1/communications/conversations/${journey.conversationId}/messages`,
      token: otherToken,
    });
    expect(foreignMessages.statusCode).toBe(404);
    const foreignPersons = await inject({ method: "GET", url: "/v1/crm/persons", token: otherToken });
    expect(foreignPersons.json<{ persons: unknown[] }>().persons).toHaveLength(0);
  });
});
