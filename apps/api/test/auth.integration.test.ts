import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createDb, applyMigrations } from "@iptv/database";
import { AuthError, type AuthInstance } from "@iptv/auth";
import { newId } from "@iptv/domain";
import { AppModule } from "../src/app.module.js";
import { buildCorsOptions, registerApiCors } from "../src/api-cors.js";
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
  let revA = "0";

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
    /**
     * Tenant-context precondition (`x-tenant-context-revision`). Defaults to
     * "0" when a token is present; pass `null` to omit the header (bootstrap
     * routes and missing-header cases).
     */
    revision?: string | null;
    payload?: Record<string, unknown>;
    requestId?: string;
  }) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
    }
    if (opts.token !== undefined && opts.revision !== null) {
      headers["x-tenant-context-revision"] = opts.revision ?? "0";
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
    const registered = register.json<{
      token: string;
      activeTenantId: string;
      tenantContextRevision: string;
    }>();
    expect(typeof registered.token).toBe("string");
    expect(registered.tenantContextRevision).toBe("0");
    tokenA = registered.token;
    tenantA = registered.activeTenantId;
    revA = registered.tenantContextRevision;

    const login = await inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: userA.email, password: userA.password },
    });
    expect(login.statusCode).toBe(200);
    expect(typeof login.json<{ token: string }>().token).toBe("string");
    expect(login.json<{ tenantContextRevision: string }>().tenantContextRevision).toBe("0");

    // Bootstrap is exempt from the context header and reports the
    // authoritative revision the client must echo back.
    const session = await inject({
      method: "GET",
      url: "/v1/auth/session",
      token: tokenA,
      revision: null,
    });
    expect(session.statusCode).toBe(200);
    const sessionBody = session.json<{
      activeTenantId: string;
      tenantContextRevision: string;
      memberships: unknown[];
    }>();
    expect(sessionBody.activeTenantId).toBe(tenantA);
    expect(sessionBody.tenantContextRevision).toBe("0");
    expect(sessionBody.memberships).toHaveLength(1);

    const created = await inject({
      method: "POST",
      url: "/v1/tenants",
      token: tokenA,
      revision: revA,
      payload: { name: "Second Tenant" },
    });
    expect(created.statusCode).toBe(201);
    tenantB = created.json<{ tenant: { id: string } }>().tenant.id;
    expect(tenantB).not.toBe(tenantA);

    const tenants = await inject({
      method: "GET",
      url: "/v1/tenants",
      token: tokenA,
      revision: revA,
    });
    expect(tenants.statusCode).toBe(200);
    expect(tenants.json<{ memberships: unknown[] }>().memberships).toHaveLength(2);

    const correlationId = newId();
    const switched = await inject({
      method: "POST",
      url: `/v1/tenants/${tenantB}/switch`,
      token: tokenA,
      revision: revA,
      requestId: correlationId,
    });
    expect(switched.statusCode).toBe(200);
    const switchedBody = switched.json<{ activeTenantId: string; tenantContextRevision: string }>();
    expect(switchedBody.activeTenantId).toBe(tenantB);
    expect(switchedBody.tenantContextRevision).toBe("1");
    revA = switchedBody.tenantContextRevision;
    expect(switched.headers["x-request-id"]).toBe(correlationId);

    // Serial stale retry from revision 0: 409 with no effect.
    const staleRetry = await inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/switch`,
      token: tokenA,
      revision: "0",
    });
    expect(staleRetry.statusCode).toBe(409);
    expect(staleRetry.json<{ code: string }>().code).toBe("TENANT_CONTEXT_CONFLICT");

    const me = await inject({ method: "GET", url: "/v1/me", token: tokenA, revision: revA });
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
    const settingsOk = await inject({ method: "GET", url: "/v1/settings", token: tokenA, revision: revA });
    expect(settingsOk.statusCode).toBe(200);

    await db
      .updateTable("control.tenant_memberships")
      .set({ role_key: "tenant_operator" })
      .where("tenant_id", "=", tenantB)
      .execute();

    const denied = await inject({ method: "GET", url: "/v1/settings", token: tokenA, revision: revA });
    expect(denied.statusCode).toBe(403);

    const me = await inject({ method: "GET", url: "/v1/me", token: tokenA, revision: revA });
    expect(me.json<{ permissions: string[] }>().permissions).not.toContain("settings.manage");

    const userB = { email: email("w1-stranger"), password: "correct-horse-8" };
    const registerB = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: userB.email, password: userB.password, tenantName: "Other Tenant" },
    });
    expect(registerB.statusCode).toBe(201);
    const bodyB = registerB.json<{ token: string; tenantContextRevision: string }>();
    const tokenB = bodyB.token;
    expect(bodyB.tenantContextRevision).toBe("0");

    const crossSwitch = await inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/switch`,
      token: tokenB,
      revision: "0",
    });
    expect([403, 404]).toContain(crossSwitch.statusCode);

    const meB = await inject({ method: "GET", url: "/v1/me", token: tokenB, revision: "0" });
    expect(meB.statusCode).toBe(200);
    expect(meB.json<{ activeTenant: { id: string } }>().activeTenant.id).not.toBe(tenantA);
  });

  it("missing/malformed/stale context headers fail closed with 409 and keep the session", async () => {
    // Missing header on a protected read.
    const missing = await inject({ method: "GET", url: "/v1/me", token: tokenA, revision: null });
    expect(missing.statusCode).toBe(409);
    expect(missing.json<{ code: string }>().code).toBe("TENANT_CONTEXT_CONFLICT");

    // Stale header on a protected read.
    const stale = await inject({ method: "GET", url: "/v1/me", token: tokenA, revision: "0" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ code: string }>().code).toBe("TENANT_CONTEXT_CONFLICT");

    // Malformed headers on a protected read.
    for (const bad of ["abc", "01", "-1", "1.5", "0x1", ""]) {
      const res = await inject({ method: "GET", url: "/v1/me", token: tokenA, revision: bad });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe("TENANT_CONTEXT_CONFLICT");
    }

    // Stale header on a protected write: 409 and no tenant is created.
    const before = await inject({
      method: "GET",
      url: "/v1/auth/session",
      token: tokenA,
      revision: null,
    });
    const membershipCount = before.json<{ memberships: unknown[] }>().memberships.length;
    const staleWrite = await inject({
      method: "POST",
      url: "/v1/tenants",
      token: tokenA,
      revision: "0",
      payload: { name: "Should Not Exist" },
    });
    expect(staleWrite.statusCode).toBe(409);
    expect(staleWrite.json<{ code: string }>().code).toBe("TENANT_CONTEXT_CONFLICT");
    const after = await inject({
      method: "GET",
      url: "/v1/auth/session",
      token: tokenA,
      revision: null,
    });
    expect(after.json<{ memberships: unknown[] }>().memberships).toHaveLength(membershipCount);

    // Current header is accepted, and the 409s above did not invalidate the token.
    const current = await inject({ method: "GET", url: "/v1/me", token: tokenA, revision: revA });
    expect(current.statusCode).toBe(200);
    const bootstrap = await inject({
      method: "GET",
      url: "/v1/auth/session",
      token: tokenA,
      revision: null,
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json<{ tenantContextRevision: string }>().tenantContextRevision).toBe(revA);
  });

  it("concurrent tenant switches race on the revision: exactly one wins", async () => {
    const auth = app.get<AuthInstance>("AUTH");
    const register = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: email("w1-cas"),
        password: "correct-horse-8",
        tenantName: "CAS Tenant One",
      },
    });
    expect(register.statusCode).toBe(201);
    const registered = register.json<{
      token: string;
      activeTenantId: string;
      tenantContextRevision: string;
    }>();
    const token = registered.token;
    const tenant1 = registered.activeTenantId;
    expect(registered.tenantContextRevision).toBe("0");

    const createdB = await inject({
      method: "POST",
      url: "/v1/tenants",
      token,
      revision: "0",
      payload: { name: "CAS Tenant Two" },
    });
    expect(createdB.statusCode).toBe(201);
    const tenant2 = createdB.json<{ tenant: { id: string } }>().tenant.id;

    const createdC = await inject({
      method: "POST",
      url: "/v1/tenants",
      token,
      revision: "0",
      payload: { name: "CAS Tenant Three" },
    });
    expect(createdC.statusCode).toBe(201);
    const tenant3 = createdC.json<{ tenant: { id: string } }>().tenant.id;
    expect(new Set([tenant1, tenant2, tenant3]).size).toBe(3);

    const before = await auth.resolveSession({ token });
    expect(before?.activeTenantId).toBe(tenant1);
    expect(before?.tenantContextRevision).toBe("0");

    const outcomes = await Promise.allSettled([
      auth.setActiveTenant({ token, tenantId: tenant2, expectedTenantContextRevision: "0" }),
      auth.setActiveTenant({ token, tenantId: tenant3, expectedTenantContextRevision: "0" }),
    ]);
    const won = outcomes.filter(
      (
        o,
      ): o is PromiseFulfilledResult<{ activeTenantId: string; tenantContextRevision: string }> =>
        o.status === "fulfilled",
    );
    const lost = outcomes.filter((o) => o.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const loser = (lost[0] as PromiseRejectedResult).reason;
    expect(loser).toBeInstanceOf(AuthError);
    expect((loser as AuthError).statusCode).toBe(409);
    expect((loser as AuthError).code).toBe("TENANT_CONTEXT_CONFLICT");
    const winner = (won[0] as PromiseFulfilledResult<{
      activeTenantId: string;
      tenantContextRevision: string;
    }>).value;
    expect([tenant2, tenant3]).toContain(winner.activeTenantId);
    expect(winner.tenantContextRevision).toBe("1");

    const after = await auth.resolveSession({ token });
    expect(after?.activeTenantId).toBe(winner.activeTenantId);
    expect(after?.tenantContextRevision).toBe("1");

    // Serial stale retry from the raced revision fails at the HTTP layer too.
    const staleHttp = await inject({
      method: "POST",
      url: `/v1/tenants/${tenant2}/switch`,
      token,
      revision: "0",
    });
    expect(staleHttp.statusCode).toBe(409);
    expect(staleHttp.json<{ code: string }>().code).toBe("TENANT_CONTEXT_CONFLICT");

    // Malformed expected revisions fail closed without touching the session.
    await expect(
      auth.setActiveTenant({ token, tenantId: tenant2, expectedTenantContextRevision: "not-a-number" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "TENANT_CONTEXT_CONFLICT" });
    const unchanged = await auth.resolveSession({ token });
    expect(unchanged?.tenantContextRevision).toBe("1");
  });

  it("an A→B→A cycle still rejects the original revision (no ABA escape)", async () => {
    const register = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: email("w1-aba"),
        password: "correct-horse-8",
        tenantName: "ABA Tenant A",
      },
    });
    expect(register.statusCode).toBe(201);
    const registered = register.json<{
      token: string;
      activeTenantId: string;
      tenantContextRevision: string;
    }>();
    const token = registered.token;
    const tenantAv1 = registered.activeTenantId;

    const createdB = await inject({
      method: "POST",
      url: "/v1/tenants",
      token,
      revision: "0",
      payload: { name: "ABA Tenant B" },
    });
    expect(createdB.statusCode).toBe(201);
    const tenantB2 = createdB.json<{ tenant: { id: string } }>().tenant.id;

    const toB = await inject({
      method: "POST",
      url: `/v1/tenants/${tenantB2}/switch`,
      token,
      revision: "0",
    });
    expect(toB.statusCode).toBe(200);
    expect(toB.json<{ activeTenantId: string; tenantContextRevision: string }>()).toMatchObject({
      activeTenantId: tenantB2,
      tenantContextRevision: "1",
    });

    const backToA = await inject({
      method: "POST",
      url: `/v1/tenants/${tenantAv1}/switch`,
      token,
      revision: "1",
    });
    expect(backToA.statusCode).toBe(200);
    expect(backToA.json<{ activeTenantId: string; tenantContextRevision: string }>()).toMatchObject({
      activeTenantId: tenantAv1,
      tenantContextRevision: "2",
    });

    // The active tenant is A again, but revision 0 is long gone: 409.
    const abaReplay = await inject({
      method: "POST",
      url: `/v1/tenants/${tenantB2}/switch`,
      token,
      revision: "0",
    });
    expect(abaReplay.statusCode).toBe(409);
    expect(abaReplay.json<{ code: string }>().code).toBe("TENANT_CONTEXT_CONFLICT");

    const bootstrap = await inject({
      method: "GET",
      url: "/v1/auth/session",
      token,
      revision: null,
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(
      bootstrap.json<{ activeTenantId: string; tenantContextRevision: string }>(),
    ).toMatchObject({ activeTenantId: tenantAv1, tenantContextRevision: "2" });

    const me = await inject({ method: "GET", url: "/v1/me", token, revision: "2" });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ activeTenant: { id: string } }>().activeTenant.id).toBe(tenantAv1);
  });

  it("logout invalidates the session", async () => {
    // Logout stays usable without the context header (bootstrap-class route).
    const logout = await inject({ method: "POST", url: "/v1/auth/logout", token: tokenA, revision: null });
    expect(logout.statusCode).toBe(200);
    const session = await inject({ method: "GET", url: "/v1/auth/session", token: tokenA, revision: null });
    expect(session.statusCode).toBe(401);
  });

  it("health stays public", async () => {
    const res = await inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
  });
});

