import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createDb, applyMigrations } from "@iptv/database";
import { newId } from "@iptv/domain";
import { SecretsError, buildIntegrationSecretRef, type SecretsWriterPort } from "@iptv/secrets";
import { AppModule } from "../src/app.module.js";
import {
  __resetWhatsappSessionTestDoubles,
  __setWhatsappSessionTestDoubles,
} from "../src/integrations/whatsapp-sessions.commands.js";
import {
  __resetWahaAdminFetchForTests,
  __setWahaAdminFetchForTests,
} from "../src/integrations/waha-admin.port.js";
import { clearSessionBindingsForTests } from "../src/communications/waha-sessions.js";
import { deriveWahaSessionName } from "../src/communications/waha-session-store.js";
import {
  currentGateway,
  resetGatewayForTests,
  setGatewayForTests,
  type MessagingGatewayPort,
  type SendTextInput,
} from "../src/communications/messaging-gateway.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

const db = hasDb ? createDb({ connectionString: connectionString as string }) : null;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(0, 12)}@example.com`;
}

const SENDER_A = "5511999990303";
const TEST_TEXT = "Ol\u00e1! Teste de pareamento S3C.";
const AUDIT_MARKER = "S3C marcador de auditoria que nunca pode vazar";

class FakeVault implements SecretsWriterPort {
  readonly name = "fake-test-vault";
  readonly store = new Map<string, string>();

  async getSecret(ref: string): Promise<string> {
    const value = this.store.get(ref);
    if (value === undefined) {
      throw new SecretsError("NOT_FOUND", "fake vault: secret not found");
    }
    return value;
  }

  async putSecret(input: {
    tenantId: string;
    provider: "asaas" | "cinevision" | "whatsapp";
    environment: string;
    key: string;
    value: string;
  }): Promise<{ ref: string; created: boolean }> {
    const ref = buildIntegrationSecretRef(input);
    const created = !this.store.has(ref);
    this.store.set(ref, input.value);
    return { ref, created };
  }

  async deleteSecret(ref: string): Promise<void> {
    if (!this.store.delete(ref)) {
      throw new SecretsError("NOT_FOUND", "fake vault: secret not found");
    }
  }
}

/** Minimal fake WAHA admin API: sessions live in a Map (lifecycle + QR only). */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface FakeWahaSession {
  name: string;
  status: string;
}

function createFakeWaha() {
  const sessions = new Map<string, FakeWahaSession>();
  const calls: Array<{ method: string; url: string; body: unknown }> = [];

  async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url, "http://waha.test").pathname;
    let body: unknown = null;
    try {
      body = init?.body !== undefined ? JSON.parse(String(init.body)) : null;
    } catch {
      body = null;
    }
    calls.push({ method, url: path, body });
    if (method === "GET" && /^\/api\/sessions\/[^/]+\/?$/.test(path)) {
      const name = path.split("/")[3] as string;
      const session = sessions.get(name);
      if (session === undefined) {
        return new Response("not found", { status: 404 });
      }
      return Response.json({ name: session.name, status: session.status });
    }
    if (method === "POST" && /^\/api\/sessions\/?$/.test(path)) {
      const payload = (body ?? {}) as { name?: unknown };
      const name = typeof payload.name === "string" ? payload.name : `sess-${sessions.size + 1}`;
      if (sessions.has(name)) {
        return new Response("conflict", { status: 409 });
      }
      const created: FakeWahaSession = { name, status: "SCAN_QR_CODE" };
      sessions.set(name, created);
      return Response.json({ name, status: created.status }, { status: 201 });
    }
    const action = /^\/api\/sessions\/[^/]+\/(start|stop|restart)\/?$/.exec(path)?.[1];
    if (method === "POST" && action !== undefined) {
      const name = path.split("/")[3] as string;
      const session = sessions.get(name);
      if (session === undefined) {
        return new Response("not found", { status: 404 });
      }
      if (action === "stop") {
        session.status = "STOPPED";
      } else if (action === "start") {
        session.status = session.status === "STOPPED" ? "SCAN_QR_CODE" : session.status;
      } else {
        session.status = "SCAN_QR_CODE";
      }
      return Response.json({ name: session.name, status: session.status });
    }
    if (method === "GET" && /^\/api\/[^/]+\/auth\/qr$/.test(path)) {
      return new Response(PNG_BYTES, { status: 200, headers: { "Content-Type": "image/png" } });
    }
    return new Response("unexpected", { status: 500 });
  }

  return { sessions, calls, fakeFetch };
}

/**
 * Recording gateway double: proves the test-message goes through the
 * EXISTING send path (`currentGateway().sendText`) with the tenant session
 * — never a parallel sender, never the shared default.
 */
class RecordingGateway implements MessagingGatewayPort {
  readonly name = "fake-test-message-gateway";
  readonly sentInputs: SendTextInput[] = [];
  mode: "ok" | "capped" | "failed" = "ok";

  async sendText(input: SendTextInput) {
    this.sentInputs.push(input);
    if (this.mode === "capped") {
      return { ok: false as const, code: "CAPPED" as const, message: "fake capped" };
    }
    if (this.mode === "failed") {
      return { ok: false as const, code: "FAILED" as const, message: "fake provider refused" };
    }
    return { ok: true as const, providerMessageId: `waha-test-${this.sentInputs.length}` };
  }
}

describe.skipIf(!hasDb)("whatsapp test-message S3c (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  let tokenA = "";
  let tenantA = "";
  let tokenB = "";
  let tenantB = "";
  let tokenOperator = "";
  let tenantKeyA = "";
  let webhookSecretA = "";
  let vault: FakeVault;
  let waha = createFakeWaha();
  const gateway = new RecordingGateway();

  async function inject(opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    revision?: string | null;
    secret?: string;
    idempotencyKey?: string;
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
    }
    if (opts.token !== undefined && opts.revision !== null) {
      headers["x-tenant-context-revision"] = opts.revision ?? "0";
    }
    if (opts.secret !== undefined) {
      headers["x-waha-secret"] = opts.secret;
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

  async function sessionRevision(token: string): Promise<string> {
    const res = await inject({ method: "GET", url: "/v1/auth/session", token, revision: null });
    expect(res.statusCode).toBe(200);
    return res.json<{ tenantContextRevision: string }>().tenantContextRevision;
  }

  async function registerTenant(label: string): Promise<{ token: string; tenantId: string }> {
    const res = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email(`s3c-${label}`), password: "correct-horse-8", tenantName: `S3c ${label}` },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ token: string; activeTenantId: string }>();
    return { token: body.token, tenantId: body.activeTenantId };
  }

  function setWahaStatus(tenantId: string, status: string): void {
    const stored = waha.sessions.get(deriveWahaSessionName(tenantId));
    expect(stored).toBeDefined();
    if (stored !== undefined) {
      stored.status = status;
    }
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    process.env["WAHA_BASE_URL"] = "http://waha.test";
    process.env["WAHA_API_KEY"] = "s3c-synthetic-waha-admin-key";
    vault = new FakeVault();
    __setWhatsappSessionTestDoubles({ secretsWriter: vault, webhookBaseUrl: "https://app.exemplo.com" });
    waha = createFakeWaha();
    __setWahaAdminFetchForTests(waha.fakeFetch);
    setGatewayForTests(gateway);
    expect(currentGateway().name).toBe("fake-test-message-gateway");
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    ({ token: tokenA, tenantId: tenantA } = await registerTenant("a"));
    ({ token: tokenB, tenantId: tenantB } = await registerTenant("b"));

    // Operator read-only (integration.read, sem manage) no tenant A.
    const registerOp = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("s3c-op"), password: "correct-horse-8", tenantName: "S3c Operator Home" },
    });
    expect(registerOp.statusCode).toBe(201);
    const bodyOp = registerOp.json<{ token: string; user: { id: string } }>();
    tokenOperator = bodyOp.token;
    await (db as NonNullable<typeof db>)
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
    const opSwitched = await inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/switch`,
      token: tokenOperator,
      revision: await sessionRevision(tokenOperator),
    });
    expect(opSwitched.statusCode).toBe(200);

    // Provisiona a sessão do tenant A e deixa WORKING no provider fake.
    const provision = await inject({
      method: "POST",
      url: "/v1/integrations/whatsapp/session",
      token: tokenA,
      payload: {},
    });
    expect(provision.statusCode).toBe(201);
    const provisionBody = provision.json<{ webhookUrl: string }>();
    tenantKeyA = (provisionBody.webhookUrl as string).split("/").pop() as string;
    webhookSecretA = await vault.getSecret(
      buildIntegrationSecretRef({
        tenantId: tenantA,
        provider: "whatsapp",
        environment: "production",
        key: "WAHA_WEBHOOK_SECRET",
      }),
    );
    setWahaStatus(tenantA, "WORKING");
  }, 120_000);

  afterAll(async () => {
    __resetWhatsappSessionTestDoubles();
    __resetWahaAdminFetchForTests();
    clearSessionBindingsForTests();
    delete process.env["WAHA_BASE_URL"];
    delete process.env["WAHA_API_KEY"];
    resetGatewayForTests();
    await app?.close().catch(() => undefined);
    await db?.destroy().catch(() => undefined);
  });

  it("S1 probe continua 501 para whatsapp (test genérico não vira envio)", async () => {
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/whatsapp/test",
      token: tokenA,
      payload: {},
    });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ code: "CAPABILITY_UNCERTIFIED", message: expect.any(String) });
  });

  it("sem vínculo retorna 404 NO_SESSION (nunca outra sessão)", async () => {
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/whatsapp/test-message",
      token: tokenB,
      payload: { to: "+5511999990001", text: TEST_TEXT },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: "NO_SESSION", message: expect.any(String) });
    expect(gateway.sentInputs).toHaveLength(0);
  });

  it("sem manage retorna 403 (envio é efeito)", async () => {
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/whatsapp/test-message",
      token: tokenOperator,
      revision: await sessionRevision(tokenOperator),
      payload: { to: "+5511999990001", text: TEST_TEXT },
    });
    expect(res.statusCode).toBe(403);
    expect(gateway.sentInputs).toHaveLength(0);
  });

  it("sessão não-WORKING retorna 409 SESSION_NOT_READY sem enviar", async () => {
    setWahaStatus(tenantA, "SCAN_QR_CODE");
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/whatsapp/test-message",
      token: tokenA,
      payload: { to: "+5511999990001", text: TEST_TEXT },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: "SESSION_NOT_READY", message: expect.any(String) });
    expect(gateway.sentInputs).toHaveLength(0);
    setWahaStatus(tenantA, "WORKING");
  });

  it("validação: E.164 e texto 1..500 (400 sem enviar)", async () => {
    const bad = [
      { to: "11999990001", text: TEST_TEXT },
      { to: "+55", text: TEST_TEXT },
      { to: "+5511999990001", text: "" },
      { to: "+5511999990001", text: "x".repeat(501) },
    ];
    for (const payload of bad) {
      const res = await inject({
        method: "POST",
        url: "/v1/integrations/whatsapp/test-message",
        token: tokenA,
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(gateway.sentInputs).toHaveLength(0);
  });

  it("happy path: envia SOMENTE ao `to` via send path existente com a sessão do tenant", async () => {
    const before = gateway.sentInputs.length;
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/whatsapp/test-message",
      token: tokenA,
      idempotencyKey: `s3c-happy-${randomUUID()}`,
      payload: { to: "+5511999990001", text: TEST_TEXT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(new Set(Object.keys(body))).toEqual(
      new Set(["to", "textLength", "sessionName", "providerMessageId"]),
    );
    expect(body["to"]).toBe("+5511999990001");
    expect(body["textLength"]).toBe(TEST_TEXT.length);
    expect(body["sessionName"]).toBe(deriveWahaSessionName(tenantA));
    expect(typeof body["providerMessageId"]).toBe("string");
    // Sanitizado: o conteúdo nunca volta na resposta.
    expect(JSON.stringify(body)).not.toContain("pareamento");
    // Um único envio, roteado ao destino confirmado, na sessão do tenant.
    expect(gateway.sentInputs.length).toBe(before + 1);
    const sent = gateway.sentInputs[before] as SendTextInput;
    expect(sent.tenantId).toBe(tenantA);
    expect(sent.to).toBe("5511999990001@c.us");
    expect(sent.text).toBe(TEST_TEXT);
    expect(sent.session).toBe(deriveWahaSessionName(tenantA));
  });

  it("replay idempotente: mesma key não reenvia; mesma key + payload distinto dá 400", async () => {
    const key = `s3c-replay-${randomUUID()}`;
    const payload = { to: "+5511999990002", text: TEST_TEXT };
    const before = gateway.sentInputs.length;
    const first = await inject({
      method: "POST",
      url: "/v1/integrations/whatsapp/test-message",
      token: tokenA,
      idempotencyKey: key,
      payload,
    });
    expect(first.statusCode).toBe(200);
    const second = await inject({
      method: "POST",
      url: "/v1/integrations/whatsapp/test-message",
      token: tokenA,
      idempotencyKey: key,
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(gateway.sentInputs.length).toBe(before + 1);
    const conflict = await inject({
      method: "POST",
      url: "/v1/integrations/whatsapp/test-message",
      token: tokenA,
      idempotencyKey: key,
      payload: { to: "+5511999990003", text: TEST_TEXT },
    });
    expect(conflict.statusCode).toBe(400);
    expect(gateway.sentInputs.length).toBe(before + 1);
  });

  it("auditoria sem conteúdo: só to/length/resultado", async () => {
    const key = `s3c-audit-${randomUUID()}`;
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/whatsapp/test-message",
      token: tokenA,
      idempotencyKey: key,
      payload: { to: "+5511999990004", text: AUDIT_MARKER },
    });
    expect(res.statusCode).toBe(200);
    const rows = await (db as NonNullable<typeof db>)
      .selectFrom("platform.audit_log")
      .select(["action_key", "resource_type", "metadata_json"])
      .where("tenant_id", "=", tenantA)
      .where("action_key", "=", "whatsapp.test_message")
      .orderBy("occurred_at", "desc")
      .execute();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.resource_type).toBe("tenant_channel");
      const meta = row.metadata_json as Record<string, unknown>;
      expect(meta["result"]).toBeDefined();
    }
    const dumped = JSON.stringify(rows);
    expect(dumped).not.toContain(AUDIT_MARKER);
  });

  it("isolamento A/B: cada tenant envia pela própria sessão", async () => {
    const provisionB = await inject({
      method: "POST",
      url: "/v1/integrations/whatsapp/session",
      token: tokenB,
      payload: {},
    });
    expect(provisionB.statusCode).toBe(201);
    setWahaStatus(tenantB, "WORKING");
    const before = gateway.sentInputs.length;
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/whatsapp/test-message",
      token: tokenB,
      idempotencyKey: `s3c-iso-${randomUUID()}`,
      payload: { to: "+5511999990005", text: TEST_TEXT },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Record<string, unknown>>()["sessionName"]).toBe(deriveWahaSessionName(tenantB));
    expect(gateway.sentInputs.length).toBe(before + 1);
    const sent = gateway.sentInputs[before] as SendTextInput;
    expect(sent.tenantId).toBe(tenantB);
    expect(sent.session).toBe(deriveWahaSessionName(tenantB));
    expect(sent.session).not.toBe(deriveWahaSessionName(tenantA));
  });

  it("provider CAPPED vira 429 e FAILED vira 503 (sem inventar estado)", async () => {
    gateway.mode = "capped";
    const capped = await inject({
      method: "POST",
      url: "/v1/integrations/whatsapp/test-message",
      token: tokenA,
      idempotencyKey: `s3c-capped-${randomUUID()}`,
      payload: { to: "+5511999990006", text: TEST_TEXT },
    });
    expect(capped.statusCode).toBe(429);
    expect(capped.json()).toEqual({ code: "CAPPED", message: expect.any(String) });
    gateway.mode = "failed";
    const failed = await inject({
      method: "POST",
      url: "/v1/integrations/whatsapp/test-message",
      token: tokenA,
      idempotencyKey: `s3c-failed-${randomUUID()}`,
      payload: { to: "+5511999990006", text: TEST_TEXT },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ code: "PROVIDER_UNAVAILABLE", message: expect.any(String) });
    gateway.mode = "ok";
  });

  it("GET session expõe lastInbound (null sem inbound; preview após inbound real)", async () => {
    const empty = await inject({ method: "GET", url: "/v1/integrations/whatsapp/session", token: tokenA });
    expect(empty.statusCode).toBe(200);
    expect(empty.json<Record<string, unknown>>()["lastInbound"]).toBeNull();

    // Inbound real via webhook (sessão vinculada do próprio tenant).
    const person = await inject({
      method: "POST",
      url: "/v1/crm/persons",
      token: tokenA,
      payload: { canonicalName: "S3c Inbound", identities: [{ identityType: "WHATSAPP", normalizedValue: SENDER_A }] },
    });
    expect(person.statusCode).toBe(201);
    const conv = await inject({
      method: "POST",
      url: "/v1/communications/conversations",
      token: tokenA,
      payload: { personId: person.json<{ id: string }>().id, channel: "WHATSAPP" },
    });
    expect(conv.statusCode).toBe(201);
    const inboundId = `s3c-inbound-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const inboundBody = "Ol\u00e1, linha viva S3C";
    const delivered = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKeyA}`,
      secret: webhookSecretA,
      payload: {
        event: "message",
        session: deriveWahaSessionName(tenantA),
        payload: {
          id: inboundId,
          from: `${SENDER_A}@c.us`,
          fromMe: false,
          body: inboundBody,
          timestamp: 1758912000,
        },
      },
    });
    expect(delivered.statusCode).toBe(202);
    const stored = await (db as NonNullable<typeof db>)
      .selectFrom("communication.messages")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .where("external_message_id", "=", inboundId)
      .execute();
    expect(stored).toHaveLength(1);

    const after = await inject({ method: "GET", url: "/v1/integrations/whatsapp/session", token: tokenA });
    expect(after.statusCode).toBe(200);
    const lastInbound = after.json<Record<string, unknown>>()["lastInbound"] as Record<string, unknown> | null;
    expect(lastInbound).not.toBeNull();
    expect(lastInbound?.["preview"]).toBe(inboundBody);
    expect(typeof lastInbound?.["occurredAt"]).toBe("string");
  });

  it("rate limit conservador: flood por origem é negado com 429 + Retry-After", async () => {
    let denied = 0;
    let retryAfter: string | null = null;
    for (let i = 0; i < 40; i += 1) {
      const res = await inject({
        method: "POST",
        url: "/v1/integrations/whatsapp/test-message",
        token: tokenA,
        payload: { to: "+5511999990007", text: `Loop S3C ${i}` },
      });
      if (res.statusCode === 429) {
        denied += 1;
        retryAfter = (res.headers["retry-after"] as string | undefined) ?? null;
        expect(res.json()).toEqual({ code: "RATE_LIMITED", message: expect.any(String) });
        break;
      }
      expect(res.statusCode).toBe(200);
    }
    expect(denied).toBe(1);
    expect(retryAfter).not.toBeNull();
  });
});
