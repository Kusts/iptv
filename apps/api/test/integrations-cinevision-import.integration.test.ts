import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createDb, applyMigrations } from "@iptv/database";
import { newId } from "@iptv/domain";
import { SecretsError, buildIntegrationSecretRef, type SecretsWriterPort } from "@iptv/secrets";
import { AppModule } from "../src/app.module.js";
import { __resetIntegrationTestDoubles, __setIntegrationTestDoubles } from "../src/integrations/integrations.commands.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(0, 12)}@example.com`;
}

// Synthetic CINEVISION credentials (never real, never asserted in responses).
const CINE_USER = "s4c-synthetic-cine-user-001";
const CINE_PASS = "s4c-synthetic-cine-pass-001";

interface FakeCustomer {
  id: string;
  userId: string | null;
  serverId: string | null;
  packageId: string | null;
  status: string;
  isTrial: boolean;
  connections: number | null;
  hasMultipleConnections: boolean | null;
  expiresAt: string | null;
  planPrice: number | null;
}

function customer(id: string): FakeCustomer {
  return {
    id,
    userId: `user-${id}`,
    serverId: "server-1",
    packageId: "package-1",
    status: "active",
    isTrial: false,
    connections: 1,
    hasMultipleConnections: false,
    expiresAt: null,
    planPrice: 29.9,
  };
}

type WorkerMode = "ok" | "challenge" | "timeout" | "down";

class FakeCinevisionWorker {
  items: FakeCustomer[] = [];
  mode: WorkerMode = "ok";

  async listCustomers(args: { page?: number; perPage?: number }): Promise<{
    items: FakeCustomer[];
    total: number;
    lastPage: number;
  }> {
    if (this.mode === "challenge") {
      throw Object.assign(new Error("fake challenge"), { code: "CHALLENGE_DETECTED" });
    }
    if (this.mode === "timeout") {
      throw Object.assign(new Error("fake timeout"), { code: "TIMEOUT" });
    }
    if (this.mode === "down") {
      throw Object.assign(new Error("fake down"), { code: "WORKER_DOWN" });
    }
    const perPage = args.perPage ?? 50;
    const page = args.page ?? 1;
    const start = (page - 1) * perPage;
    return {
      items: this.items.slice(start, start + perPage),
      total: this.items.length,
      lastPage: Math.max(1, Math.ceil(this.items.length / perPage)),
    };
  }
}

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

