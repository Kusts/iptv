import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createDb, applyMigrations } from "@iptv/database";
import { newId } from "@iptv/domain";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(0, 12)}@example.com`;
}

/** Distinctive marker: must NEVER appear in any API response body. */
const SECRET_MARKER = "s1c1-secret-marker-must-never-leak";

/** Exact sanitized key set shared by list entries and detail. */
const SANITIZED_KEYS = [
  "provider",
  "environment",
  "connection_status",
  "capability_status",
  "last_checked_at",
  "last_error_code",
  "configured",
];

describe.skipIf(!hasDb)("integrations read-only status (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });
  let app: NestFastifyApplication;

  let tokenA = "";
  let tenantA = "";
  let tokenB = "";
  let tenantB = "";
  let tokenOperator = "";
  let tokenSuspended = "";

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

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    // `platform.capabilities` é um catálogo global compartilhado entre suítes;
    // cada suíte fixa o próprio arrange: remove linhas residuais (UNKNOWN) e
    // restaura `provider.cinevision` ao canônico fail-closed da migration 044.
    await db
      .deleteFrom("platform.capabilities")
      .where("key", "in", ["provider.asaas", "provider.whatsapp"])
      .execute();
    await db
      .insertInto("platform.capabilities")
      .values({
        id: newId(),
        key: "provider.cinevision",
        owner_context: "provider",
        availability: "UNAVAILABLE",
        certification_status: "UNCERTIFIED",
        risk_level: "HIGH",
        mvp_phase: "W0",
        manual_equivalent:
          "Provider operator fulfills the operation manually (HITL) via provider.resolve_operation",
        policy_family: "provider-integration",
        degradation:
          "Forced MANUAL: every operation parks in HUMAN_REQUIRED until durable post-commit dispatch with certified readback",
        permissions: [],
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          availability: "UNAVAILABLE",
          certification_status: "UNCERTIFIED",
          updated_at: new Date(),
        }),
      )
      .execute();
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();

    const registerA = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("int-a"), password: "correct-horse-8", tenantName: "Integrations Tenant A" },
    });
    expect(registerA.statusCode).toBe(201);
    const bodyA = registerA.json<{ token: string; activeTenantId: string }>();
    tokenA = bodyA.token;
    tenantA = bodyA.activeTenantId;

    const registerB = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("int-b"), password: "correct-horse-8", tenantName: "Integrations Tenant B" },
    });
    expect(registerB.statusCode).toBe(201);
    const bodyB = registerB.json<{ token: string; activeTenantId: string }>();
    tokenB = bodyB.token;
    tenantB = bodyB.activeTenantId;
    expect(tenantB).not.toBe(tenantA);

    // Operator inside tenant A: register (own home tenant), grant ACTIVE
    // tenant_operator membership in A, switch to it.
    const registerOp = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("int-op"), password: "correct-horse-8", tenantName: "Integrations Operator Home" },
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

    // Suspended user inside tenant A: ACTIVE membership first (so the
    // switch succeeds), suspended afterwards to exercise the 403 path.
    const registerSu = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("int-su"), password: "correct-horse-8", tenantName: "Integrations Suspended Home" },
    });
    expect(registerSu.statusCode).toBe(201);
    const bodySu = registerSu.json<{ token: string; user: { id: string } }>();
    tokenSuspended = bodySu.token;
    const suspendedMembershipId = newId();
    await db
      .insertInto("control.tenant_memberships")
      .values({
        id: suspendedMembershipId,
        tenant_id: tenantA,
        user_id: bodySu.user.id,
        role_key: "tenant_operator",
        status: "ACTIVE",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const suSwitched = await inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/switch`,
      token: tokenSuspended,
      revision: await sessionRevision(tokenSuspended),
    });
    expect(suSwitched.statusCode).toBe(200);
    await db
      .updateTable("control.tenant_memberships")
      .set({ status: "SUSPENDED" })
      .where("id", "=", suspendedMembershipId)
      .execute();

    // Tenant A: one LIVE Asaas binding with a known secret marker. The API
    // must never return the marker (nor any secret_ref), only `configured`.
    const asaasProviderId = newId();
    await db
      .insertInto("provider.providers")
      .values({
        id: asaasProviderId,
        provider_key: "asaas",
        name: "Asaas",
        provider_type: "BILLING",
        status: "ACTIVE",
        created_at: new Date(),
      })
      .onConflict((oc) => oc.column("provider_key").doNothing())
      .execute();
    const asaasProvider = await db
      .selectFrom("provider.providers")
      .select(["id"])
      .where("provider_key", "=", "asaas")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("provider.provider_accounts")
      .values({
        id: newId(),
        tenant_id: tenantA,
        provider_id: asaasProvider.id,
        name: "Asaas Sandbox",
        status: "ACTIVE",
        secret_ref: `infisical://test/${SECRET_MARKER}`,
        settings_json: {},
        last_recharge_at: null,
        created_at: new Date(),
        updated_at: new Date(),
        environment: "SANDBOX",
        connection_status: "CONNECTED_READ_ONLY",
        last_checked_at: new Date("2026-10-29T12:00:00.000Z"),
        last_error_code: null,
        version: 1,
      })
      .execute();
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await (db as unknown as { destroy: () => Promise<void> }).destroy?.().catch(() => undefined);
  });

  it("lista os 3 provedores com shape sanitizado exato", async () => {
    const res = await inject({ method: "GET", url: "/v1/integrations", token: tokenA });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ integrations: Array<Record<string, unknown>> }>();
    expect(body.integrations.map((i) => i["provider"])).toEqual(["asaas", "whatsapp", "cinevision"]);
    for (const entry of body.integrations) {
      expect(Object.keys(entry).sort()).toEqual([...SANITIZED_KEYS].sort());
    }
    const asaas = body.integrations[0] as Record<string, unknown>;
    expect(asaas["configured"]).toBe(true);
    expect(asaas["environment"]).toBe("SANDBOX");
    expect(asaas["connection_status"]).toBe("CONNECTED_READ_ONLY");
    expect(asaas["last_checked_at"]).toBe("2026-10-29T12:00:00.000Z");
    expect(asaas["last_error_code"]).toBeNull();
    // S3/S4 plugam depois: sem binding, nunca alegar conectado.
    for (const entry of body.integrations.slice(1)) {
      expect(entry["configured"]).toBe(false);
      expect(entry["connection_status"]).toBe("NOT_CONFIGURED");
      expect(entry["last_checked_at"]).toBeNull();
      expect(entry["last_error_code"]).toBeNull();
    }
    // capability_status deriva do registry real: cinevision tem linha
    // UNAVAILABLE (044/046); whatsapp/asaas não têm linha → UNKNOWN.
    const byProvider = Object.fromEntries(body.integrations.map((i) => [i["provider"], i]));
    expect(byProvider["cinevision"]?.["capability_status"]).toBe("UNAVAILABLE");
    expect(byProvider["whatsapp"]?.["capability_status"]).toBe("UNKNOWN");
    expect(byProvider["asaas"]?.["capability_status"]).toBe("UNKNOWN");
  });

  it("tenant B não enxerga o binding do tenant A", async () => {
    const res = await inject({ method: "GET", url: "/v1/integrations", token: tokenB });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ integrations: Array<Record<string, unknown>> }>();
    expect(body.integrations).toHaveLength(3);
    for (const entry of body.integrations) {
      expect(entry["configured"]).toBe(false);
      expect(entry["connection_status"]).toBe("NOT_CONFIGURED");
    }
  });

  it("detalhe por provider espelha a lista; desconhecido é 404 NOT_FOUND", async () => {
    const res = await inject({ method: "GET", url: "/v1/integrations/asaas", token: tokenA });
    expect(res.statusCode).toBe(200);
    const detail = res.json<Record<string, unknown>>();
    expect(Object.keys(detail).sort()).toEqual([...SANITIZED_KEYS].sort());
    expect(detail["provider"]).toBe("asaas");
    expect(detail["configured"]).toBe(true);

    const missing = await inject({ method: "GET", url: "/v1/integrations/whatsapp", token: tokenA });
    expect(missing.statusCode).toBe(200);
    expect(missing.json<Record<string, unknown>>()["configured"]).toBe(false);

    const unknown = await inject({ method: "GET", url: "/v1/integrations/nope", token: tokenA });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ code: string }>().code).toBe("NOT_FOUND");
  });

  it("nunca expõe secret_ref nem material de segredo", async () => {
    const list = await inject({ method: "GET", url: "/v1/integrations", token: tokenA });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(SECRET_MARKER);
    expect(JSON.stringify(list.json())).not.toMatch(/secret_ref|infisical/i);

    const detail = await inject({ method: "GET", url: "/v1/integrations/asaas", token: tokenA });
    expect(detail.statusCode).toBe(200);
    expect(JSON.stringify(detail.json())).not.toContain(SECRET_MARKER);

    // Anti-vacuidade: o binding TEM secret persistido — a sanitização é no SELECT.
    const raw = await db
      .selectFrom("provider.provider_accounts")
      .select(["secret_ref"])
      .where("tenant_id", "=", tenantA)
      .executeTakeFirstOrThrow();
    expect(raw.secret_ref).toContain(SECRET_MARKER);
  });

  it("operator lê (200) na lista e no detalhe", async () => {
    const revision = await sessionRevision(tokenOperator);
    const list = await inject({ method: "GET", url: "/v1/integrations", token: tokenOperator, revision });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ integrations: unknown[] }>().integrations).toHaveLength(3);
    const detail = await inject({
      method: "GET",
      url: "/v1/integrations/asaas",
      token: tokenOperator,
      revision,
    });
    expect(detail.statusCode).toBe(200);
  });

  it("membership suspenso recebe 403 sem vazar dados", async () => {
    const revision = await sessionRevision(tokenSuspended);
    const res = await inject({ method: "GET", url: "/v1/integrations", token: tokenSuspended, revision });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).not.toContain(SECRET_MARKER);
  });

  it("sem token recebe 401", async () => {
    const res = await inject({ method: "GET", url: "/v1/integrations" });
    expect(res.statusCode).toBe(401);
  });
});
