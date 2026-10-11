import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { applyMigrations } from "@iptv/database";
import type { AuthInstance } from "@iptv/auth";
import { newId } from "@iptv/domain";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";
import { RateLimitService } from "../src/auth/rate-limit.service.js";
import { AUTH_RATE_LIMIT_POLICIES } from "../src/auth/rate-limit.js";

const here = dirname(fileURLToPath(import.meta.url));
// apps/api/test -> repo root is three levels up; canonical migrations live at <repo>/db/migrations.
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

// Full UUIDv7 (no slice): the head of a v7 id is a millisecond timestamp, so a
// truncated prefix can collide across registrations in the same ms.
function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "")}@example.com`;
}

const PASSWORD = "correct-horse-8";
const LOGIN_IDENTITY_LIMIT = AUTH_RATE_LIMIT_POLICIES.login.identityLimit;
const LOGIN_ORIGIN_LIMIT = AUTH_RATE_LIMIT_POLICIES.login.originLimit;

describe.skipIf(!hasDb)("public auth rate limiting (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
  }, 120_000);

  beforeEach(async () => {
    // The limiter shares one socket origin across every inject() below, so drop
    // all buckets between tests to keep them independent.
    app.get(RateLimitService).resetAll();
  });

  afterAll(async () => {
    await app.close();
  });

  function inject(opts: {
    method: "GET" | "POST";
    url: string;
    payload?: Record<string, unknown>;
    headers?: Record<string, string>;
  }) {
    return app.getHttpAdapter().getInstance().inject({
      method: opts.method,
      url: opts.url,
      headers: opts.headers ?? {},
      ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    });
  }

  async function register(emailAddr: string): Promise<void> {
    const res = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: emailAddr, password: PASSWORD, tenantName: "RL Tenant" },
    });
    expect(res.statusCode).toBe(201);
  }

  function login(emailAddr: string, password: string, headers?: Record<string, string>) {
    return inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: emailAddr, password },
      headers,
    });
  }

  it("does NOT falsely block a legitimate register → login → re-login flow", async () => {
    const user = email("rl-legit");
    await register(user);
    const first = await login(user, PASSWORD);
    expect(first.statusCode).toBe(200);
    expect(typeof first.json<{ token: string }>().token).toBe("string");
    // Successful login resets the identity budget; a second login is still allowed.
    const second = await login(user, PASSWORD);
    expect(second.statusCode).toBe(200);
  });

  it("counts failures per identity but a success resets the budget (no false lock-out on mistypes)", async () => {
    const user = email("rl-reset");
    await register(user);

    // Two wrong-password attempts: allowed by the limiter, rejected by auth (401).
    expect((await login(user, "wrong-one")).statusCode).toBe(401);
    expect((await login(user, "wrong-two")).statusCode).toBe(401);

    // A correct credential still succeeds (2 < limit) AND clears the failure
    // budget, so the mistypes are not carried toward a lock-out.
    const ok = await login(user, PASSWORD);
    expect(ok.statusCode).toBe(200);

    // The next failure starts from a fresh budget (blocked only at limit).
    expect((await login(user, "wrong-three")).statusCode).toBe(401);
    expect((await login(user, PASSWORD)).statusCode).toBe(200);
  });

  it("threshold crossing: the (limit+1)-th failed login is 429 with Retry-After and the shared error schema", async () => {
    const user = email("rl-threshold");
    await register(user);

    for (let i = 0; i < LOGIN_IDENTITY_LIMIT; i += 1) {
      const res = await login(user, `wrong-${i}`);
      expect(res.statusCode).toBe(401); // passes limiter, rejected by auth
    }
    const blocked = await login(user, "wrong-over");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json<{ code: string }>().code).toBe("RATE_LIMITED");
    expect(blocked.headers["retry-after"]).toMatch(/^\d+$/);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("a BLOCKED request performs no password hash / DB lookup (auth.login is never called)", async () => {
    const auth = app.get<AuthInstance>("AUTH");
    const loginSpy = vi.spyOn(auth, "login");
    const user = email("rl-nocost");
    await register(user); // account exists (real register, not counted by the login spy)
    try {
      // Fill the identity budget: 5 failed logins reach auth.login (real 401s).
      for (let i = 0; i < LOGIN_IDENTITY_LIMIT; i += 1) {
        expect((await login(user, `wrong-${i}`)).statusCode).toBe(401);
      }
      expect(loginSpy).toHaveBeenCalledTimes(LOGIN_IDENTITY_LIMIT);

      // The (limit+1)-th attempt is rejected by the limiter BEFORE the handler:
      // auth.login must NOT run again — no password hash and no e-mail query.
      const blocked = await login(user, "wrong-over");
      expect(blocked.statusCode).toBe(429);
      expect(loginSpy).toHaveBeenCalledTimes(LOGIN_IDENTITY_LIMIT);
    } finally {
      loginSpy.mockRestore();
    }
  });

  it("forged X-Forwarded-For cannot bypass the limit (no trusted proxy by default)", async () => {
    const user = email("rl-xff");
    await register(user);

    // Fill the identity budget with a rotating forged header.
    for (let i = 0; i < LOGIN_IDENTITY_LIMIT; i += 1) {
      const res = await login(user, `wrong-${i}`, { "x-forwarded-for": `9.9.9.${i}` });
      expect(res.statusCode).toBe(401);
    }
    // Even with a brand-new forged origin the per-identity budget is exhausted.
    const blocked = await login(user, "wrong-over", { "x-forwarded-for": "203.0.113.200" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json<{ code: string }>().code).toBe("RATE_LIMITED");
  });

  it("non-existent account is throttled identically (limiter never reveals existence)", async () => {
    const ghost = email("rl-ghost");
    for (let i = 0; i < LOGIN_IDENTITY_LIMIT; i += 1) {
      const res = await login(ghost, "whatever");
      expect(res.statusCode).toBe(401);
    }
    const blocked = await login(ghost, "whatever-over");
    expect(blocked.statusCode).toBe(429);
  });

  it("concurrent logins at the threshold admit exactly `limit` and reject the rest (no race)", async () => {
    const user = email("rl-race");
    await register(user);

    const total = LOGIN_IDENTITY_LIMIT + 15;
    const outcomes = await Promise.all(
      Array.from({ length: total }, (_, i) => login(user, `wrong-${i}`)),
    );
    const admitted = outcomes.filter((r) => r.statusCode !== 429).length;
    const limited = outcomes.filter((r) => r.statusCode === 429).length;
    expect(admitted).toBe(LOGIN_IDENTITY_LIMIT);
    expect(limited).toBe(total - LOGIN_IDENTITY_LIMIT);
    // Everything that passed the limiter was rejected by auth, not by the limiter.
    for (const r of outcomes.filter((x) => x.statusCode !== 429)) {
      expect(r.statusCode).toBe(401);
    }
  });

  it("per-origin backstop trips independent of identity (distinct emails, one source)", async () => {
    for (let i = 0; i < LOGIN_ORIGIN_LIMIT; i += 1) {
      const res = await login(email(`rl-origin-${i}`), "whatever");
      // Each distinct identity is under its own budget; origin accumulates.
      expect(res.statusCode).toBe(401);
    }
    const fresh = await login(email("rl-origin-fresh"), "whatever");
    expect(fresh.statusCode).toBe(429);
  });
});
