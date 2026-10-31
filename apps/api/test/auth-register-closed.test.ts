import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { applyMigrations, createDb } from "@iptv/database";
import { newId } from "@iptv/domain";
import { AppModule } from "../src/app.module.js";
import { PlatformAdminGuard } from "../src/auth/platform-admin.guard.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";

/**
 * AUTH_REGISTER_CLOSED (P84-B3): fail-closed public-signup gate.
 *
 * Closed ("1", the production default) makes `POST /v1/auth/register`
 * return 403 REGISTER_CLOSED before any body validation, DB access,
 * user/tenant/session creation or audit write. Open ("0") preserves the
 * current bootstrap byte-identically (201 + tenant_owner + revision "0").
 *
 * The no-DB suites below always run: the closed path never touches the
 * database, and the open path without a database proves it still reaches the
 * existing `requireAuth` guard (503 UNAVAILABLE). The DB suite runs only with
 * TEST_DATABASE_URL and proves zero side effects + unchanged login flow.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(0, 12)}@example.com`;
}

function saveDbEnv(): Record<string, string | undefined> {
  return {
    DATABASE_URL: process.env["DATABASE_URL"],
    APP_DATABASE_URL: process.env["APP_DATABASE_URL"],
    TEST_DATABASE_URL: process.env["TEST_DATABASE_URL"],
  };
}

function clearDbEnv(): void {
  delete process.env["DATABASE_URL"];
  delete process.env["APP_DATABASE_URL"];
  delete process.env["TEST_DATABASE_URL"];
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function bootApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
  registerRequestIdHook(app);
  await app.init();
  return app;
}

function postRegister(
  app: NestFastifyApplication,
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
  url = "/v1/auth/register",
) {
  return app.getHttpAdapter().getInstance().inject({
    method: "POST",
    url,
    headers: { ...extraHeaders },
    payload,
  });
}

describe("auth register closed (no DB required)", () => {
  let app: NestFastifyApplication;
  let savedFlag: string | undefined;
  let savedDbEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    savedFlag = process.env["AUTH_REGISTER_CLOSED"];
    savedDbEnv = saveDbEnv();
    // Closed gate under test; no database configured on purpose (proves the
    // 403 path performs zero DB access — it never reaches `requireAuth`).
    process.env["AUTH_REGISTER_CLOSED"] = "1";
    clearDbEnv();
    app = await bootApp();
  });

  afterAll(async () => {
    await app.close();
    if (savedFlag === undefined) delete process.env["AUTH_REGISTER_CLOSED"];
    else process.env["AUTH_REGISTER_CLOSED"] = savedFlag;
    restoreEnv(savedDbEnv);
  });

  it("denies registration with 403 REGISTER_CLOSED in the shared error schema", async () => {
    const res = await postRegister(app, {
      email: email("closed"),
      password: "correct-horse-8",
      tenantName: "Closed Tenant",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "REGISTER_CLOSED" });
    expect(typeof res.json<{ message: string }>().message).toBe("string");
  });

  it("rejects before body validation (malformed body still 403, never 400)", async () => {
    const res = await postRegister(app, { email: 42, password: "" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "REGISTER_CLOSED" });
  });

  it("has no header/query bypass", async () => {
    const payload = { email: email("bypass"), password: "correct-horse-8" };
    const bypassHeaders: Record<string, string>[] = [
      { "x-admin": "true" },
      { "x-platform-admin": "true" },
      { role: "tenant_owner" },
      { authorization: "Bearer admin" },
    ];
    for (const headers of bypassHeaders) {
      const res = await postRegister(app, payload, headers);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "REGISTER_CLOSED" });
    }
    const res = await postRegister(
      app,
      payload,
      {},
      "/v1/auth/register?admin=1&open=1&role=tenant_owner",
    );
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "REGISTER_CLOSED" });
  });

  it("keeps the rate limiter in front of the closed gate (flood → 429)", async () => {
    // Origin budget for `register` is 20/hour; distinct emails dodge the
    // identity budget (10/hour) so the 21st request must trip the origin
    // backstop — the guard still runs and budgets are still charged on the
    // closed path (never reset, since there is no success).
    let lastStatus = 0;
    for (let i = 0; i < 21; i += 1) {
      const res = await postRegister(app, {
        email: email(`flood-${i}`),
        password: "correct-horse-8",
      });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(429);
  });
});

describe("auth register closed by default and on blank (no DB required)", () => {
  let savedFlag: string | undefined;
  let savedDbEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    savedFlag = process.env["AUTH_REGISTER_CLOSED"];
    savedDbEnv = saveDbEnv();
    clearDbEnv();
  });

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env["AUTH_REGISTER_CLOSED"];
    else process.env["AUTH_REGISTER_CLOSED"] = savedFlag;
    restoreEnv(savedDbEnv);
  });

  it("is closed when the flag is unset (fail-closed default)", async () => {
    delete process.env["AUTH_REGISTER_CLOSED"];
    const app = await bootApp();
    try {
      const res = await postRegister(app, { email: email("dflt"), password: "correct-horse-8" });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "REGISTER_CLOSED" });
    } finally {
      await app.close();
    }
  });

  it("treats blank as absent (still closed)", async () => {
    for (const blank of ["", "   "]) {
      process.env["AUTH_REGISTER_CLOSED"] = blank;
      const app = await bootApp();
      try {
        const res = await postRegister(app, { email: email("blank"), password: "correct-horse-8" });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: "REGISTER_CLOSED" });
      } finally {
        await app.close();
      }
    }
  });
});

describe("auth register open with flag=0 and no DB (no DB required)", () => {
  let app: NestFastifyApplication;
  let savedFlag: string | undefined;
  let savedDbEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    savedFlag = process.env["AUTH_REGISTER_CLOSED"];
    savedDbEnv = saveDbEnv();
    process.env["AUTH_REGISTER_CLOSED"] = "0";
    clearDbEnv();
    app = await bootApp();
  });

  afterAll(async () => {
    await app.close();
    if (savedFlag === undefined) delete process.env["AUTH_REGISTER_CLOSED"];
    else process.env["AUTH_REGISTER_CLOSED"] = savedFlag;
    restoreEnv(savedDbEnv);
  });

  it("reaches the existing guard (503 UNAVAILABLE, not 403)", async () => {
    const res = await postRegister(app, { email: email("open"), password: "correct-horse-8" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("auth register platform invariant: common vs admin (no DB required)", () => {
  // `auth.register` persists every open signup with `is_platform_admin: false`
  // (packages/auth/src/auth.ts) and the controller never echoes the flag, so
  // the observable invariant lives in `PlatformAdminGuard`: a common user is
  // 403 FORBIDDEN on platform drains while a preexisting admin still passes.
  // These unit checks run without a database; the DB suite below re-proves
  // the same invariant end-to-end (flag row + HTTP drain).
  function guardContext(isPlatformAdmin: boolean | undefined): ExecutionContext {
    const req = (isPlatformAdmin === undefined ? {} : { auth: { isPlatformAdmin } }) as object;
    return {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  it("denies a common user (isPlatformAdmin=false) with 403 FORBIDDEN", async () => {
    const guard = new PlatformAdminGuard();
    await expect((async () => guard.canActivate(guardContext(false)))()).rejects.toMatchObject({
      status: 403,
      response: { code: "FORBIDDEN" },
    });
  });

  it("keeps passing a preexisting platform admin (isPlatformAdmin=true)", async () => {
    const guard = new PlatformAdminGuard();
    await expect((async () => guard.canActivate(guardContext(true)))()).resolves.toBe(true);
  });

  it("fails closed without resolved auth (never reaches the admin check)", async () => {
    const guard = new PlatformAdminGuard();
    await expect((async () => guard.canActivate(guardContext(undefined)))()).rejects.toMatchObject({
      status: 401,
      response: { code: "UNAUTHENTICATED" },
    });
  });
});

describe.skipIf(!hasDb)("auth register closed with a database (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  let savedFlag: string | undefined;
  const db = createDb({ connectionString: connectionString as string });

  beforeAll(async () => {
    savedFlag = process.env["AUTH_REGISTER_CLOSED"];
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    process.env["AUTH_REGISTER_CLOSED"] = "0";
    app = await bootApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await db.destroy();
    if (savedFlag === undefined) delete process.env["AUTH_REGISTER_CLOSED"];
    else process.env["AUTH_REGISTER_CLOSED"] = savedFlag;
  });

  async function count(table: "control.users" | "control.auth_credentials" | "control.auth_sessions" | "control.tenants"): Promise<number> {
    const row = await db
      .selectFrom(table)
      .select((eb) => eb.fn.countAll().as("n"))
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  it("open register stays byte-identical (201 + tenant_owner + revision 0)", async () => {
    const user = { email: email("open-ident"), password: "correct-horse-8" };
    const res = await postRegister(app, { ...user, tenantName: "Open Tenant" });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ token: string; activeTenantId: string; tenantContextRevision: string }>();
    expect(typeof body.token).toBe("string");
    expect(body.tenantContextRevision).toBe("0");
    expect(typeof body.activeTenantId).toBe("string");

    // Reboot the same process CLOSED and prove the DB is untouched by denials.
    await app.close();
    process.env["AUTH_REGISTER_CLOSED"] = "1";
    app = await bootApp();

    const before = {
      users: await count("control.users"),
      creds: await count("control.auth_credentials"),
      sessions: await count("control.auth_sessions"),
      tenants: await count("control.tenants"),
    };
    const denied = await postRegister(app, {
      email: email("closed-db"),
      password: "correct-horse-8",
      tenantName: "Never Created",
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "REGISTER_CLOSED" });
    expect(await count("control.users")).toBe(before.users);
    expect(await count("control.auth_credentials")).toBe(before.creds);
    expect(await count("control.auth_sessions")).toBe(before.sessions);
    expect(await count("control.tenants")).toBe(before.tenants);

    // Login for the pre-existing user still works while closed.
    const login = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: {},
      payload: user,
    });
    expect(login.statusCode).toBe(200);
    expect(login.json<{ tenantContextRevision: string }>().tenantContextRevision).toBe("0");

    // And the session/logout flow is unchanged while closed.
    const token = login.json<{ token: string }>().token;
    const session = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(session.statusCode).toBe(200);
    const logout = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logout.statusCode).toBe(200);
  });

  it("open register creates a common user (is_platform_admin=false, platform drains 403); a promoted admin keeps access", async () => {
    // The previous test leaves the app CLOSED; reopen for a fresh signup.
    await app.close();
    process.env["AUTH_REGISTER_CLOSED"] = "0";
    app = await bootApp();

    const user = { email: email("common-priv"), password: "correct-horse-8" };
    const res = await postRegister(app, { ...user, tenantName: "Common Tenant" });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ token: string; user: { id: string } }>();
    const token = body.token;

    // No role-name inference: the invariant is the platform flag row + gate.
    const flag = await db
      .selectFrom("control.users")
      .select(["is_platform_admin"])
      .where("id", "=", body.user.id)
      .executeTakeFirstOrThrow();
    expect(flag.is_platform_admin).toBe(false);

    // Cheap read-only admin route (auth + admin only, no rate-limit budget):
    // the common user is denied without touching any budget.
    const drainState = (t: string) =>
      app.getHttpAdapter().getInstance().inject({
        method: "GET",
        url: "/v1/admin/outbox/drain-state",
        headers: {
          authorization: `Bearer ${t}`,
          "x-tenant-context-revision": "0",
        },
      });
    const denied = await drainState(token);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "FORBIDDEN" });

    // Promote via the established bootstrap pattern (same as
    // commands-events-hitl: direct `control.users` update, same session
    // token — `resolveSession` reads the flag live per request).
    await db
      .updateTable("control.users")
      .set({ is_platform_admin: true })
      .where("id", "=", body.user.id)
      .execute();
    const allowed = await drainState(token);
    expect(allowed.statusCode).toBe(200);

    // …and demotion revokes it again (guard reads the live flag per session).
    await db
      .updateTable("control.users")
      .set({ is_platform_admin: false })
      .where("id", "=", body.user.id)
      .execute();
    const revoked = await drainState(token);
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json()).toMatchObject({ code: "FORBIDDEN" });
  });
});
