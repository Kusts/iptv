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

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(0, 12)}@example.com`;
}

const PERMISSIONS = ["provider.operation.read", "provider.operation.write"];

/** Colunas que a superfície sanitizada expõe — nenhuma outra é selecionada. */
const SANITIZED_KEYS = [
  "id",
  "providerAccountId",
  "action",
  "entityType",
  "entityId",
  "status",
  "effectCertainty",
  "executionChannel",
  "adapterVersion",
  "requestedAt",
  "startedAt",
  "completedAt",
  "attempts",
];

const FORBIDDEN_KEYS = [
  "requestedPayload",
  "requestedPayloadJson",
  "payload",
  "resultSummary",
  "resultSummaryJson",
  "secretRef",
  "correlationId",
  "idempotencyKey",
  "providerEvidence",
  "traceRef",
  "tenantId",
  "requested_payload_json",
  "result_summary_json",
  "correlation_id",
];

describe.skipIf(!hasDb)("provider operations list (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });
  let app: NestFastifyApplication;
  let bus: CommandBus;

  let tokenA = "";
  let tokenB = "";
  let tenantA = "";
  let tenantB = "";
  let userA = "";

  /** `manual` sempre estaciona em HUMAN_REQUIRED (independente do gate). */
  async function requestManual(tenantId: string, key: string): Promise<string> {
    const result = await bus.execute<{ id: string }>(
      actorOf(tenantId),
      "provider.request_operation",
      {
        action: "custom.ping",
        entityType: "trial",
        entityId: newId(),
        idempotencyKey: `${key}-${newId().replace(/-/g, "").slice(0, 10)}`,
        adapter: "manual",
        payload: { note: "dado operacional sem segredo" },
      },
    );
    if (!result.ok) throw new Error(`provider.request_operation failed: ${result.code} ${result.message}`);
    return result.data.id;
  }

  function actorOf(tenantId: string): CommandActor {
    return {
      userId: userA,
      isPlatformAdmin: false,
      tenantId,
      roleKeys: ["tenant_owner"],
      permissions: PERMISSIONS,
      actorType: "human",
    };
  }

  function inject(opts: { url: string; token: string }) {
    return app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: opts.url,
      headers: {
        authorization: `Bearer ${opts.token}`,
        "x-tenant-context-revision": "0",
      },
    });
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    delete process.env["PROVIDER_OPS_ADAPTER"];
    delete process.env["PROVIDER_ECHO_OUTCOME"];
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);

    const registerA = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("plist-a"), password: "correct-horse-8", tenantName: "Provider List A" },
    });
    expect(registerA.statusCode).toBe(201);
    const bodyA = registerA.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    tokenA = bodyA.token;
    tenantA = bodyA.activeTenantId;
    userA = bodyA.user.id;

    const registerB = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("plist-b"), password: "correct-horse-8", tenantName: "Provider List B" },
    });
    expect(registerB.statusCode).toBe(201);
    const bodyB = registerB.json<{ token: string; activeTenantId: string }>();
    tokenB = bodyB.token;
    tenantB = bodyB.activeTenantId;
    expect(tenantB).not.toBe(tenantA);

    // Tenant A: three HUMAN_REQUIRED rows (deterministic under any capability
    // gate); tenant B: one row that must NEVER appear in A's list.
    await requestManual(tenantA, "a1");
    await requestManual(tenantA, "a2");
    await requestManual(tenantA, "a3");
    await requestManual(tenantB, "b1");
  });

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
  });

  it("lista apenas operações do próprio tenant, ordenadas por requested_at desc", async () => {
    const res = await inject({ url: "/v1/provider/operations", token: tokenA });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ operations: { id: string; requestedAt: string }[]; limit: number; offset: number }>();
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
    const tenantARows = await db
      .selectFrom("provider.provider_operations")
      .select("id")
      .where("tenant_id", "=", tenantA)
      .execute();
    const tenantBRows = await db
      .selectFrom("provider.provider_operations")
      .select("id")
      .where("tenant_id", "=", tenantB)
      .execute();
    expect(tenantBRows.length).toBeGreaterThanOrEqual(1);
    const ids = body.operations.map((o) => o.id);
    expect(new Set(ids)).toEqual(new Set(tenantARows.map((r) => r.id)));
    for (const other of tenantBRows) {
      expect(ids).not.toContain(other.id);
    }
    // requestedAt monotônico decrescente na ordem devolvida.
    const stamps = body.operations.map((o) => o.requestedAt);
    expect([...stamps].sort((a, b) => b.localeCompare(a))).toEqual(stamps);

    const asB = await inject({ url: "/v1/provider/operations", token: tokenB });
    expect(asB.statusCode).toBe(200);
    const bodyB = asB.json<{ operations: { id: string }[] }>();
    expect(bodyB.operations.map((o) => o.id)).toEqual(tenantBRows.map((r) => r.id));
  });

  it("nunca expõe payload, resumo, segredo, correlação nem evidência", async () => {
    const res = await inject({ url: "/v1/provider/operations", token: tokenA });
    const body = res.json<{ operations: Record<string, unknown>[] }>();
    expect(body.operations.length).toBeGreaterThan(0);
    for (const row of body.operations) {
      expect(Object.keys(row).sort()).toEqual([...SANITIZED_KEYS].sort());
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(row, forbidden)).toBe(false);
      }
    }
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/payload|secret|infisical|correlation|trace_ref|evidence/i);

    // Anti-vacuidade: as linhas realmente TÊM payload e resumo persistidos
    // no banco — a sanitização acontece no SELECT, não por ausência de dado.
    const raw = await db
      .selectFrom("provider.provider_operations")
      .select(["id", "requested_payload_json", "result_summary_json", "correlation_id"])
      .where("tenant_id", "=", tenantA)
      .execute();
    expect(raw.length).toBeGreaterThan(0);
    for (const r of raw) {
      expect(r.requested_payload_json).not.toBeNull();
    }
    const detail = await inject({ url: `/v1/provider/operations/${raw[0]!.id}`, token: tokenA });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json<Record<string, unknown>>();
    expect(Object.keys(detailBody).sort()).toEqual([...SANITIZED_KEYS].sort());
    expect(JSON.stringify(detailBody)).not.toMatch(/payload|secret|infisical|correlation|trace_ref|evidence/i);
  });

  it("respeita o filtro por status e os limites de paginação", async () => {
    const filtered = await inject({ url: "/v1/provider/operations?status=HUMAN_REQUIRED", token: tokenA });
    const filteredBody = filtered.json<{ operations: { status: string }[]; limit: number; offset: number }>();
    expect(filteredBody.limit).toBe(20);
    expect(filteredBody.operations.every((o) => o.status === "HUMAN_REQUIRED")).toBe(true);
    expect(filteredBody.operations.length).toBeGreaterThan(0);

    const other = await inject({ url: "/v1/provider/operations?status=SUCCEEDED", token: tokenA });
    const otherBody = other.json<{ operations: { status: string }[] }>();
    expect(otherBody.operations.every((o) => o.status === "SUCCEEDED")).toBe(true);

    const one = await inject({ url: "/v1/provider/operations?limit=1", token: tokenA });
    const oneBody = one.json<{ operations: unknown[]; limit: number }>();
    expect(oneBody.limit).toBe(1);
    expect(oneBody.operations).toHaveLength(1);

    // Teto de 50 e offset ecoado — nunca ampliam a fila.
    const clamped = await inject({ url: "/v1/provider/operations?limit=9999&offset=-5", token: tokenA });
    const clampedBody = clamped.json<{ limit: number; offset: number; operations: unknown[] }>();
    expect(clampedBody.limit).toBe(50);
    expect(clampedBody.offset).toBe(0);
    expect(clampedBody.operations.length).toBeLessThanOrEqual(50);

    const page2 = await inject({ url: "/v1/provider/operations?limit=1&offset=1", token: tokenA });
    const page2Body = page2.json<{ operations: { id: string }[]; offset: number }>();
    expect(page2Body.offset).toBe(1);
    const firstPage = await inject({ url: "/v1/provider/operations?limit=1", token: tokenA });
    expect(page2Body.operations[0]?.id).not.toBe(firstPage.json<{ operations: { id: string }[] }>().operations[0]?.id);
  });

  it("operação de outro tenant responde 404 no detalhe", async () => {
    const other = await db
      .selectFrom("provider.provider_operations")
      .select("id")
      .where("tenant_id", "=", tenantB)
      .executeTakeFirst();
    expect(other).toBeDefined();
    const res = await inject({ url: `/v1/provider/operations/${other!.id}`, token: tokenA });
    expect(res.statusCode).toBe(404);
  });
});