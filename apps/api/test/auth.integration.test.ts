import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createDb, applyMigrations } from "@iptv/database";
import { newId } from "@iptv/domain";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";

const here = dirname(fileURLToPath(import.meta.url));
// apps/api/test -> repo root is three levels up; canonical migrations live at <repo>/db/migrations.
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(0, 12)}@example.com`;
}

describe.skipIf(!hasDb)("auth + RBAC + audit chain (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  const userA = { email: email("w1-owner"), password: "correct-horse-8" };
  let tokenA = "";
  let tenantA = "";
  let tenantB = "";

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  function inject(opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    payload?: Record<string, unknown>;
    requestId?: string;
  }) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
    }
    if (opts.requestId !== undefined) {
      headers["x-request-id"] = opts.requestId;
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

  it("register → login → session → tenants → switch → me", async () => {
    const register = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: userA.email, password: userA.password, tenantName: "Acme Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const registered = register.json<{ token: string; activeTenantId: string }>();
    expect(typeof registered.token).toBe("string");
    tokenA = registered.token;
    tenantA = registered.activeTenantId;

    const login = await inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: userA.email, password: userA.password },
    });
    expect(login.statusCode).toBe(200);
    expect(typeof login.json<{ token: string }>().token).toBe("string");

    const session = await inject({ method: "GET", url: "/v1/auth/session", token: tokenA });
    expect(session.statusCode).toBe(200);
    const sessionBody = session.json<{ activeTenantId: string; memberships: unknown[] }>();
    expect(sessionBody.activeTenantId).toBe(tenantA);
    expect(sessionBody.memberships).toHaveLength(1);

    const created = await inject({
      method: "POST",
      url: "/v1/tenants",
      token: tokenA,
      payload: { name: "Second Tenant" },
    });
    expect(created.statusCode).toBe(201);
    tenantB = created.json<{ tenant: { id: string } }>().tenant.id;
    expect(tenantB).not.toBe(tenantA);

    const tenants = await inject({ method: "GET", url: "/v1/tenants", token: tokenA });
    expect(tenants.statusCode).toBe(200);
    expect(tenants.json<{ memberships: unknown[] }>().memberships).toHaveLength(2);

    const correlationId = newId();
    const switched = await inject({
      method: "POST",
      url: `/v1/tenants/${tenantB}/switch`,
      token: tokenA,
      requestId: correlationId,
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json<{ activeTenantId: string }>().activeTenantId).toBe(tenantB);
    expect(switched.headers["x-request-id"]).toBe(correlationId);

    const me = await inject({ method: "GET", url: "/v1/me", token: tokenA });
    expect(me.statusCode).toBe(200);
    const meBody = me.json<{ activeTenant: { id: string }; roleKeys: string[]; permissions: string[] }>();
    expect(meBody.activeTenant.id).toBe(tenantB);
    expect(meBody.roleKeys).toContain("tenant_owner");
    expect(meBody.permissions).toContain("settings.manage");

    const auditRows = await db
      .selectFrom("platform.audit_log")
      .select(["id", "action_key", "correlation_id"])
      .where("correlation_id", "=", correlationId)
      .execute();
    expect(auditRows.some((r) => r.action_key === "tenant.switch")).toBe(true);
  });

  it("denies settings.manage for operators (403) and isolates tenants", async () => {
    const settingsOk = await inject({ method: "GET", url: "/v1/settings", token: tokenA });
    expect(settingsOk.statusCode).toBe(200);

    await db
      .updateTable("control.tenant_memberships")
      .set({ role_key: "tenant_operator" })
      .where("tenant_id", "=", tenantB)
      .execute();

    const denied = await inject({ method: "GET", url: "/v1/settings", token: tokenA });
    expect(denied.statusCode).toBe(403);

    const me = await inject({ method: "GET", url: "/v1/me", token: tokenA });
    expect(me.json<{ permissions: string[] }>().permissions).not.toContain("settings.manage");

    const userB = { email: email("w1-stranger"), password: "correct-horse-8" };
    const registerB = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: userB.email, password: userB.password, tenantName: "Other Tenant" },
    });
    expect(registerB.statusCode).toBe(201);
    const tokenB = registerB.json<{ token: string }>().token;

    const crossSwitch = await inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/switch`,
      token: tokenB,
    });
    expect([403, 404]).toContain(crossSwitch.statusCode);

    const meB = await inject({ method: "GET", url: "/v1/me", token: tokenB });
    expect(meB.statusCode).toBe(200);
    expect(meB.json<{ activeTenant: { id: string } }>().activeTenant.id).not.toBe(tenantA);
  });

  it("logout invalidates the session", async () => {
    const logout = await inject({ method: "POST", url: "/v1/auth/logout", token: tokenA });
    expect(logout.statusCode).toBe(200);
    const session = await inject({ method: "GET", url: "/v1/auth/session", token: tokenA });
    expect(session.statusCode).toBe(401);
  });

  it("health stays public", async () => {
    const res = await inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
  });
});
