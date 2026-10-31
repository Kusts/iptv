import { createHash } from "node:crypto";
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
  __resetIntegrationTestDoubles,
  __setIntegrationTestDoubles,
} from "../src/integrations/integrations.commands.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(0, 12)}@example.com`;
}

// Synthetic low-entropy fixtures (never real credentials, never `sk-`).
// NOTE: the value must not contain `api-key`/`apikey` or gitleaks
// generic-api-key flags it (verified); `asaas`-scoped synthetic is clean.
// Must NEVER appear in any webhook_ensure response body or audit metadata.
const ASAAS_KEY_A = "s2a-synthetic-asaas-aaa111";
const ASAAS_KEY_B = "s2a-synthetic-asaas-bbb222";

/** Exact sanitized key set of every webhook_ensure response (no secret material). */
const SANITIZED_KEYS = ["webhookUrl", "providerWebhookId", "hasAuthToken", "status"];

const PUBLIC_BASE = "https://s2a-platform.example.com";

class FakeVault implements SecretsWriterPort {
  readonly name = "fake-test-vault";
  readonly store = new Map<string, string>();
  failPut: boolean = false;

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
    if (this.failPut) {
      throw new SecretsError("TRANSPORT", "fake vault: transport error");
    }
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

interface FakeWebhook {
  id: string;
  url: string;
}

let remoteWebhooks: FakeWebhook[] = [];
let webhookSeq = 0;
let asaasMode: "ok" | "unauthorized" | "transport-list" | "transport-save" = "ok";
let failNextSave = false;
const seenLists: Array<{ url: string; hasAccessToken: boolean; accessToken: string | null }> = [];
const seenSaves: Array<{ method: string; url: string; hasAccessToken: boolean; body: Record<string, unknown> }> = [];

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const headers = new Headers(init?.headers);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.includes("/v3/webhooks") && method === "GET") {
    const presented = headers.get("access_token");
    seenLists.push({ url, hasAccessToken: presented !== null, accessToken: presented });
    if (asaasMode === "transport-list") {
      throw Object.assign(new Error("fake asaas list timeout"), { name: "TimeoutError" });
    }
    if (asaasMode === "unauthorized") {
      return new Response("denied", { status: 401 });
    }
    return jsonResponse({ data: remoteWebhooks, totalCount: remoteWebhooks.length });
  }
  if (url.includes("/v3/webhooks") && (method === "POST" || method === "PUT")) {
    if (asaasMode === "transport-save" || failNextSave) {
      failNextSave = false;
      throw Object.assign(new Error("fake asaas save timeout"), { name: "TimeoutError" });
    }
    if (asaasMode === "unauthorized") {
      return new Response("denied", { status: 401 });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seenSaves.push({ method, url, hasAccessToken: headers.has("access_token"), body });
    if (method === "POST") {
      webhookSeq += 1;
      const created: FakeWebhook = { id: `wh_s2a_${webhookSeq}`, url: String(body["url"] ?? "") };
      remoteWebhooks.push(created);
      return jsonResponse({
        id: created.id,
        name: body["name"],
        url: created.url,
        email: body["email"],
        enabled: true,
        interrupted: false,
        apiVersion: 3,
        hasAuthToken: true,
        sendType: "SEQUENTIALLY",
        events: body["events"],
      });
    }
    const id = decodeURIComponent(url.split("/").pop() ?? "");
    const found = remoteWebhooks.find((webhook) => webhook.id === id);
    if (found !== undefined) {
      found.url = String(body["url"] ?? found.url);
    }
    return jsonResponse({
      id,
      name: body["name"],
      url: found?.url ?? body["url"],
      email: body["email"],
      enabled: true,
      interrupted: false,
      apiVersion: 3,
      hasAuthToken: true,
      sendType: "SEQUENTIALLY",
      events: body["events"],
    });
  }
  return new Response("unexpected fake route", { status: 500 });
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function webhookTokenRef(tenantId: string): string {
  return buildIntegrationSecretRef({
    tenantId,
    provider: "asaas",
    environment: "SANDBOX",
    key: "ASAAS_WEBHOOK_TOKEN",
  });
}

describe.skipIf(!hasDb)("integrations webhook_ensure provisioning (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });
  const vault = new FakeVault();
  let app: NestFastifyApplication;

  let tokenA = "";
  let tenantA = "";
  let tokenB = "";
  let tenantB = "";
  let tokenOperator = "";

  function inject(opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    revision?: string | null;
    idempotencyKey?: string;
    headers?: Record<string, string>;
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
    }
    if (opts.token !== undefined && opts.revision !== null) {
      headers["x-tenant-context-revision"] = opts.revision ?? "0";
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

  function setBaseUrl(value: string | null): void {
    __setIntegrationTestDoubles({
      secretsWriter: vault,
      asaasFetch: fakeFetch as typeof fetch,
      webhookBaseUrl: value,
    });
  }

  async function sessionRevision(token: string): Promise<string> {
    const res = await inject({ method: "GET", url: "/v1/auth/session", token, revision: null });
    expect(res.statusCode).toBe(200);
    return res.json<{ tenantContextRevision: string }>().tenantContextRevision;
  }

  async function channelOf(tenantId: string) {
    return db
      .selectFrom("billing.tenant_channels")
      .select(["tenant_key", "webhook_secret_hash", "status"])
      .where("tenant_id", "=", tenantId)
      .where("channel", "=", "ASAAS")
      .executeTakeFirst();
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    remoteWebhooks = [];
    webhookSeq = 0;
    asaasMode = "ok";
    setBaseUrl(PUBLIC_BASE);
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();

    const registerA = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("s2a-a"), password: "correct-horse-8", tenantName: "S2A Tenant A" },
    });
    expect(registerA.statusCode).toBe(201);
    const bodyA = registerA.json<{ token: string; activeTenantId: string }>();
    tokenA = bodyA.token;
    tenantA = bodyA.activeTenantId;

    const registerB = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("s2a-b"), password: "correct-horse-8", tenantName: "S2A Tenant B" },
    });
    expect(registerB.statusCode).toBe(201);
    const bodyB = registerB.json<{ token: string; activeTenantId: string }>();
    tokenB = bodyB.token;
    tenantB = bodyB.activeTenantId;
    expect(tenantB).not.toBe(tenantA);

    const registerOp = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("s2a-op"), password: "correct-horse-8", tenantName: "S2A Operator Home" },
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
    const opSwitched = await inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/switch`,
      token: tokenOperator,
      revision: await sessionRevision(tokenOperator),
    });
    expect(opSwitched.statusCode).toBe(200);

    // Tenant A gets a live Asaas binding (vault-backed, like S1C2); tenant B
    // starts without one (404 path).
    const configured = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: tokenA,
      payload: { environment: "SANDBOX", secret: { apiKey: ASAAS_KEY_A } },
    });
    expect(configured.statusCode).toBe(201);
  }, 120_000);

  afterAll(async () => {
    __resetIntegrationTestDoubles();
    await app?.close().catch(() => undefined);
    await (db as unknown as { destroy: () => Promise<void> }).destroy?.().catch(() => undefined);
  });

  it("unknown provider is 404 and whatsapp refuses 501 without touching the vault", async () => {
    const unknown = await inject({
      method: "POST",
      url: "/v1/integrations/nope/webhook",
      token: tokenA,
      payload: { environment: "SANDBOX" },
    });
    expect(unknown.statusCode).toBe(404);

    const sizeBefore = vault.store.size;
    const refused = await inject({
      method: "POST",
      url: "/v1/integrations/whatsapp/webhook",
      token: tokenA,
      payload: { environment: "SANDBOX" },
    });
    expect(refused.statusCode).toBe(501);
    expect(refused.json<{ code: string }>().code).toBe("CAPABILITY_UNCERTIFIED");
    expect(vault.store.size).toBe(sizeBefore);
    expect(await channelOf(tenantA)).toBeUndefined();
  });

  it("missing binding is 404 without provider or vault effects", async () => {
    const listsBefore = seenLists.length;
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/webhook",
      token: tokenB,
      payload: { environment: "SANDBOX" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe("NOT_FOUND");
    expect(seenLists.length).toBe(listsBefore);
    expect(await channelOf(tenantB)).toBeUndefined();
  });

  it("absent base URL fails closed in manual mode without marking anything", async () => {
    setBaseUrl(null);
    try {
      const res = await inject({
        method: "POST",
        url: "/v1/integrations/asaas/webhook",
        token: tokenA,
        payload: { environment: "SANDBOX" },
      });
      expect(res.statusCode).toBe(503);
      const body = res.json<{ code: string; message: string }>();
      expect(body.code).toBe("WEBHOOK_BASE_URL_NOT_CONFIGURED");
      expect(body.message).toContain("INTEGRATIONS_PUBLIC_BASE_URL");
      expect(body.message).toContain("/v1/webhooks/asaas/");
      expect(body.message).toContain("PAYMENT_RECEIVED");
    } finally {
      setBaseUrl(PUBLIC_BASE);
    }
    expect(await channelOf(tenantA)).toBeUndefined();
    expect(vault.store.has(webhookTokenRef(tenantA))).toBe(false);
  });

  it("creates a new provider webhook and syncs the channel hash (POST path)", async () => {
    const listsBefore = seenLists.length;
    const savesBefore = seenSaves.length;
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/webhook",
      token: tokenA,
      payload: { environment: "SANDBOX" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual([...SANITIZED_KEYS].sort());
    expect(body["hasAuthToken"]).toBe(true);
    expect(body["status"]).toBe("ACTIVE");
    expect(typeof body["webhookUrl"]).toBe("string");
    expect(typeof body["providerWebhookId"]).toBe("string");

    const webhookUrl = body["webhookUrl"] as string;
    expect(webhookUrl.startsWith(`${PUBLIC_BASE}/v1/webhooks/asaas/asaas-`)).toBe(true);
    const tenantKey = webhookUrl.slice(`${PUBLIC_BASE}/v1/webhooks/asaas/`.length);
    expect(tenantKey.length).toBeGreaterThan(0);

    // The provider saw the canonical URL over the allowlist with the
    // tenant's API key (never the client's), plus the official body shape.
    expect(seenLists.length).toBe(listsBefore + 1);
    expect(seenLists[seenLists.length - 1]?.url.startsWith("https://api-sandbox.asaas.com/v3/")).toBe(true);
    expect(seenLists[seenLists.length - 1]?.accessToken).toBe(ASAAS_KEY_A);
    expect(seenSaves.length).toBe(savesBefore + 1);
    const save = seenSaves[seenSaves.length - 1];
    expect(save?.method).toBe("POST");
    const sent = (save?.body ?? {}) as Record<string, unknown>;
    expect(sent["url"]).toBe(webhookUrl);
    expect(sent["apiVersion"]).toBe(3);
    expect(sent["sendType"]).toBe("SEQUENTIALLY");
    expect(sent["enabled"]).toBe(true);
    expect(sent["interrupted"]).toBe(false);
    expect(sent["events"]).toEqual(["PAYMENT_RECEIVED", "PAYMENT_OVERDUE", "PAYMENT_REFUNDED"]);
    expect(typeof sent["name"]).toBe("string");
    expect(typeof sent["email"]).toBe("string");

    // Token discipline: generated (32+ chars, no spaces), distinct from the
    // API key, stored in the vault, and ONLY its sha256 lands on the channel.
    const stored = vault.store.get(webhookTokenRef(tenantA));
    expect(typeof stored).toBe("string");
    const token = stored as string;
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(token).not.toMatch(/\s/);
    expect(token).not.toBe(ASAAS_KEY_A);
    expect(sent["authToken"]).toBe(token);

    const channel = await channelOf(tenantA);
    expect(channel?.status).toBe("ACTIVE");
    expect(channel?.tenant_key).toBe(tenantKey);
    expect(channel?.webhook_secret_hash).toBe(sha256Hex(token));

    // Sanitized by construction: the response carries the `hasAuthToken`
    // presence flag but never the token value, the API key, a ref or a path.
    const dumped = JSON.stringify(res.json());
    expect(dumped).not.toContain(token);
    expect(dumped).not.toContain(ASAAS_KEY_A);
    expect(dumped).not.toMatch(/secret_ref|infisical/i);
  });

  it("reuses the existing webhook and vault token on retry (PUT path, no duplicates)", async () => {
    const tokenBefore = vault.store.get(webhookTokenRef(tenantA));
    const savesBefore = seenSaves.length;
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/webhook",
      token: tokenA,
      payload: { environment: "SANDBOX" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body["providerWebhookId"]).toBe("wh_s2a_1");
    // Dedupe by canonical URL: exactly one provider webhook, updated in place.
    expect(remoteWebhooks).toHaveLength(1);
    expect(remoteWebhooks[0]?.id).toBe("wh_s2a_1");
    expect(seenSaves.length).toBe(savesBefore + 1);
    expect(seenSaves[seenSaves.length - 1]?.method).toBe("PUT");
    expect(seenSaves[seenSaves.length - 1]?.url).toContain("wh_s2a_1");
    // Same vault token reused (no rotation on retry), channel hash untouched.
    expect(vault.store.get(webhookTokenRef(tenantA))).toBe(tokenBefore);
    expect((await channelOf(tenantA))?.webhook_secret_hash).toBe(sha256Hex(tokenBefore as string));
  });

  it("provider credential rejection is 409 without marking the channel", async () => {
    // Tenant B gets its own binding first (401 comes from the provider, not
    // from a missing binding).
    const configured = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: tokenB,
      payload: { environment: "SANDBOX", secret: { apiKey: ASAAS_KEY_B } },
    });
    expect(configured.statusCode).toBe(201);

    asaasMode = "unauthorized";
    try {
      const res = await inject({
        method: "POST",
        url: "/v1/integrations/asaas/webhook",
        token: tokenB,
        payload: { environment: "SANDBOX" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe("PRECONDITION_FAILED");
    } finally {
      asaasMode = "ok";
    }
    expect(await channelOf(tenantB)).toBeUndefined();
    expect(vault.store.has(webhookTokenRef(tenantB))).toBe(false);
  });

  it("provider save timeout keeps the vault token and the retry converges", async () => {
    failNextSave = true;
    const failed = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/webhook",
      token: tokenB,
      payload: { environment: "SANDBOX" },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json<{ code: string }>().code).toBe("PROVIDER_UNAVAILABLE");
    // The token survives the failed save (retained, reusable — never deleted).
    const retained = vault.store.get(webhookTokenRef(tenantB));
    expect(typeof retained).toBe("string");
    expect(await channelOf(tenantB)).toBeUndefined();

    const retry = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/webhook",
      token: tokenB,
      payload: { environment: "SANDBOX" },
    });
    expect(retry.statusCode).toBe(201);
    const body = retry.json<Record<string, unknown>>();
    expect(body["status"]).toBe("ACTIVE");
    // Same token reused after the transport failure; channel hash in sync.
    expect(vault.store.get(webhookTokenRef(tenantB))).toBe(retained);
    expect((await channelOf(tenantB))?.webhook_secret_hash).toBe(sha256Hex(retained as string));
  });

  it("ten webhooks without a URL match fail with a structured 4xx", async () => {
    remoteWebhooks = Array.from({ length: 10 }, (_, index) => ({
      id: `wh_s2a_full_${index}`,
      url: `https://other.example.com/hook/${index}`,
    }));
    try {
      const res = await inject({
        method: "POST",
        url: "/v1/integrations/asaas/webhook",
        token: tokenB,
        payload: { environment: "SANDBOX" },
      });
      // Any 4xx is accepted (provider-shape agnostic); the contract pins 409.
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe("PRECONDITION_FAILED");
    } finally {
      remoteWebhooks = remoteWebhooks.filter((webhook) => !webhook.id.startsWith("wh_s2a_full_"));
    }
  });

  it("tenant B is isolated and the operator cannot provision", async () => {
    const channelA = await channelOf(tenantA);
    const channelB = await channelOf(tenantB);
    expect(channelA?.tenant_key).not.toBe(channelB?.tenant_key);
    expect(vault.store.get(webhookTokenRef(tenantA))).not.toBe(
      vault.store.get(webhookTokenRef(tenantB)),
    );

    const revision = await sessionRevision(tokenOperator);
    const opWrite = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/webhook",
      token: tokenOperator,
      revision,
      payload: { environment: "SANDBOX" },
    });
    expect(opWrite.statusCode).toBe(403);
    expect(JSON.stringify(opWrite.json())).not.toContain(ASAAS_KEY_A);
  });

  it("vault failure fails closed with 503 and no channel row", async () => {
    // Fresh tenant C: configure succeeds, then the vault breaks before ensure.
    const registerC = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("s2a-c"), password: "correct-horse-8", tenantName: "S2A Tenant C" },
    });
    expect(registerC.statusCode).toBe(201);
    const bodyC = registerC.json<{ token: string; activeTenantId: string }>();
    const configured = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: bodyC.token,
      payload: { environment: "SANDBOX", secret: { apiKey: ASAAS_KEY_A } },
    });
    expect(configured.statusCode).toBe(201);

    vault.failPut = true;
    try {
      const res = await inject({
        method: "POST",
        url: "/v1/integrations/asaas/webhook",
        token: bodyC.token,
        payload: { environment: "SANDBOX" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json<{ code: string }>().code).toBe("VAULT_UNAVAILABLE");
    } finally {
      vault.failPut = false;
    }
    expect(await channelOf(bodyC.activeTenantId)).toBeUndefined();
  });

  it("the stored hash verifies end-to-end through the real ingress path", async () => {
    const channelA = await channelOf(tenantA);
    const tenantKey = channelA?.tenant_key as string;
    const token = vault.store.get(webhookTokenRef(tenantA)) as string;

    const accepted = await inject({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}?defer=1`,
      headers: { "asaas-access-token": token },
      payload: { event: "PAYMENT_RECEIVED", payment: { id: "pay_s2a_probe" } },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ accepted: true, deduped: false });

    const forged = await inject({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}?defer=1`,
      headers: { "asaas-access-token": "s2a-synthetic-wrong-token-000000" },
      payload: { event: "PAYMENT_RECEIVED", payment: { id: "pay_s2a_probe" } },
    });
    expect(forged.statusCode).toBe(401);
  });

  it("audit covers webhook_ensure without secret material", async () => {
    const rows = await db
      .selectFrom("platform.audit_log")
      .select(["action_key", "resource_type", "metadata_json"])
      .where("tenant_id", "=", tenantA)
      .where("action_key", "=", "integration.webhook_ensure")
      .execute();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.resource_type).toBe("tenant_channel");
      const dumped = JSON.stringify(row);
      expect(dumped).not.toContain(vault.store.get(webhookTokenRef(tenantA)) as string);
      expect(dumped).not.toContain(ASAAS_KEY_A);
    }
  });

  it("rotates the webhook token: old token 401, new token 202, tenant B untouched (S5B, #89)", async () => {
    const channelBefore = await channelOf(tenantA);
    const tenantKey = channelBefore?.tenant_key as string;
    expect(typeof tenantKey).toBe("string");
    const t1 = vault.store.get(webhookTokenRef(tenantA)) as string;
    expect(typeof t1).toBe("string");

    // T1 verifies end-to-end through the real ingress path before rotation.
    const pre = await inject({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}?defer=1`,
      headers: { "asaas-access-token": t1 },
      payload: { event: "PAYMENT_RECEIVED", payment: { id: "pay_s5b_pre" } },
    });
    expect(pre.statusCode).toBe(202);

    // Tenant B snapshot (must stay untouched by A's rotation).
    const bTokenBefore = vault.store.get(webhookTokenRef(tenantB));
    const bChannelBefore = await channelOf(tenantB);

    // Rotation: delete the vault token, then re-ensure as a NEW operation
    // (fresh idempotency key) — the handler must mint a DIFFERENT token.
    await vault.deleteSecret(webhookTokenRef(tenantA));
    expect(vault.store.has(webhookTokenRef(tenantA))).toBe(false);
    const savesBefore = seenSaves.length;
    const re = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/webhook",
      token: tokenA,
      idempotencyKey: "s5b-rotation-1",
      payload: { environment: "SANDBOX" },
    });
    expect(re.statusCode).toBe(201);
    const t2 = vault.store.get(webhookTokenRef(tenantA)) as string;
    expect(typeof t2).toBe("string");
    expect(t2).not.toBe(t1);
    expect(t2.length).toBeGreaterThanOrEqual(32);
    expect(t2).not.toMatch(/\s/);
    expect((await channelOf(tenantA))?.webhook_secret_hash).toBe(sha256Hex(t2));
    // Dedupe by canonical URL: exactly one provider webhook for this tenant,
    // and the response points at it (POST on first provisioning after the
    // array reset, PUT on re-provision — either way, no duplicate).
    expect(seenSaves.length).toBe(savesBefore + 1);
    const canonicalUrl = `${PUBLIC_BASE}/v1/webhooks/asaas/${tenantKey}`;
    const matches = remoteWebhooks.filter((webhook) => webhook.url === canonicalUrl);
    expect(matches).toHaveLength(1);
    expect(re.json<Record<string, unknown>>()["providerWebhookId"]).toBe(matches[0]?.id);

    // Old token rejected, new token accepted — end to end via ingress.
    const stale = await inject({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}?defer=1`,
      headers: { "asaas-access-token": t1 },
      payload: { event: "PAYMENT_RECEIVED", payment: { id: "pay_s5b_old" } },
    });
    expect(stale.statusCode).toBe(401);
    const fresh = await inject({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}?defer=1`,
      headers: { "asaas-access-token": t2 },
      payload: { event: "PAYMENT_RECEIVED", payment: { id: "pay_s5b_new" } },
    });
    expect(fresh.statusCode).toBe(202);
    expect(fresh.json()).toEqual({ accepted: true, deduped: false });

    // Tenant B untouched: same vault token, same channel hash.
    expect(vault.store.get(webhookTokenRef(tenantB))).toBe(bTokenBefore);
    expect((await channelOf(tenantB))?.webhook_secret_hash).toBe(
      bChannelBefore?.webhook_secret_hash,
    );
  });

  it("failed rotation save keeps the new vault token and the old channel hash; retry converges (S5B, #89)", async () => {
    const channelBefore = await channelOf(tenantA);
    const tenantKey = channelBefore?.tenant_key as string;
    const tCurrent = vault.store.get(webhookTokenRef(tenantA)) as string;
    const hashBefore = channelBefore?.webhook_secret_hash;
    expect(hashBefore).toBe(sha256Hex(tCurrent));

    // Rotation attempt whose Asaas save fails once (transport).
    await vault.deleteSecret(webhookTokenRef(tenantA));
    failNextSave = true;
    const failed = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/webhook",
      token: tokenA,
      idempotencyKey: "s5b-rotation-2",
      payload: { environment: "SANDBOX" },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json<{ code: string }>().code).toBe("PROVIDER_UNAVAILABLE");

    // Rollback preserved: the NEW token stays in the vault (reusable, never
    // deleted) while the channel still points at the OLD hash (not corrupted),
    // so the pre-rotation token keeps verifying at ingress meanwhile.
    const tNew = vault.store.get(webhookTokenRef(tenantA)) as string;
    expect(typeof tNew).toBe("string");
    expect(tNew).not.toBe(tCurrent);
    expect((await channelOf(tenantA))?.webhook_secret_hash).toBe(hashBefore);
    const stillValid = await inject({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}?defer=1`,
      headers: { "asaas-access-token": tCurrent },
      payload: { event: "PAYMENT_RECEIVED", payment: { id: "pay_s5b_mid" } },
    });
    expect(stillValid.statusCode).toBe(202);
    const notYet = await inject({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}?defer=1`,
      headers: { "asaas-access-token": tNew },
      payload: { event: "PAYMENT_RECEIVED", payment: { id: "pay_s5b_mid" } },
    });
    expect(notYet.statusCode).toBe(401);

    // Retry with Asaas healthy converges: SAME new token reused (PUT + upsert).
    const savesBefore = seenSaves.length;
    const retry = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/webhook",
      token: tokenA,
      idempotencyKey: "s5b-rotation-3",
      payload: { environment: "SANDBOX" },
    });
    expect(retry.statusCode).toBe(201);
    expect(vault.store.get(webhookTokenRef(tenantA))).toBe(tNew);
    expect((await channelOf(tenantA))?.webhook_secret_hash).toBe(sha256Hex(tNew));
    expect(seenSaves.length).toBe(savesBefore + 1);
    expect(seenSaves[seenSaves.length - 1]?.method).toBe("PUT");

    // Post-convergence: rotated-out token rejected, current token accepted.
    const rotatedOut = await inject({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}?defer=1`,
      headers: { "asaas-access-token": tCurrent },
      payload: { event: "PAYMENT_RECEIVED", payment: { id: "pay_s5b_final" } },
    });
    expect(rotatedOut.statusCode).toBe(401);
    const converged = await inject({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}?defer=1`,
      headers: { "asaas-access-token": tNew },
      payload: { event: "PAYMENT_RECEIVED", payment: { id: "pay_s5b_final2" } },
    });
    expect(converged.statusCode).toBe(202);
  });
});