describe("API CORS preflight (no DB required)", () => {
  let corsApp: NestFastifyApplication;

  beforeAll(async () => {
    // Same configurator `main.ts` calls (shared `registerApiCors` helper).
    corsApp = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(corsApp);
    registerApiCors(corsApp, ["http://localhost:3000"]);
    await corsApp.init();
  });

  afterAll(async () => {
    await corsApp.close();
  });

  function preflight(origin: string) {
    return corsApp.getHttpAdapter().getInstance().inject({
      method: "OPTIONS",
      url: "/v1/health",
      headers: {
        origin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type,x-tenant-context-revision",
      },
    });
  }

  it("uses an explicit allowlist with no credentials and the expected methods/headers", () => {
    const options = buildCorsOptions(["http://localhost:3000"]);
    expect(options.origin).toEqual(["http://localhost:3000"]);
    expect(options.credentials).toBe(false);
    expect(options.methods).toEqual(["GET", "HEAD", "POST", "OPTIONS"]);
    expect(options.allowedHeaders).toEqual(
      expect.arrayContaining([
        "authorization",
        "content-type",
        "x-request-id",
        "traceparent",
        "x-tenant-context-revision",
      ]),
    );
  });

  it("allows the configured local origin with the tenant revision header", async () => {
    const res = await preflight("http://localhost:3000");
    expect([200, 204]).toContain(res.statusCode);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    const allowHeaders = String(res.headers["access-control-allow-headers"] ?? "").toLowerCase();
    for (const header of ["authorization", "content-type", "x-tenant-context-revision"]) {
      expect(allowHeaders).toContain(header);
    }
  });

  it("does not allow a different origin", async () => {
    const res = await preflight("https://evil.example.com");
    expect(String(res.headers["access-control-allow-origin"] ?? "")).not.toBe(
      "https://evil.example.com",
    );
  });
});