describe.skipIf(!hasDb)("integrations cinevision import-preview/execute (S4C, requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });
  const vault = new FakeVault();
  const worker = new FakeCinevisionWorker();
  let app: NestFastifyApplication;

  let tokenA = "";
  let tenantA = "";
  let tokenB = "";
  let tenantB = "";

  function inject(opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    idempotencyKey?: string;
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
      headers["x-tenant-context-revision"] = "0";
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

  async function tenantCounts(tenantId: string): Promise<{ persons: number; identities: number; customers: number }> {
    const persons = await db
      .selectFrom("identity.persons")
      .select(db.fn.countAll().as("n"))
      .where("tenant_id", "=", tenantId)
      .executeTakeFirstOrThrow();
    const identities = await db
      .selectFrom("identity.identities")
      .select(db.fn.countAll().as("n"))
      .where("tenant_id", "=", tenantId)
      .executeTakeFirstOrThrow();
    const customers = await db
      .selectFrom("crm.customers")
      .select(db.fn.countAll().as("n"))
      .where("tenant_id", "=", tenantId)
      .executeTakeFirstOrThrow();
    return {
      persons: Number(persons.n),
      identities: Number(identities.n),
      customers: Number(customers.n),
    };
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-import-test-secret-0123456789";
    __setIntegrationTestDoubles({
      secretsWriter: vault,
      cinevisionListCustomers: (args) => worker.listCustomers(args),
    });
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();

    const registerA = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("s4c-a"), password: "correct-horse-8", tenantName: "S4C Import Tenant A" },
    });
    expect(registerA.statusCode).toBe(201);
    const bodyA = registerA.json<{ token: string; activeTenantId: string }>();
    tokenA = bodyA.token;
    tenantA = bodyA.activeTenantId;

    const registerB = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("s4c-b"), password: "correct-horse-8", tenantName: "S4C Import Tenant B" },
    });
    expect(registerB.statusCode).toBe(201);
    const bodyB = registerB.json<{ token: string; activeTenantId: string }>();
    tokenB = bodyB.token;
    tenantB = bodyB.activeTenantId;
    expect(tenantB).not.toBe(tenantA);
  }, 120_000);

  afterAll(async () => {
    __resetIntegrationTestDoubles();
    await app?.close().catch(() => undefined);
    await (db as unknown as { destroy: () => Promise<void> }).destroy?.().catch(() => undefined);
  });

  it("import-preview without a live cinevision binding is 404", async () => {
    worker.items = [customer("cv-001"), customer("cv-002")];
    const res = await inject({ method: "POST", url: "/v1/integrations/cinevision/import-preview", token: tokenA, payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe("NOT_FOUND");
  });

  it("import-preview classifies novos and writes nothing", async () => {
    const configured = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/configure",
      token: tokenA,
      payload: { environment: "SANDBOX", secret: { username: CINE_USER, password: CINE_PASS } },
    });
    expect(configured.statusCode).toBe(201);

    worker.items = [customer("cv-001"), customer("cv-002"), customer("cv-003")];
    const res = await inject({ method: "POST", url: "/v1/integrations/cinevision/import-preview", token: tokenA, payload: {} });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      provider: string;
      total: number;
      novos: number;
      duplicados: number;
      conflitos: number;
      previewHash: string;
      items: Array<{ externalId: string; decision: string }>;
    }>();
    expect(body.provider).toBe("cinevision");
    expect(body.total).toBe(3);
    expect(body.novos).toBe(3);
    expect(body.duplicados).toBe(0);
    expect(body.conflitos).toBe(0);
    expect(body.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.items.map((i) => i.decision)).toEqual(["novo", "novo", "novo"]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(CINE_USER);
    expect(raw).not.toContain(CINE_PASS);
    expect(await tenantCounts(tenantA)).toEqual({ persons: 0, identities: 0, customers: 0 });
  });

  it("import-execute requires Idempotency-Key, confirmation and the exact preview hash", async () => {
    const preview = await inject({ method: "POST", url: "/v1/integrations/cinevision/import-preview", token: tokenA, payload: {} });
    const { previewHash } = preview.json<{ previewHash: string }>();

    const noKey = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/import-execute",
      token: tokenA,
      payload: { previewHash, confirmed: true },
    });
    expect(noKey.statusCode).toBe(400);

    const unconfirmed = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/import-execute",
      token: tokenA,
      idempotencyKey: `s4c-unconfirmed-${newId()}`,
      payload: { previewHash, confirmed: false },
    });
    expect(unconfirmed.statusCode).toBe(400);

    // Garante divergência em exatamente 1 char (mesmo length p/ timingSafeEqual).
    const first = previewHash[0] === "0" ? "1" : "0";
    const tamperedHash = `${first}${previewHash.slice(1)}`;
    const tampered = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/import-execute",
      token: tokenA,
      idempotencyKey: `s4c-tampered-${newId()}`,
      payload: { previewHash: tamperedHash, confirmed: true },
    });
    expect(tampered.statusCode).toBe(409);
    expect(tampered.json<{ code: string }>().code).toBe("PRECONDITION_FAILED");
    expect(await tenantCounts(tenantA)).toEqual({ persons: 0, identities: 0, customers: 0 });
  });

  it("import-execute creates persons/identities/customers idempotently with replay", async () => {
    const preview = await inject({ method: "POST", url: "/v1/integrations/cinevision/import-preview", token: tokenA, payload: {} });
    const { previewHash } = preview.json<{ previewHash: string }>();
    const key = `s4c-exec-${newId()}`;

    const first = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/import-execute",
      token: tokenA,
      idempotencyKey: key,
      payload: { previewHash, confirmed: true },
    });
    expect(first.statusCode).toBe(201);
    const summary = first.json<{ provider: string; total: number; criados: number; pulados: number; conflitos: number }>();
    expect(summary).toMatchObject({ provider: "cinevision", total: 3, criados: 3, pulados: 0, conflitos: 0 });
    expect(await tenantCounts(tenantA)).toEqual({ persons: 3, identities: 3, customers: 3 });

    const replay = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/import-execute",
      token: tokenA,
      idempotencyKey: key,
      payload: { previewHash, confirmed: true },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(await tenantCounts(tenantA)).toEqual({ persons: 3, identities: 3, customers: 3 });

    const again = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/import-execute",
      token: tokenA,
      idempotencyKey: `s4c-exec-${newId()}`,
      payload: { previewHash, confirmed: true },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ total: 3, criados: 0, pulados: 3, conflitos: 0 });
  });

  it("payload-internal duplicates surface as conflitos and import once", async () => {
    worker.items = [customer("cv-010"), customer("cv-010"), customer("cv-011")];
    const preview = await inject({ method: "POST", url: "/v1/integrations/cinevision/import-preview", token: tokenA, payload: {} });
    expect(preview.statusCode).toBe(201);
    const previewBody = preview.json<{ total: number; novos: number; duplicados: number; conflitos: number; previewHash: string }>();
    expect(previewBody).toMatchObject({ total: 3, novos: 2, duplicados: 0, conflitos: 1 });

    const executed = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/import-execute",
      token: tokenA,
      idempotencyKey: `s4c-dup-${newId()}`,
      payload: { previewHash: previewBody.previewHash, confirmed: true },
    });
    expect(executed.statusCode).toBe(201);
    expect(executed.json()).toMatchObject({ total: 3, criados: 2, pulados: 0, conflitos: 1 });
    expect(await tenantCounts(tenantA)).toEqual({ persons: 5, identities: 5, customers: 5 });
  });

  it("worker challenge/timeout/down fail with HUMAN_REQUIRED guidance and zero writes", async () => {
    worker.items = [customer("cv-900")];
    const before = await tenantCounts(tenantA);
    for (const mode of ["challenge", "timeout", "down"] as const) {
      worker.mode = mode;
      const preview = await inject({ method: "POST", url: "/v1/integrations/cinevision/import-preview", token: tokenA, payload: {} });
      expect(preview.statusCode).toBe(409);
      expect(preview.json<{ message: string }>().message).toContain("HUMAN_REQUIRED");
      const executed = await inject({
        method: "POST",
        url: "/v1/integrations/cinevision/import-execute",
        token: tokenA,
        idempotencyKey: `s4c-fail-${mode}-${newId()}`,
        payload: { previewHash: "a".repeat(64), confirmed: true },
      });
      expect(executed.statusCode).toBe(409);
      expect(executed.json<{ message: string }>().message).toContain("HUMAN_REQUIRED");
    }
    worker.mode = "ok";
    expect(await tenantCounts(tenantA)).toEqual(before);
  });

  it("tenants are isolated: B sees all novos and imports its own rows", async () => {
    const previewB = await inject({ method: "POST", url: "/v1/integrations/cinevision/import-preview", token: tokenB, payload: {} });
    expect(previewB.statusCode).toBe(404);

    const configuredB = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/configure",
      token: tokenB,
      payload: { environment: "SANDBOX", secret: { username: CINE_USER, password: CINE_PASS } },
    });
    expect(configuredB.statusCode).toBe(201);

    worker.items = [customer("cv-001"), customer("cv-002"), customer("cv-003")];
    const preview = await inject({ method: "POST", url: "/v1/integrations/cinevision/import-preview", token: tokenB, payload: {} });
    expect(preview.statusCode).toBe(201);
    expect(preview.json<{ novos: number; duplicados: number }>().novos).toBe(3);

    const hash = preview.json<{ previewHash: string }>().previewHash;
    const hashA = (
      await inject({ method: "POST", url: "/v1/integrations/cinevision/import-preview", token: tokenA, payload: {} })
    ).json<{ previewHash: string }>().previewHash;
    expect(hash).not.toBe(hashA);

    const executed = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/import-execute",
      token: tokenB,
      idempotencyKey: `s4c-tenantb-${newId()}`,
      payload: { previewHash: hash, confirmed: true },
    });
    expect(executed.statusCode).toBe(201);
    expect(executed.json()).toMatchObject({ criados: 3, pulados: 0 });
    expect(await tenantCounts(tenantB)).toEqual({ persons: 3, identities: 3, customers: 3 });
    // A is untouched by B's import (A has 5 from the earlier tests).
    expect(await tenantCounts(tenantA)).toEqual({ persons: 5, identities: 5, customers: 5 });
  });

  it("audit records counts without customer PII or secrets", async () => {
    const rows = await db
      .selectFrom("platform.audit_log")
      .select(["action_key", "resource_type", "metadata_json"])
      .where("tenant_id", "=", tenantA)
      .where("action_key", "in", ["integration.cinevision_import_preview", "integration.cinevision_import_execute"])
      .orderBy("occurred_at", "asc")
      .execute();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.resource_type).toBe("cinevision_import");
      const dumped = JSON.stringify(row);
      expect(dumped).not.toContain(CINE_USER);
      expect(dumped).not.toContain(CINE_PASS);
      expect(dumped).not.toContain("cv-001");
    }
    const executeRows = rows.filter((r) => r.action_key === "integration.cinevision_import_execute");
    expect(executeRows.length).toBeGreaterThan(0);
    // Linhas de execute BEM-SUCEDIDAS carregam as contagens (falhas 409 do
    // handler recebem só a metadata fixa do bus — sem PII em nenhum caso).
    const counted = executeRows.filter(
      (r) => typeof (r.metadata_json as Record<string, unknown>)["criados"] === "number",
    );
    expect(counted.length).toBeGreaterThan(0);
    for (const row of counted) {
      const meta = row.metadata_json as Record<string, unknown>;
      expect(typeof meta["criados"]).toBe("number");
      expect(typeof meta["pulados"]).toBe("number");
      expect(typeof meta["conflitos"]).toBe("number");
    }
  });
});
