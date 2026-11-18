import { createHash, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createDb, applyMigrations } from "@iptv/database";
import { newId } from "@iptv/domain";
import { sql } from "kysely";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter } from "../src/request-id.js";

// Integration tests with AppModule and migrations exceed Vitest's 15s default here.
vi.setConfig({ testTimeout: 60_000 });

const connectionString = process.env["TEST_DATABASE_URL"];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "db", "migrations");
const pepper = "bot-api-integration-test-pepper-32";
const tenantId = "73000000-0000-4000-8000-000000000001";
const token = `test-${randomUUID()}-${randomUUID()}`;
const tokenHash = createHash("sha256").update(`${pepper}:${token}`).digest("hex");
const tenantBId = "73000000-0000-4000-8000-000000000002";
const tokenB = `test-${randomUUID()}-${randomUUID()}`;
const tokenBHash = createHash("sha256").update(`${pepper}:${tokenB}`).digest("hex");

describe.skipIf(!connectionString)("bot service API (integration)", () => {
  const db = createDb({ connectionString: connectionString as string });
  let app: NestFastifyApplication;
  const oldEnabled = process.env["STREAMMAX_BOT_API_ENABLED"];
  const oldPepper = process.env["BOT_SERVICE_TOKEN_PEPPER"];
  const oldBotEnabled = process.env["STREAMMAX_BOT_ENABLED"];

  function post(path: string, body: Record<string, unknown>, auth = token) {
    return app.getHttpAdapter().getInstance().inject({
      method: "POST", url: `/v1/bot/streammax/${path}`,
      headers: auth ? { authorization: `Bearer ${auth}` } : {},
      payload: body,
    });
  }
  const base = (key: string) => ({
    messageId: `msg-${key}`, requestedAt: new Date().toISOString(), idempotencyKey: key,
  });

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["STREAMMAX_BOT_API_ENABLED"] = "true";
    process.env["BOT_SERVICE_TOKEN_PEPPER"] = pepper;
    await sql`insert into control.tenants (id, slug, name, status) values
      (${tenantId}::uuid, ${`bot-api-${randomUUID()}`}, 'Bot API test', 'ACTIVE')`.execute(db);
    await sql`insert into platform.bot_service_credentials
      (tenant_id, label, token_hash, token_prefix, scopes, expires_at)
      values (${tenantId}::uuid, 'integration', ${tokenHash}, ${token.substring(0, 8)},
      ARRAY['bot.streammax.execute'], now() + interval '1 day')`.execute(db);
    await sql`insert into control.tenants (id, slug, name, status) values
      (${tenantBId}::uuid, ${`bot-api-${randomUUID()}`}, 'Bot API tenant B', 'ACTIVE')`.execute(db);
    await sql`insert into platform.bot_service_credentials
      (tenant_id, label, token_hash, token_prefix, scopes, expires_at)
      values (${tenantBId}::uuid, 'integration-b', ${tokenBHash}, ${tokenB.substring(0, 8)},
      ARRAY['bot.streammax.execute'], now() + interval '1 day')`.execute(db);
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    await app.init();
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    await db.destroy();
    if (oldEnabled === undefined) delete process.env["STREAMMAX_BOT_API_ENABLED"];
    else process.env["STREAMMAX_BOT_API_ENABLED"] = oldEnabled;
    if (oldPepper === undefined) delete process.env["BOT_SERVICE_TOKEN_PEPPER"];
    else process.env["BOT_SERVICE_TOKEN_PEPPER"] = oldPepper;
    if (oldBotEnabled === undefined) delete process.env["STREAMMAX_BOT_ENABLED"];
    else process.env["STREAMMAX_BOT_ENABLED"] = oldBotEnabled;
  });

  afterEach(() => {
    if (oldBotEnabled === undefined) delete process.env["STREAMMAX_BOT_ENABLED"];
    else process.env["STREAMMAX_BOT_ENABLED"] = oldBotEnabled;
  });

  it("authenticates the service, lists plans, creates a lead and rejects tenant input", async () => {
    const list = await post("list-plans", base(`plans-${randomUUID()}`));
    expect(list.statusCode).toBe(201);
    expect(list.json<{ plans: Array<{ amountMinor: string }> }>().plans.every((p) => typeof p.amountMinor === "string")).toBe(true);

    const denied = await post("resolve-lead", { ...base(`bad-${randomUUID()}`), waId: `1555${randomUUID()}`, tenantId });
    expect(denied.statusCode).toBe(400);
    const created = await post("resolve-lead", { ...base(`lead-${randomUUID()}`), waId: `1555${randomUUID()}`, name: "Integration lead" });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ isNew: true });
    expect(created.json<{ personId: string; leadId: string }>().personId).toBeTruthy();
    expect(created.json<{ personId: string; leadId: string }>().leadId).toBeTruthy();
    expect(newId()).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("rejects requests without a service token", async () => {
    expect((await post("list-plans", base(`unauth-${randomUUID()}`), "")).statusCode).toBe(401);
  });

  it("replays the same lead response and rejects a changed payload for the same key", async () => {
    const key = `replay-${randomUUID()}`;
    const waId = `1555${randomUUID()}`;
    const body = { ...base(key), waId, name: "Replay lead" };
    const first = await post("resolve-lead", body);
    const replay = await post("resolve-lead", body);
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.json<{ personId: string; leadId: string }>().personId).toBe(first.json<{ personId: string }>().personId);
    expect(replay.json<{ leadId: string }>().leadId).toBe(first.json<{ leadId: string }>().leadId);
    expect((await post("resolve-lead", { ...body, name: "Changed payload" })).statusCode).toBe(409);
    const newKey = await post("resolve-lead", { ...base(`new-key-${randomUUID()}`), waId: body.waId, name: body.name });
    expect(newKey.statusCode).toBe(201);
    expect(newKey.json().personId).toBe(first.json().personId);
    const identities = await db.selectFrom("identity.identities").select("person_id")
      .where("tenant_id", "=", tenantId).where("normalized_value", "=", body.waId.replace(/\D/g, "")).execute();
    expect(identities).toHaveLength(1);
  });

  it("keeps reply disabled and restores its environment flag", async () => {
    process.env["STREAMMAX_BOT_ENABLED"] = "true";
    const disabled = await post("reply", { ...base(`reply-${randomUUID()}`), conversationId: randomUUID(), inboundText: "hello" });
    expect(disabled.json()).toEqual({ handled: false, sent: false, reason: "flag_off" });
    process.env["STREAMMAX_BOT_ENABLED"] = "false";
  });

  it("does not accept a human-session token as a service credential", async () => {
    const response = await post("list-plans", base(`session-${randomUUID()}`), `session-${randomUUID()}`);
    expect(response.statusCode).toBe(401);
  });

  it("isolates lead creation by the tenant bound to each service token", async () => {
    const waId = `1555${randomUUID()}`;
    const responseA = await post("resolve-lead", { ...base(`tenant-a-${randomUUID()}`), waId, name: "Tenant A lead" }, token);
    expect(responseA.statusCode).toBe(201);
    const responseB = await post("resolve-lead", { ...base(`tenant-b-${randomUUID()}`), waId, name: "Tenant B lead" }, tokenB);
    expect(responseB.statusCode).toBe(201);
    const identities = await db.selectFrom("identity.identities").select(["tenant_id", "person_id"])
      .where("normalized_value", "=", waId.replace(/\D/g, "")).execute();
    expect(identities.map((row) => row.tenant_id).sort()).toEqual([tenantId, tenantBId].sort());
    expect(identities.find((row) => row.tenant_id === tenantId)?.person_id)
      .not.toBe(identities.find((row) => row.tenant_id === tenantBId)?.person_id);
  });

  it("reply with the bot disabled returns only the safe composed response and does not send", async () => {
    process.env["STREAMMAX_BOT_ENABLED"] = "false";
    const lead = await post("resolve-lead", { ...base(`reply-safe-${randomUUID()}`), waId: `1555${randomUUID()}`, name: "Safe reply" });
    expect(lead.statusCode).toBe(201);
    const { personId } = lead.json<{ personId: string }>();
    const conversation = await db.selectFrom("communication.conversations").select("id")
      .where("tenant_id", "=", tenantId).where("person_id", "=", personId)
      .executeTakeFirstOrThrow();
    const response = await post("reply", { ...base(`reply-safe-${randomUUID()}`), conversationId: conversation.id, inboundText: "Olá" });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      handled: true, sent: false,
      text: expect.stringContaining("aguardando as condições comerciais oficiais"),
    });
    const text = response.json<{ text: string }>().text;
    expect(text).not.toMatch(/R\$\s?[\d,.]+|\b(preço|pagamento|ativação|ativar|pix|prazo)\b/i);
  });

  it("reply does not handle a conversation under human control or paused", async () => {
    process.env["STREAMMAX_BOT_ENABLED"] = "false";
    const lead = await post("resolve-lead", { ...base(`reply-paused-${randomUUID()}`), waId: `1555${randomUUID()}` });
    const { personId } = lead.json<{ personId: string }>();
    const conversation = await db.selectFrom("communication.conversations").select("id")
      .where("tenant_id", "=", tenantId).where("person_id", "=", personId)
      .executeTakeFirstOrThrow();
    await db.updateTable("communication.conversations").set({ control_mode: "PAUSED" })
      .where("tenant_id", "=", tenantId).where("id", "=", conversation.id).execute();
    const response = await post("reply", { ...base(`reply-paused-${randomUUID()}`), conversationId: conversation.id, inboundText: "Olá" });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ handled: boolean; sent: boolean; reason?: string; text?: string }>();
    expect(body).toMatchObject({ handled: true, sent: false, reason: "paused" });
    if (body.text !== undefined) {
      expect(body.text).not.toMatch(/\b(pagamento|ativação|ativar|renovação|renovar|prazo|hoje|amanhã|dias?)\b/i);
    }
  });

  it("rejects a duplicate inbound message in reply", async () => {
    process.env["STREAMMAX_BOT_ENABLED"] = "false";
    const lead = await post("resolve-lead", { ...base(`reply-duplicate-${randomUUID()}`), waId: `1555${randomUUID()}` });
    const { personId } = lead.json<{ personId: string }>();
    const conversation = await db.selectFrom("communication.conversations").select("id")
      .where("tenant_id", "=", tenantId).where("person_id", "=", personId)
      .executeTakeFirstOrThrow();
    const messageId = `duplicate-${randomUUID()}`;
    await sql`insert into communication.messages
      (id, tenant_id, conversation_id, person_id, direction, channel, sender_type, external_message_id,
       idempotency_key, content_type, body_text, attachment_ref, metadata_json, occurred_at, received_at, created_at)
      values (${newId()}::uuid, ${tenantId}::uuid, ${conversation.id}::uuid, ${personId}::uuid,
       'INBOUND', 'WHATSAPP', 'PERSON', ${messageId}, null, 'TEXT', 'hello', null, '{}'::jsonb, now(), now(), now())`.execute(db);
    const response = await post("reply", { ...base(`reply-duplicate-${randomUUID()}`), messageId, conversationId: conversation.id, inboundText: "Olá" });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ handled: true, sent: false, reason: "duplicate" });
  });
});
