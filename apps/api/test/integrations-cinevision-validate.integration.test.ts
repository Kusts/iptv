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
import type {
  CinevisionProbeOutcome,
  CinevisionWorkerRunner,
} from "../src/integrations/cinevision-worker-probe.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";

/**
 * S4A-CINE-VALIDATE (Issue #88, etapas 1-2): `integration.test` (cinevision)
 * executa leitura real via worker spawnado por tenant (aqui: runner mockado
 * com outcomes roteirizados — zero rede/CINEVISION real, zero segredo real).
 *
 * Cobre: vault-OK + auth-fail do worker → TESTING + INVALID_CREDENTIALS
 * (S1c2 marcava TESTING com code null — não validava login); sucesso →
 * CONNECTED_READ_ONLY; challenge/timeout → TESTING + código distinto;
 * sem binding → 404; tenant B isolado; operator 403; vault down → 503;
 * concorrência A+B com perfis distintos.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(0, 12)}@example.com`;
}

// Fixtures sintéticas (nunca credenciais reais, nunca `sk-`).
// NUNCA podem aparecer em resposta, auditoria, log ou registro do runner.
const CINE_USER = "s4a-synthetic-cine-user-001";
const CINE_PASS = "s4a-synthetic-cine-pass-001";

/** Chaves sanitizadas exatas da resposta do test (sem segredo). */
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
  failMode: "none" | "transport" = "none";

  async getSecret(ref: string): Promise<string> {
    if (this.failMode === "transport") {
      throw new SecretsError("TRANSPORT", "fake vault: transport down");
    }
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

/**
 * Runner mockado: outcomes roteirizados por teste; registra por chamada
 * SOMENTE presença de credencial + profileRoot (nunca valores) para provar
 * isolamento sem vazar segredo no registro.
 */
class FakeProbe implements CinevisionWorkerRunner {
  mode: CinevisionProbeOutcome = { ok: true };
  readonly calls: Array<{ hasUsername: boolean; hasPassword: boolean; profileRoot: string }> = [];
  // Profile roots distintos por (tenant,account) sem tocar em segredo:
  // deriva do ids recebidos via hash local (espelha a regra do módulo).
  async runProbe(input: {
    tenantId: string;
    providerAccountId: string;
    username: string;
    password: string;
  }): Promise<CinevisionProbeOutcome> {
    const { createHash } = await import("node:crypto");
    const digest = (v: string): string =>
      createHash("sha256").update(v, "utf8").digest("hex").slice(0, 32);
    this.calls.push({
      hasUsername: input.username.length > 0,
      hasPassword: input.password.length > 0,
      profileRoot: `t-${digest(input.tenantId)}/p-${digest(`${input.tenantId}\0${input.providerAccountId}`)}`,
    });
    return this.mode;
  }
}

describe.skipIf(!hasDb)("cinevision live validate (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });
  const vault = new FakeVault();
  const probe = new FakeProbe();
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
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
    }
    if (opts.token !== undefined && opts.revision !== null) {
      headers["x-tenant-context-revision"] = opts.revision ?? "0";
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

  async function configureCinevision(token: string): Promise<void> {
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/configure",
      token,
      payload: { environment: "SANDBOX", secret: { username: CINE_USER, password: CINE_PASS } },
    });
    expect(res.statusCode).toBe(201);
  }

  async function testCinevision(token: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/test",
      token,
      payload: {},
    });
    return { status: res.statusCode, body: res.json<Record<string, unknown>>() };
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "cinevision-test-secret-0123456789";
    __setIntegrationTestDoubles({ secretsWriter: vault, cinevisionProbe: probe });
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();

    const registerA = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("cv-a"), password: "correct-horse-8", tenantName: "Cinevision Tenant A" },
    });
    expect(registerA.statusCode).toBe(201);
    const bodyA = registerA.json<{ token: string; activeTenantId: string }>();
    tokenA = bodyA.token;
    tenantA = bodyA.activeTenantId;

    const registerB = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("cv-b"), password: "correct-horse-8", tenantName: "Cinevision Tenant B" },
    });
    expect(registerB.statusCode).toBe(201);
    const bodyB = registerB.json<{ token: string; activeTenantId: string }>();
    tokenB = bodyB.token;
    tenantB = bodyB.activeTenantId;
    expect(tenantB).not.toBe(tenantA);

    const registerOp = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("cv-op"), password: "correct-horse-8", tenantName: "Cinevision Operator Home" },
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

  it("sucesso (identity+servers) marca CONNECTED_READ_ONLY sanitizado", async () => {
    probe.mode = { ok: true };
    probe.calls.length = 0;
    await configureCinevision(tokenA);
    const { status, body } = await testCinevision(tokenA);
    expect(status).toBe(201);
    expect(Object.keys(body).sort()).toEqual([...SANITIZED_KEYS].sort());
    expect(body["provider"]).toBe("cinevision");
    expect(body["connection_status"]).toBe("CONNECTED_READ_ONLY");
    expect(body["last_error_code"]).toBeNull();
    expect(typeof body["last_checked_at"]).toBe("string");
    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain(CINE_PASS);
    expect(dumped).not.toContain(CINE_USER);
    expect(dumped).not.toMatch(/secret_ref|infisical/i);
    // O worker foi invocado com credencial presente (só presença registrada).
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.hasUsername).toBe(true);
    expect(probe.calls[0]?.hasPassword).toBe(true);
  });

  it("vault OK mas login inválido no worker distingue INVALID_CREDENTIALS", async () => {
    probe.mode = { ok: false, code: "INVALID_CREDENTIALS" };
    const { status, body } = await testCinevision(tokenA);
    expect(status).toBe(201);
    // S1c2 marcava TESTING com code null — não validava login.
    expect(body["connection_status"]).toBe("TESTING");
    expect(body["last_error_code"]).toBe("INVALID_CREDENTIALS");
    expect(typeof body["last_checked_at"]).toBe("string");
    expect(JSON.stringify(body)).not.toContain(CINE_PASS);
  });

  it("challenge/CAPTCHA vira TESTING + CHALLENGE_DETECTED (sem bypass)", async () => {
    probe.mode = { ok: false, code: "CHALLENGE_DETECTED" };
    const { status, body } = await testCinevision(tokenA);
    expect(status).toBe(201);
    expect(body["connection_status"]).toBe("TESTING");
    expect(body["last_error_code"]).toBe("CHALLENGE_DETECTED");
  });

  it("timeout do worker vira TESTING + TIMEOUT (nunca 500 vazio)", async () => {
    probe.mode = { ok: false, code: "TIMEOUT" };
    const { status, body } = await testCinevision(tokenA);
    expect(status).toBe(201);
    expect(body["connection_status"]).toBe("TESTING");
    expect(body["last_error_code"]).toBe("TIMEOUT");
  });

  it("test sem binding é 404 e tenant B é isolado", async () => {
    const missing = await testCinevision(tokenB);
    expect(missing.status).toBe(404);
    expect(missing.body["code"]).toBe("NOT_FOUND");

    // Tenant B configura e testa com sucesso sem tocar no tenant A.
    probe.mode = { ok: true };
    await configureCinevision(tokenB);
    const testedB = await testCinevision(tokenB);
    expect(testedB.status).toBe(201);
    expect(testedB.body["connection_status"]).toBe("CONNECTED_READ_ONLY");

    const rowA = await db
      .selectFrom("provider.provider_accounts")
      .leftJoin("provider.providers", "provider.providers.id", "provider.provider_accounts.provider_id")
      .select(["provider.provider_accounts.connection_status"])
      .where("provider.provider_accounts.tenant_id", "=", tenantA)
      .where("provider.providers.provider_key", "=", "cinevision")
      .where("provider.provider_accounts.connection_status", "<>", "DISABLED")
      .executeTakeFirstOrThrow();
    // Último teste do A marcou TIMEOUT (teste anterior) — B não o alterou.
    expect(rowA.connection_status).toBe("TESTING");
  });

  it("concorrência: A+B simultâneos usam perfis distintos", async () => {
    probe.mode = { ok: true };
    probe.calls.length = 0;
    const [resA, resB] = await Promise.all([testCinevision(tokenA), testCinevision(tokenB)]);
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(resA.body["connection_status"]).toBe("CONNECTED_READ_ONLY");
    expect(resB.body["connection_status"]).toBe("CONNECTED_READ_ONLY");
    expect(probe.calls).toHaveLength(2);
    expect(probe.calls[0]?.profileRoot).not.toBe(probe.calls[1]?.profileRoot);
  });

  it("operator (sem integration.test) recebe 403", async () => {
    const revision = await sessionRevision(tokenOperator);
    const res = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/v1/integrations/cinevision/test",
      headers: {
        authorization: `Bearer ${tokenOperator}`,
        "x-tenant-context-revision": revision,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).not.toContain(CINE_PASS);
  });

  it("vault down falha fechado com 503 e linha intocada", async () => {
    const before = await db
      .selectFrom("provider.provider_accounts")
      .leftJoin("provider.providers", "provider.providers.id", "provider.provider_accounts.provider_id")
      .select([
        "provider.provider_accounts.connection_status",
        "provider.provider_accounts.last_error_code",
        "provider.provider_accounts.version",
      ])
      .where("provider.provider_accounts.tenant_id", "=", tenantA)
      .where("provider.providers.provider_key", "=", "cinevision")
      .where("provider.provider_accounts.connection_status", "<>", "DISABLED")
      .executeTakeFirstOrThrow();
    vault.failMode = "transport";
    try {
      const res = await inject({
        method: "POST",
        url: "/v1/integrations/cinevision/test",
        token: tokenA,
        payload: {},
      });
      expect(res.statusCode).toBe(503);
      expect(res.json<{ code: string }>().code).toBe("VAULT_UNAVAILABLE");
    } finally {
      vault.failMode = "none";
    }
    const after = await db
      .selectFrom("provider.provider_accounts")
      .leftJoin("provider.providers", "provider.providers.id", "provider.provider_accounts.provider_id")
      .select([
        "provider.provider_accounts.connection_status",
        "provider.provider_accounts.last_error_code",
        "provider.provider_accounts.version",
      ])
      .where("provider.provider_accounts.tenant_id", "=", tenantA)
      .where("provider.providers.provider_key", "=", "cinevision")
      .where("provider.provider_accounts.connection_status", "<>", "DISABLED")
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
  });
});
