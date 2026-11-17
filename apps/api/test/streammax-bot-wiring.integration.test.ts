import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { applyMigrations, createDb } from "@iptv/database";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";
import { CommandBus } from "../src/commands/command-bus.js";
import { WahaWebhookService } from "../src/communications/waha-webhook.service.js";
import { AgentPipeline } from "../src/agent/pipeline.js";
import { resetGatewayForTests } from "../src/communications/messaging-gateway.js";
import { newId } from "@iptv/domain";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");
const connectionString = process.env["TEST_DATABASE_URL"];

describe.skipIf(!process.env.TEST_DATABASE_URL)("StreamMax bot webhook wiring", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });
  let webhooks: WahaWebhookService;
  let bus: CommandBus;
  let tenantId = "";
  let pipeline: AgentPipeline;
  let botFlag: { STREAMMAX_BOT_ENABLED: string };
  let actor: { userId: string; isPlatformAdmin: false; tenantId: string; roleKeys: string[]; permissions: string[]; actorType: "human" };

  beforeAll(async () => {
    delete process.env["WAHA_SESSION"];
    delete process.env["WAHA_BASE_URL"];
    delete process.env["WAHA_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    resetGatewayForTests();
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    webhooks = app.get(WahaWebhookService);
    bus = app.get(CommandBus);
    pipeline = app.get(AgentPipeline);
    botFlag = app.get("APP_CONFIG") as { STREAMMAX_BOT_ENABLED: string };
    botFlag.STREAMMAX_BOT_ENABLED = "false";
    resetGatewayForTests();
    const registered = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/auth/register",
      payload: { email: `bot-${newId()}@example.com`, password: "correct-horse-8", tenantName: "Bot wiring" },
    });
    expect(registered.statusCode).toBe(201);
    tenantId = registered.json<{ activeTenantId: string }>().activeTenantId;
    const userId = registered.json<{ user: { id: string } }>().user.id;
    actor = { userId, isPlatformAdmin: false, tenantId, roleKeys: ["tenant_owner"], permissions: ["crm.person.read", "crm.lead.write", "conversation.reply", "agent.review.request", "agent.review.decide", "conversation.start", "conversation.release"], actorType: "human" };
  }, 120_000);

  afterEach(() => {
    if (botFlag) botFlag.STREAMMAX_BOT_ENABLED = "false";
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
    await db.destroy();
  });

  async function ensurePersonAndConversation(from: string) {
    const person = await bus.execute<{ id: string }>(actor, "person.register", { canonicalName: `Contato ${newId()}`, identities: [{ identityType: "WHATSAPP", normalizedValue: from }] }) as { ok: true; data: { id: string } };
    const conversation = await bus.execute<{ id: string }>(actor, "conversation.start_manual", { personId: person.data.id, channel: "WHATSAPP" }) as { ok: true; data: { id: string } };
    expect((await bus.execute(actor, "conversation.release", { conversationId: conversation.data.id })).ok).toBe(true);
  }

  async function deliver(from: string, externalId: string, body = "Olá, preciso de ajuda", session = "default") {
    const payload = {
      event: "message", session,
      payload: { id: externalId, from: `${from}@c.us`, fromMe: false, body, timestamp: 1758912000 },
    };
    const accepted = await webhooks.acceptRaw({
      tenantId, channel: "WHATSAPP", externalEventId: `waha:${externalId}`, payload,
    });
    await webhooks.processRow(tenantId, accepted.inboxId, payload);
  }

  async function outboundCount() {
    return db.selectFrom("communication.messages").select("id")
      .where("tenant_id", "=", tenantId).where("direction", "=", "OUTBOUND").execute();
  }

  it("flag OFF: não responde e encaminha avaliação ao AgentPipeline", async () => {
    const spy = vi.spyOn(pipeline, "evaluateInbound").mockResolvedValue({ evaluated: false, reason: "disabled" } as never);
    const before = (await outboundCount()).length;
    const from = "5511990000101";
    await ensurePersonAndConversation(from);
    await deliver(from, `bot-off-${randomUUID()}`);
    expect((await outboundCount()).length).toBe(before);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("flag ON: contato novo é resolvido e recebe exatamente uma resposta", async () => {
    botFlag.STREAMMAX_BOT_ENABLED = "true";
    const from = `551199${randomUUID().replace(/\D/g, "").slice(-8)}`;
    await ensurePersonAndConversation(from);
    const spy = vi.spyOn(pipeline, "evaluateInbound");
    const before = (await outboundCount()).length;
    await deliver(from, `bot-new-${randomUUID()}`);
    const exceptions = await db.selectFrom("communication.exceptions").select(["id"])
      .where("tenant_id", "=", tenantId).where("kind", "=", "UNMATCHED_INBOUND")
      .where("from_address", "=", `${from}@c.us`).execute();
    expect(exceptions).toHaveLength(0);
    expect((await outboundCount()).length).toBe(before + 1);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    botFlag.STREAMMAX_BOT_ENABLED = "false";
  });

  it("redelivery do mesmo externalMessageId não duplica a resposta", async () => {
    botFlag.STREAMMAX_BOT_ENABLED = "true";
    const from = `551199${randomUUID().replace(/\D/g, "").slice(-8)}`;
    await ensurePersonAndConversation(from);
    const id = `bot-redelivery-${randomUUID()}`;
    const before = (await outboundCount()).length;
    await deliver(from, id);
    await deliver(from, id);
    expect((await outboundCount()).length).toBe(before + 1);
    botFlag.STREAMMAX_BOT_ENABLED = "false";
  });

  it("conversa em controle humano/pausada não recebe resposta do bot", async () => {
    botFlag.STREAMMAX_BOT_ENABLED = "true";
    const from = `551199${randomUUID().replace(/\D/g, "").slice(-8)}`;
    await ensurePersonAndConversation(from);
    const before = (await outboundCount()).length;
    await deliver(from, `bot-paused-${randomUUID()}`);
    const person = await db.selectFrom("identity.identities").select("person_id")
      .where("tenant_id", "=", tenantId).where("normalized_value", "=", from).executeTakeFirstOrThrow();
    const conversation = await db.selectFrom("communication.conversations").select("id")
      .where("tenant_id", "=", tenantId).where("person_id", "=", person.person_id).executeTakeFirstOrThrow();
    await db.updateTable("communication.conversations").set({ control_mode: "PAUSED" })
      .where("tenant_id", "=", tenantId).where("id", "=", conversation.id).execute();
    await deliver(from, `bot-paused-second-${randomUUID()}`);
    expect((await outboundCount()).length).toBe(before + 1);
    botFlag.STREAMMAX_BOT_ENABLED = "false";
  });

  it("falha no envio do bot não aciona fallback nem duplica resposta", async () => {
    botFlag.STREAMMAX_BOT_ENABLED = "true";
    const originalExecute = bus.execute.bind(bus);
    const spy = vi.spyOn(bus, "execute").mockImplementation(async (...args: Parameters<CommandBus["execute"]>) => {
      if (args[1] === "message.send_manual") return { ok: false, code: "unavailable", message: "forced failure" } as never;
      return originalExecute(...args) as never;
    });
    const evaluator = vi.spyOn(pipeline, "evaluateInbound");
    const before = (await outboundCount()).length;
    const from = `551199${randomUUID().replace(/\D/g, "").slice(-8)}`;
    await ensurePersonAndConversation(from);
    await deliver(from, `bot-fallback-${randomUUID()}`);
    expect(evaluator).not.toHaveBeenCalled();
    expect((await outboundCount()).length).toBe(before);
    spy.mockRestore();
    evaluator.mockRestore();
    botFlag.STREAMMAX_BOT_ENABLED = "false";
  });
});
