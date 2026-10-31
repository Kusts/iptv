import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createDb, applyMigrations, withTenantTransaction } from "@iptv/database";
import { newId } from "@iptv/domain";
import { SecretsError, buildIntegrationSecretRef, type SecretsWriterPort } from "@iptv/secrets";
import { AppModule } from "../src/app.module.js";
import {
  __resetIntegrationTestDoubles,
  __setIntegrationTestDoubles,
} from "../src/integrations/integrations.commands.js";
import {
  __resetWhatsappSessionTestDoubles,
  __setWhatsappSessionTestDoubles,
} from "../src/integrations/whatsapp-sessions.commands.js";
import {
  __resetWahaAdminFetchForTests,
  __setWahaAdminFetchForTests,
} from "../src/integrations/waha-admin.port.js";
import {
  bindSession,
  clearSessionBindingsForTests,
  expectedSessionFor,
} from "../src/communications/waha-sessions.js";
import {
  deriveWahaSessionName,
  getBoundWahaSession,
  resolveExpectedWahaSession,
  saveWahaSessionBinding,
} from "../src/communications/waha-session-store.js";
import { currentGateway, resetGatewayForTests } from "../src/communications/messaging-gateway.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

const db = hasDb ? createDb({ connectionString: connectionString as string }) : null;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(0, 12)}@example.com`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Synthetic fixtures only — never real credentials, never `sk-`.
const WEBHOOK_TOKEN_A = "s3a-synthetic-waha-hook-token-aaa111bbb222";
const SENDER_A = "5511999990101";
const SENDER_B = "5511999990202";

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

/** Minimal fake WAHA admin API: sessions live in a Map, QR is fixed PNG bytes. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface FakeWahaSession {
  name: string;
  status: string;
  webhookUrl: string | null;
  webhookSecret: string | null;
}

function createFakeWaha() {
  const sessions = new Map<string, FakeWahaSession>();
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  let failMode: "none" | "down" = "none";

  function sessionNameOf(url: string): string | null {
    const path = new URL(url, "http://waha.test").pathname;
    const m =
      /^\/api\/sessions\/([^/]+)(?:\/(start|stop|restart))?\/?$/.exec(path) ??
      /^\/api\/([^/]+)\/auth\/qr$/.exec(path);
    return m?.[1] === undefined || m[1] === "sessions" ? null : (m[1] as string);
  }

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
    if (failMode === "down") {
      throw Object.assign(new Error("fake waha down"), { name: "TimeoutError" });
    }
    // GET /api/sessions/:name
    if (method === "GET" && /^\/api\/sessions\/[^/]+\/?$/.test(path)) {
      const name = sessionNameOf(url);
      const session = name === null ? undefined : sessions.get(name);
      if (session === undefined) {
        return new Response("not found", { status: 404 });
      }
      return Response.json({ name: session.name, status: session.status, engine: { engine: "WEBJS" }, me: null });
    }
    // POST /api/sessions (create)
    if (method === "POST" && /^\/api\/sessions\/?$/.test(path)) {
      const payload = (body ?? {}) as { name?: unknown; start?: unknown; config?: unknown };
      const name = typeof payload.name === "string" ? payload.name : `sess-${sessions.size + 1}`;
      if (sessions.has(name)) {
        return new Response("conflict", { status: 409 });
      }
      const webhooks = (payload.config as { webhooks?: Array<{ url?: string }> } | undefined)?.webhooks;
      const hook = webhooks?.[0];
      const created: FakeWahaSession = {
        name,
        status: payload.start === false ? "STOPPED" : "SCAN_QR_CODE",
        webhookUrl: hook?.url ?? null,
        webhookSecret: null,
      };
      const customHeaders = (
        body as { config?: { webhooks?: Array<{ customHeaders?: Array<{ name?: string; value?: string }> }> } }
      )?.config?.webhooks?.[0]?.customHeaders;
      created.webhookSecret = customHeaders?.find((h) => h.name === "x-waha-secret")?.value ?? null;
      sessions.set(name, created);
      return Response.json({ name, status: created.status }, { status: 201 });
    }
    // POST /api/sessions/:name/start|stop|restart
    const action = /^\/api\/sessions\/[^/]+\/(start|stop|restart)\/?$/.exec(path)?.[1];
    if (method === "POST" && action !== undefined) {
      const name = sessionNameOf(url);
      const session = name === null ? undefined : sessions.get(name);
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
    // GET /api/:session/auth/qr
    if (method === "GET" && /^\/api\/[^/]+\/auth\/qr$/.test(path)) {
      const name = sessionNameOf(url);
      const session = name === null ? undefined : sessions.get(name);
      if (session === undefined) {
        return new Response("not found", { status: 404 });
      }
      if (session.status !== "SCAN_QR_CODE") {
        return new Response("no qr for this state", { status: 422 });
      }
      return new Response(PNG_BYTES, { status: 200, headers: { "Content-Type": "image/png" } });
    }
    return new Response("unexpected", { status: 500 });
  }

  return { sessions, calls, fakeFetch, setFailMode: (mode: "none" | "down") => { failMode = mode; } };
}

describe.skipIf(!hasDb)("whatsapp session onboarding S3a (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  let tokenA = "";
  let tenantA = "";
  let tokenB = "";
  let tenantB = "";
  let vault: FakeVault;
  let waha = createFakeWaha();

  async function inject(opts: {
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

  async function registerTenant(label: string): Promise<{ token: string; tenantId: string }> {
    const res = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email(`s3a-${label}`), password: "correct-horse-8", tenantName: `S3a ${label}` },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ token: string; activeTenantId: string }>();
    return { token: body.token, tenantId: body.activeTenantId };
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    process.env["WAHA_BASE_URL"] = "http://waha.test";
    process.env["WAHA_API_KEY"] = "s3a-synthetic-waha-admin-key";
    resetGatewayForTests();
    expect(currentGateway().name).toBe("waha");
    vault = new FakeVault();
    __setIntegrationTestDoubles({ secretsWriter: vault, webhookBaseUrl: "https://app.exemplo.com" });
    __setWhatsappSessionTestDoubles({ secretsWriter: vault, webhookBaseUrl: "https://app.exemplo.com" });
    waha = createFakeWaha();
    __setWahaAdminFetchForTests(waha.fakeFetch);
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    ({ token: tokenA, tenantId: tenantA } = await registerTenant("a"));
    ({ token: tokenB, tenantId: tenantB } = await registerTenant("b"));
  }, 120_000);

  afterAll(async () => {
    __resetIntegrationTestDoubles();
    __resetWhatsappSessionTestDoubles();
    __resetWahaAdminFetchForTests();
    clearSessionBindingsForTests();
    delete process.env["WAHA_BASE_URL"];
    delete process.env["WAHA_API_KEY"];
    resetGatewayForTests();
    await app?.close().catch(() => undefined);
    await db?.destroy().catch(() => undefined);
  });

  it("RED: binding survives a process restart (Map loss does not lose the tenant binding)", async () => {
    expect(deriveWahaSessionName(tenantA)).toBe(`tenant-${tenantA.replace(/-/g, "").slice(0, 12)}`);
    await withTenantTransaction(db as never, tenantA, async (trx) =>
      saveWahaSessionBinding(trx as never, tenantA, {
        sessionName: deriveWahaSessionName(tenantA),
        status: "SCAN_QR_CODE",
      }),
    );
    // Simulate a process restart: the in-memory Map is gone.
    clearSessionBindingsForTests();
    const resolved = await resolveExpectedWahaSession(db as never, tenantA);
    expect(resolved).toBe(deriveWahaSessionName(tenantA));
  });

  it("documents the legacy Map loss (restart drops the binding, falls back to shared default)", () => {
    bindSession(tenantA, "tenant-a-legacy");
    expect(expectedSessionFor(tenantA)).toBe("tenant-a-legacy");
    clearSessionBindingsForTests();
    expect(expectedSessionFor(tenantA)).toBe("default");
  });

  it("GET session without binding fails closed (404, never another tenant's session)", async () => {
    const res = await inject({ method: "GET", url: "/v1/integrations/whatsapp/session", token: tokenB });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: "NO_SESSION", message: expect.any(String) });
  });

  it("POST session provisions an exclusive session, configures the webhook and persists the binding", async () => {
    const res = await inject({ method: "POST", url: "/v1/integrations/whatsapp/session", token: tokenA, payload: {} });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body["sessionName"]).toBe(deriveWahaSessionName(tenantA));
    expect(body["status"]).toBe("SCAN_QR_CODE");
    expect(body["webhookUrl"]).toBe(
      `https://app.exemplo.com/v1/webhooks/waha/waha-${tenantA.replace(/-/g, "").slice(0, 12)}`,
    );
    expect(body["hasWebhookSecret"]).toBe(true);
    expect(body["reused"]).toBe(false);
    // Sanitized: exact key set (secret VALUES never leave the server; the
    // `hasWebhookSecret` boolean only attests presence, like Asaas
    // `hasAuthToken`).
    expect(new Set(Object.keys(body))).toEqual(
      new Set(["sessionName", "status", "webhookUrl", "hasWebhookSecret", "reused"]),
    );
    expect(JSON.stringify(body)).not.toContain(WEBHOOK_TOKEN_A);
    // WAHA received exactly one create with the tenant webhook + auth header.
    const creates = waha.calls.filter((c) => c.method === "POST" && c.url === "/api/sessions");
    expect(creates).toHaveLength(1);
    const createBody = creates[0]?.body as {
      name?: string;
      config?: { webhooks?: Array<{ url?: string; events?: string[]; customHeaders?: Array<{ name?: string; value?: string }> }> };
    };
    expect(createBody.name).toBe(deriveWahaSessionName(tenantA));
    expect(createBody.config?.webhooks?.[0]?.url).toBe(body["webhookUrl"]);
    expect(createBody.config?.webhooks?.[0]?.events).toEqual(expect.arrayContaining(["message", "session.status"]));
    const header = createBody.config?.webhooks?.[0]?.customHeaders?.find((h) => h.name === "x-waha-secret");
    expect(typeof header?.value).toBe("string");
    expect((header?.value as string).length).toBeGreaterThanOrEqual(32);
    // The token lives in the vault; only its hash is in the database.
    const stored = await vault.getSecret(
      buildIntegrationSecretRef({
        tenantId: tenantA,
        provider: "whatsapp",
        environment: "production",
        key: "WAHA_WEBHOOK_SECRET",
      }),
    );
    expect(stored).toBe(header?.value);
    const row = await withTenantTransaction(db as never, tenantA, async (trx) =>
      getBoundWahaSession(trx as never, tenantA),
    );
    expect(row?.sessionName).toBe(deriveWahaSessionName(tenantA));
    const raw = await (db as NonNullable<typeof db>)
      .selectFrom("communication.tenant_channels")
      .select(["webhook_secret_hash", "status"])
      .where("tenant_id", "=", tenantA)
      .where("channel", "=", "WHATSAPP")
      .executeTakeFirst();
    expect(raw?.webhook_secret_hash).toBe(sha256(stored));
    expect(raw?.status).toBe("ACTIVE");
  });

  it("POST session is idempotent (existing live session is reused, never duplicated)", async () => {
    const before = waha.calls.filter((c) => c.method === "POST" && c.url === "/api/sessions").length;
    const res = await inject({ method: "POST", url: "/v1/integrations/whatsapp/session", token: tokenA, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json<Record<string, unknown>>()["reused"]).toBe(true);
    const after = waha.calls.filter((c) => c.method === "POST" && c.url === "/api/sessions").length;
    expect(after).toBe(before);
  });

  it("GET session returns the live status verbatim (FAILED is not a generic disconnect)", async () => {
    const sessionName = deriveWahaSessionName(tenantA);
    const stored = waha.sessions.get(sessionName);
    expect(stored).toBeDefined();
    if (stored !== undefined) {
      stored.status = "FAILED";
    }
    const res = await inject({ method: "GET", url: "/v1/integrations/whatsapp/session", token: tokenA });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body["sessionName"]).toBe(sessionName);
    expect(body["status"]).toBe("FAILED");
    expect(JSON.stringify(body)).not.toContain("WAHA");
  });

  it("GET qr proxies PNG bytes with no-store; WORKING sessions honestly report no QR", async () => {
    const sessionName = deriveWahaSessionName(tenantA);
    const stored = waha.sessions.get(sessionName);
    if (stored !== undefined) {
      stored.status = "SCAN_QR_CODE";
    }
    const qr = await inject({ method: "GET", url: "/v1/integrations/whatsapp/qr", token: tokenA });
    expect(qr.statusCode).toBe(200);
    expect(qr.headers["content-type"]).toContain("image/png");
    expect(qr.headers["cache-control"]).toContain("no-store");
    expect((qr.rawPayload as Buffer).equals(PNG_BYTES)).toBe(true);
    if (stored !== undefined) {
      stored.status = "WORKING";
    }
    const missing = await inject({ method: "GET", url: "/v1/integrations/whatsapp/qr", token: tokenA });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: "QR_NOT_READY", message: expect.any(String) });
  });

  it("restart survives: clearing the Map does not lose the persisted binding (HTTP proof)", async () => {
    clearSessionBindingsForTests();
    const res = await inject({ method: "GET", url: "/v1/integrations/whatsapp/session", token: tokenA });
    expect(res.statusCode).toBe(200);
    expect(res.json<Record<string, unknown>>()["sessionName"]).toBe(deriveWahaSessionName(tenantA));
  });

  it("tenant B never sees or uses tenant A's session (fail-closed isolation)", async () => {
    const res = await inject({ method: "GET", url: "/v1/integrations/whatsapp/session", token: tokenB });
    expect(res.statusCode).toBe(404);
    const qr = await inject({ method: "GET", url: "/v1/integrations/whatsapp/qr", token: tokenB });
    expect(qr.statusCode).toBe(404);
  });

  it("reconnect restarts a FAILED session and disconnect stops it without erasing history", async () => {
    const sessionName = deriveWahaSessionName(tenantA);
    const stored = waha.sessions.get(sessionName);
    if (stored !== undefined) {
      stored.status = "FAILED";
    }
    const reconnect = await inject({ method: "POST", url: "/v1/integrations/whatsapp/reconnect", token: tokenA, payload: {} });
    expect(reconnect.statusCode).toBe(200);
    expect(reconnect.json<Record<string, unknown>>()["status"]).toBe("SCAN_QR_CODE");
    const disconnect = await inject({ method: "POST", url: "/v1/integrations/whatsapp/disconnect", token: tokenA, payload: {} });
    expect(disconnect.statusCode).toBe(200);
    expect(disconnect.json<Record<string, unknown>>()["status"]).toBe("STOPPED");
    // History preserved: WAHA session and DB binding still exist.
    expect(waha.sessions.has(sessionName)).toBe(true);
    const row = await withTenantTransaction(db as never, tenantA, async (trx) =>
      getBoundWahaSession(trx as never, tenantA),
    );
    expect(row?.sessionName).toBe(sessionName);
  });

  it("inbound from a foreign session is quarantined (never lands in the wrong tenant)", async () => {
    const tenantKeyB = `waha-s3a-b-${randomUUID().slice(0, 8)}`;
    const secretB = `s3a-synthetic-b-hook-secret-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await (db as NonNullable<typeof db>)
      .insertInto("communication.tenant_channels")
      .values({
        id: newId(),
        tenant_id: tenantB,
        channel: "WHATSAPP",
        tenant_key: tenantKeyB,
        webhook_secret_hash: sha256(secretB),
        status: "ACTIVE",
        waha_session_name: null,
        waha_status: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const person = await inject({
      method: "POST",
      url: "/v1/crm/persons",
      token: tokenB,
      payload: { canonicalName: "S3a B Customer", identities: [{ identityType: "WHATSAPP", normalizedValue: SENDER_B }] },
    });
    expect(person.statusCode).toBe(201);
    const foreignSession = deriveWahaSessionName(tenantA);
    const inboundId = `s3a-foreign-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const delivered = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKeyB}`,
      secret: secretB,
      payload: {
        event: "message",
        session: foreignSession,
        payload: {
          id: inboundId,
          from: `${SENDER_B}@c.us`,
          fromMe: false,
          body: "ola",
          timestamp: 1758912000,
        },
      },
    });
    expect(delivered.statusCode).toBe(202);
    const messages = await (db as NonNullable<typeof db>)
      .selectFrom("communication.messages")
      .select(["id"])
      .where("tenant_id", "=", tenantB)
      .where("external_message_id", "=", inboundId)
      .execute();
    expect(messages).toHaveLength(0);
    const exceptions = await (db as NonNullable<typeof db>)
      .selectFrom("communication.exceptions")
      .select(["id", "reason"])
      .where("tenant_id", "=", tenantB)
      .where("kind", "=", "UNMATCHED_INBOUND")
      .where("external_message_id", "=", inboundId)
      .execute();
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.reason).toContain("session mismatch");
  });

  it("outbound without a binding fails closed when WAHA is live (never the shared default)", async () => {
    const person = await inject({
      method: "POST",
      url: "/v1/crm/persons",
      token: tokenB,
      payload: { canonicalName: "S3a B Sender", identities: [{ identityType: "WHATSAPP", normalizedValue: SENDER_A }] },
    });
    expect(person.statusCode).toBe(201);
    const personId = person.json<{ id: string }>().id;
    const conv = await inject({
      method: "POST",
      url: "/v1/communications/conversations",
      token: tokenB,
      payload: { personId, channel: "WHATSAPP" },
    });
    expect(conv.statusCode).toBe(201);
    const conversationId = conv.json<{ id: string }>().id;
    const sent = await inject({
      method: "POST",
      url: `/v1/communications/conversations/${conversationId}/send-manual`,
      token: tokenB,
      payload: { text: "ola" },
    });
    expect(sent.statusCode).toBe(409);
    expect(sent.json<{ code: string; message: string }>().code).toBe("PRECONDITION_FAILED");
    expect(sent.json<{ message: string }>().message).toContain("SESSION_NOT_PROVISIONED");
  });
});
