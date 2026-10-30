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
// Must NEVER appear in any API response body or audit metadata.
const ASAAS_KEY_A = "s1c2-synthetic-asaas-key-aaa111";
const ASAAS_KEY_B = "s1c2-synthetic-asaas-key-bbb222";
const CINE_USER = "s1c2-synthetic-cine-user-001";
const CINE_PASS = "s1c2-synthetic-cine-pass-001";

/** Exact sanitized key set of every write response (no secret material). */
const SANITIZED_KEYS = [
  "id",
  "provider",
  "environment",
  "connection_status",
  "version",
  "last_checked_at",
  "last_error_code",
];

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

let probeMode: "ok" | "unauthorized" | "timeout" | "error" | "notfound-webhooks" = "ok";
const seenProbe: Array<{ url: string; hasAuthToken: boolean }> = [];

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const headers = new Headers(init?.headers);
  seenProbe.push({ url, hasAuthToken: headers.has("access_token") });
  if (probeMode === "timeout") {
    throw Object.assign(new Error("fake probe timeout"), { name: "TimeoutError" });
  }
  if (probeMode === "unauthorized") {
    return new Response("denied", { status: 401 });
  }
  if (probeMode === "error") {
    return new Response("broken", { status: 500 });
  }
  if (probeMode === "notfound-webhooks" && url.includes("/v3/webhooks")) {
    return new Response("none", { status: 404 });
  }
  return new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe.skipIf(!hasDb)("integrations write/configure|test|disable (requires TEST_DATABASE_URL)", () => {
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
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = {};
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

  async function sessionRevision(token: string): Promise<string> {
    const res = await inject({ method: "GET", url: "/v1/auth/session", token, revision: null });
    expect(res.statusCode).toBe(200);
    return res.json<{ tenantContextRevision: string }>().tenantContextRevision;
  }

  async function liveBindingCount(tenantId: string, providerKey: string): Promise<number> {
    const rows = await db
      .selectFrom("provider.provider_accounts")
      .leftJoin("provider.providers", "provider.providers.id", "provider.provider_accounts.provider_id")
      .select(["provider.provider_accounts.id"])
      .where("provider.provider_accounts.tenant_id", "=", tenantId)
      .where("provider.providers.provider_key", "=", providerKey)
      .where("provider.provider_accounts.connection_status", "<>", "DISABLED")
      .execute();
    return rows.length;
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    __setIntegrationTestDoubles({ secretsWriter: vault, asaasFetch: fakeFetch as typeof fetch });
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();

    const registerA = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w2-a"), password: "correct-horse-8", tenantName: "Integrations W Tenant A" },
    });
    expect(registerA.statusCode).toBe(201);
    const bodyA = registerA.json<{ token: string; activeTenantId: string }>();
    tokenA = bodyA.token;
    tenantA = bodyA.activeTenantId;

    const registerB = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w2-b"), password: "correct-horse-8", tenantName: "Integrations W Tenant B" },
    });
    expect(registerB.statusCode).toBe(201);
    const bodyB = registerB.json<{ token: string; activeTenantId: string }>();
    tokenB = bodyB.token;
    tenantB = bodyB.activeTenantId;
    expect(tenantB).not.toBe(tenantA);

    const registerOp = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w2-op"), password: "correct-horse-8", tenantName: "Integrations W Operator Home" },
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
  }, 120_000);

  afterAll(async () => {
    __resetIntegrationTestDoubles();
    await app?.close().catch(() => undefined);
    await (db as unknown as { destroy: () => Promise<void> }).destroy?.().catch(() => undefined);
  });

  it("unknown provider is 404 on all three POSTs", async () => {
    for (const action of ["configure", "test", "disable"]) {
      const res = await inject({
        method: "POST",
        url: `/v1/integrations/nope/${action}`,
        token: tokenA,
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe("NOT_FOUND");
    }
  });

  it("whatsapp refuses 501 CAPABILITY_UNCERTIFIED without creating rows", async () => {
    for (const action of ["configure", "test", "disable"]) {
      const res = await inject({
        method: "POST",
        url: `/v1/integrations/whatsapp/${action}`,
        token: tokenA,
        payload: { environment: "SANDBOX", secret: { apiKey: "x" } },
      });
      expect(res.statusCode).toBe(501);
      const body = res.json<{ code: string; message: string }>();
      expect(body.code).toBe("CAPABILITY_UNCERTIFIED");
      expect(body.message).toContain("S3");
    }
    expect(await liveBindingCount(tenantA, "whatsapp")).toBe(0);
    expect(vault.store.size).toBe(0);
  });

  it("asaas configure creates a DRAFT binding and never leaks the secret", async () => {
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: tokenA,
      payload: { environment: "SANDBOX", secret: { apiKey: ASAAS_KEY_A } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual([...SANITIZED_KEYS].sort());
    expect(body["provider"]).toBe("asaas");
    expect(body["environment"]).toBe("SANDBOX");
    expect(body["connection_status"]).toBe("DRAFT");
    expect(body["version"]).toBe(1);
    expect(body["last_checked_at"]).toBeNull();
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain(ASAAS_KEY_A);
    expect(raw).not.toMatch(/secret_ref|infisical|apiKey/i);
    // Vault holds the value under the backend-owned ref; the row holds the ref.
    const row = await db
      .selectFrom("provider.provider_accounts")
      .select(["secret_ref", "connection_status", "version"])
      .where("tenant_id", "=", tenantA)
      .executeTakeFirstOrThrow();
    expect(row.secret_ref).toMatch(/^infisical:\/\//);
    expect(vault.store.get(row.secret_ref)).toBe(ASAAS_KEY_A);
  });

  it("configure validates strictly (missing secret, client URL, bad env)", async () => {
    const missing = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: tokenA,
      payload: { environment: "SANDBOX", secret: {} },
    });
    expect(missing.statusCode).toBe(400);

    const clientUrl = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: tokenA,
      payload: { environment: "SANDBOX", secret: { apiKey: ASAAS_KEY_A, baseUrl: "https://evil.example/v3" } },
    });
    expect(clientUrl.statusCode).toBe(400);

    const badEnv = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: tokenA,
      payload: { environment: "HOMOLOG", secret: { apiKey: ASAAS_KEY_A } },
    });
    expect(badEnv.statusCode).toBe(400);
  });

  it("configure enforces expectedVersion and rotates with the current one", async () => {
    const noVersion = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: tokenA,
      payload: { environment: "SANDBOX", secret: { apiKey: ASAAS_KEY_B } },
    });
    expect(noVersion.statusCode).toBe(409);

    const stale = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: tokenA,
      payload: { environment: "SANDBOX", expectedVersion: 999, secret: { apiKey: ASAAS_KEY_B } },
    });
    expect(stale.statusCode).toBe(409);

    // Rotation = configure with a new secret + the current version.
    const rotated = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: tokenA,
      payload: { environment: "SANDBOX", expectedVersion: 1, secret: { apiKey: ASAAS_KEY_B } },
    });
    expect(rotated.statusCode).toBe(201);
    expect(rotated.json<Record<string, unknown>>()["version"]).toBe(2);
    expect(JSON.stringify(rotated.json())).not.toContain(ASAAS_KEY_B);
    const row = await db
      .selectFrom("provider.provider_accounts")
      .select(["secret_ref", "version"])
      .where("tenant_id", "=", tenantA)
      .executeTakeFirstOrThrow();
    expect(Number(row.version)).toBe(2);
    expect(vault.store.get(row.secret_ref)).toBe(ASAAS_KEY_B);
  });

  it("vault failure fails closed with 503 and leaves the row untouched", async () => {
    const before = await db
      .selectFrom("provider.provider_accounts")
      .select(["secret_ref", "version", "connection_status"])
      .where("tenant_id", "=", tenantA)
      .executeTakeFirstOrThrow();
    const vaultSize = vault.store.size;
    vault.failPut = true;
    try {
      const res = await inject({
        method: "POST",
        url: "/v1/integrations/asaas/configure",
        token: tokenA,
        payload: { environment: "SANDBOX", expectedVersion: 2, secret: { apiKey: "s1c2-synthetic-zzz999" } },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json<{ code: string }>().code).toBe("VAULT_UNAVAILABLE");
    } finally {
      vault.failPut = false;
    }
    const after = await db
      .selectFrom("provider.provider_accounts")
      .select(["secret_ref", "version", "connection_status"])
      .where("tenant_id", "=", tenantA)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
    expect(vault.store.size).toBe(vaultSize);
  });

  it("idempotent configure replays on the same key and conflicts on reuse", async () => {
    const key = `s1c2-key-${newId()}`;
    const first = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: tokenA,
      idempotencyKey: key,
      payload: { environment: "SANDBOX", expectedVersion: 2, secret: { apiKey: ASAAS_KEY_B } },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json<Record<string, unknown>>()["version"]).toBe(3);

    const replay = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: tokenA,
      idempotencyKey: key,
      payload: { environment: "SANDBOX", expectedVersion: 2, secret: { apiKey: ASAAS_KEY_B } },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());

    const conflict = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: tokenA,
      idempotencyKey: key,
      payload: { environment: "SANDBOX", expectedVersion: 3, secret: { apiKey: ASAAS_KEY_B } },
    });
    expect(conflict.statusCode).toBe(400);
  });

  it("asaas test success marks CONNECTED_READ_ONLY against the fixed allowlist", async () => {
    probeMode = "ok";
    seenProbe.length = 0;
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/test",
      token: tokenA,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual([...SANITIZED_KEYS].sort());
    expect(body["connection_status"]).toBe("CONNECTED_READ_ONLY");
    expect(body["last_error_code"]).toBeNull();
    expect(typeof body["last_checked_at"]).toBe("string");
    expect(JSON.stringify(res.json())).not.toContain(ASAAS_KEY_B);
    // Fixed host allowlist, never client data; token resolved server-side.
    expect(seenProbe.length).toBeGreaterThan(0);
    expect(seenProbe[0]?.url.startsWith("https://api-sandbox.asaas.com/v3/")).toBe(true);
    expect(seenProbe[0]?.url).not.toContain("evil.example");
    expect(seenProbe[0]?.hasAuthToken).toBe(true);
  });

  it("asaas test maps failures to sanitized codes without leaking bodies", async () => {
    probeMode = "unauthorized";
    const denied = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/test",
      token: tokenA,
      payload: {},
    });
    expect(denied.statusCode).toBe(201);
    expect(denied.json<Record<string, unknown>>()["connection_status"]).toBe("TESTING");
    expect(denied.json<Record<string, unknown>>()["last_error_code"]).toBe("INVALID_CREDENTIALS");

    probeMode = "timeout";
    const timedOut = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/test",
      token: tokenA,
      payload: {},
    });
    expect(timedOut.json<Record<string, unknown>>()["last_error_code"]).toBe("TIMEOUT");

    probeMode = "error";
    const broken = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/test",
      token: tokenA,
      payload: {},
    });
    expect(broken.json<Record<string, unknown>>()["last_error_code"]).toBe("PROVIDER_UNAVAILABLE");
    expect(JSON.stringify(broken.json())).not.toContain(ASAAS_KEY_B);
    probeMode = "ok";
  });

  it("test without a binding is 404 and tenant-scoped", async () => {
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/test",
      token: tokenB,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe("NOT_FOUND");
  });

  it("cinevision configures vault-backed and tests without CONNECTED_READ_ONLY", async () => {
    const configured = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/configure",
      token: tokenA,
      payload: { environment: "SANDBOX", secret: { username: CINE_USER, password: CINE_PASS } },
    });
    expect(configured.statusCode).toBe(201);
    expect(configured.json<Record<string, unknown>>()["connection_status"]).toBe("DRAFT");
    expect(JSON.stringify(configured.json())).not.toContain(CINE_PASS);

    const tested = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/test",
      token: tokenA,
      payload: {},
    });
    expect(tested.statusCode).toBe(201);
    const body = tested.json<Record<string, unknown>>();
    // S1 honesty: vault resolution only — live browser certification (S4)
    // alone grants CONNECTED_READ_ONLY.
    expect(body["connection_status"]).toBe("TESTING");
    expect(typeof body["last_checked_at"]).toBe("string");
    expect(JSON.stringify(tested.json())).not.toContain(CINE_PASS);
    expect(JSON.stringify(tested.json())).not.toContain(CINE_USER);
  });

  it("disable requires version, preserves history, and allows fresh configure", async () => {
    const noVersion = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/disable",
      token: tokenA,
      payload: {},
    });
    expect(noVersion.statusCode).toBe(409);

    const detail = await db
      .selectFrom("provider.provider_accounts")
      .leftJoin("provider.providers", "provider.providers.id", "provider.provider_accounts.provider_id")
      .select(["provider.provider_accounts.id", "provider.provider_accounts.version"])
      .where("provider.provider_accounts.tenant_id", "=", tenantA)
      .where("provider.providers.provider_key", "=", "cinevision")
      .where("provider.provider_accounts.connection_status", "<>", "DISABLED")
      .executeTakeFirstOrThrow();
    const wrong = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/disable",
      token: tokenA,
      payload: { expectedVersion: 999 },
    });
    expect(wrong.statusCode).toBe(409);

    const disabled = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/disable",
      token: tokenA,
      payload: { expectedVersion: Number(detail.version) },
    });
    expect(disabled.statusCode).toBe(201);
    expect(disabled.json<Record<string, unknown>>()["connection_status"]).toBe("DISABLED");

    // Line preserved as history; second disable finds no live binding.
    const history = await db
      .selectFrom("provider.provider_accounts")
      .select(["connection_status"])
      .where("id", "=", detail.id)
      .executeTakeFirstOrThrow();
    expect(history.connection_status).toBe("DISABLED");
    const again = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/disable",
      token: tokenA,
      payload: { expectedVersion: Number(detail.version) + 1 },
    });
    expect(again.statusCode).toBe(404);

    // Fresh configure after disable starts a new live row (partial unique).
    const fresh = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/configure",
      token: tokenA,
      payload: { environment: "SANDBOX", secret: { username: CINE_USER, password: CINE_PASS } },
    });
    expect(fresh.statusCode).toBe(201);
    expect(fresh.json<Record<string, unknown>>()["version"]).toBe(1);
  });

  it("tenants are isolated and operator writes are forbidden", async () => {
    // Tenant B configures its own Asaas binding independently.
    const bConfigure = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: tokenB,
      payload: { environment: "SANDBOX", secret: { apiKey: ASAAS_KEY_A } },
    });
    expect(bConfigure.statusCode).toBe(201);

    // Disable A's Asaas binding; B keeps its live row.
    const aRow = await db
      .selectFrom("provider.provider_accounts")
      .leftJoin("provider.providers", "provider.providers.id", "provider.provider_accounts.provider_id")
      .select(["provider.provider_accounts.id", "provider.provider_accounts.version"])
      .where("provider.provider_accounts.tenant_id", "=", tenantA)
      .where("provider.providers.provider_key", "=", "asaas")
      .where("provider.provider_accounts.connection_status", "<>", "DISABLED")
      .executeTakeFirstOrThrow();
    const aDisable = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/disable",
      token: tokenA,
      payload: { expectedVersion: Number(aRow.version) },
    });
    expect(aDisable.statusCode).toBe(201);
    expect(await liveBindingCount(tenantB, "asaas")).toBe(1);
    expect(await liveBindingCount(tenantA, "asaas")).toBe(0);

    // Operator (integration.read only) cannot write or probe.
    const revision = await sessionRevision(tokenOperator);
    const opWrite = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: tokenOperator,
      revision,
      payload: { environment: "SANDBOX", secret: { apiKey: ASAAS_KEY_A } },
    });
    expect(opWrite.statusCode).toBe(403);
    const opTest = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/test",
      token: tokenOperator,
      revision,
      payload: {},
    });
    expect(opTest.statusCode).toBe(403);
    expect(JSON.stringify(opWrite.json())).not.toContain(ASAAS_KEY_A);
  });

  it("audit covers the three actions with actor/provider/version and no values", async () => {
    const rows = await db
      .selectFrom("platform.audit_log")
      .select(["action_key", "resource_type", "actor_id", "metadata_json"])
      .where("tenant_id", "=", tenantA)
      .where("action_key", "in", ["integration.configure", "integration.test", "integration.disable"])
      .orderBy("occurred_at", "asc")
      .execute();
    const actions = rows.map((r) => r.action_key);
    expect(actions).toContain("integration.configure");
    expect(actions).toContain("integration.test");
    expect(actions).toContain("integration.disable");
    for (const row of rows) {
      expect(row.resource_type).toBe("provider_account");
      const meta = row.metadata_json as Record<string, unknown>;
      expect(meta["result"]).toBeDefined();
      const dumped = JSON.stringify(row);
      expect(dumped).not.toContain(ASAAS_KEY_A);
      expect(dumped).not.toContain(ASAAS_KEY_B);
      expect(dumped).not.toContain(CINE_PASS);
      expect(dumped).not.toContain(CINE_USER);
    }
  });
});
