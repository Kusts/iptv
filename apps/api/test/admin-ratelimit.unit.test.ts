import { beforeEach, describe, expect, it } from "vitest";
import { Reflector } from "@nestjs/core";
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AUTH_RATE_LIMIT_POLICIES, RATE_LIMIT_POLICY_KEY, type AuthRateLimitKind } from "../src/auth/rate-limit.js";
import { AuthGuard } from "../src/auth/auth.guard.js";
import { PlatformAdminGuard } from "../src/auth/platform-admin.guard.js";
import { RateLimitGuard } from "../src/auth/rate-limit.guard.js";
import { RateLimitService } from "../src/auth/rate-limit.service.js";
import { OutboxController } from "../src/outbox/outbox.controller.js";
import { ProviderDispatchController } from "../src/provider/provider-dispatch.controller.js";
import type { ExecutionContext } from "@nestjs/common";

function makeRequest(remoteAddress = "203.0.113.21", body: unknown = { limit: 50 }): FastifyRequest {
  return {
    id: "req-admin-test",
    method: "POST",
    url: "/v1/admin/outbox/drain",
    socket: { remoteAddress },
    headers: {},
    body,
  } as unknown as FastifyRequest;
}

/** Request as `AuthGuard` leaves it: `request.auth` resolved for a (non-)admin. */
function makeAuthedRequest(isPlatformAdmin: boolean, remoteAddress = "203.0.113.21", body: unknown = { limit: 50 }): FastifyRequest {
  const req = makeRequest(remoteAddress, body);
  (req as unknown as { auth: FastifyRequest["auth"] }).auth = {
    userId: "user-test",
    sessionId: "session-test",
    token: "token-test",
    activeTenantId: null,
    tenantContextRevision: "rev-test",
    isPlatformAdmin,
    email: isPlatformAdmin ? "admin@example.com" : "user@example.com",
  };
  return req;
}

function makeReply() {
  const headersSent: Record<string, string> = {};
  return {
    headersSent,
    header(name: string, value: string) {
      headersSent[name] = value;
    },
  };
}

function makeContext(kind: AuthRateLimitKind, req: FastifyRequest, reply: unknown): ExecutionContext {
  const handler: () => void = () => {};
  Reflect.defineMetadata(RATE_LIMIT_POLICY_KEY, kind, handler);
  const cls = class Dummy {};
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply as FastifyReply }),
  } as unknown as ExecutionContext;
}

describe("admin drain rate limiting (SEC44 regression)", () => {
  let service: RateLimitService;
  beforeEach(() => {
    service = new RateLimitService();
  });

  it("keeps shipped admin budgets unchanged (documents the contract)", () => {
    expect(AUTH_RATE_LIMIT_POLICIES["admin-outbox-drain"].originLimit).toBe(30);
    expect(AUTH_RATE_LIMIT_POLICIES["admin-provider-dispatch"].originLimit).toBe(30);
    // login/register untouched by this change.
    expect(AUTH_RATE_LIMIT_POLICIES.login.identityLimit).toBe(5);
    expect(AUTH_RATE_LIMIT_POLICIES.register.identityLimit).toBe(10);
  });

  it("origin-only admin budget: 30 admits then 429 with Retry-After; other origin unaffected (no global lock-out)", () => {
    const origin = "203.0.113.21";
    for (let i = 0; i < 30; i += 1) {
      expect(service.acquire("admin-outbox-drain", makeRequest(origin), undefined).allowed).toBe(true);
    }
    const blocked = service.acquire("admin-outbox-drain", makeRequest(origin), undefined);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    // A different origin is NOT locked out by the first origin's exhaustion.
    expect(service.acquire("admin-outbox-drain", makeRequest("198.51.100.77"), undefined).allowed).toBe(true);
  });

  it("provider-dispatch budget is independent from outbox budget", () => {
    const origin = "203.0.113.22";
    for (let i = 0; i < 30; i += 1) {
      expect(service.acquire("admin-outbox-drain", makeRequest(origin), undefined).allowed).toBe(true);
    }
    expect(service.acquire("admin-outbox-drain", makeRequest(origin), undefined).allowed).toBe(false);
    // Same origin, other admin surface still has its own budget.
    expect(service.acquire("admin-provider-dispatch", makeRequest(origin), undefined).allowed).toBe(true);
  });

  it("guard denies the 31st admin drain with 429 + Retry-After in the shared schema", async () => {
    const guard = new RateLimitGuard(service, new Reflector());
    for (let i = 0; i < 30; i += 1) {
      await expect(
        guard.canActivate(makeContext("admin-outbox-drain", makeRequest(), makeReply())),
      ).resolves.toBe(true);
    }
    const reply = makeReply();
    await expect(
      guard.canActivate(makeContext("admin-outbox-drain", makeRequest(), reply)),
    ).rejects.toMatchObject({ status: 429, response: { code: "RATE_LIMITED" } });
    expect(reply.headersSent["Retry-After"]).toMatch(/^\d+$/);
  });

  it("guards run auth → platform-admin → rate-limit on every admin drain route (order locked)", () => {
    const expected = [AuthGuard, PlatformAdminGuard, RateLimitGuard];
    const routes: Array<[object, string]> = [
      [OutboxController.prototype, "drain"],
      [ProviderDispatchController.prototype, "drain"],
      [ProviderDispatchController.prototype, "recover"],
      [ProviderDispatchController.prototype, "reconcile"],
    ];
    for (const [target, method] of routes) {
      const handler = (target as Record<string, object>)[method] as object;
      const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[];
      expect(guards, `${String((target as { constructor?: { name?: string } }).constructor?.name)}.${method}`).toEqual(expected);
    }
    // Cheap read route: auth + admin only, no rate-limit budget involved.
    const stateGuards = Reflect.getMetadata(GUARDS_METADATA, OutboxController.prototype.drainState) as unknown[];
    expect(stateGuards).toEqual([AuthGuard, PlatformAdminGuard]);
  });

  it("admin kinds ignore email (origin-only): a forged body email opens no identity budget", () => {
    const origin = "203.0.113.31";
    const withEmail = (emailAddr: string) => makeRequest(origin, { limit: 50, email: emailAddr });
    for (let i = 0; i < 30; i += 1) {
      expect(service.acquire("admin-outbox-drain", withEmail(`user${i}@example.com`), `user${i}@example.com`).allowed).toBe(
        true,
      );
    }
    // Same origin, brand-new email: still blocked — only the origin counted.
    expect(service.acquire("admin-outbox-drain", withEmail("fresh@example.com"), "fresh@example.com").allowed).toBe(false);
    // Same email from a different origin: fully allowed — no identity bucket exists.
    const otherOrigin = "198.51.100.99";
    for (let i = 0; i < 30; i += 1) {
      expect(
        service.acquire("admin-outbox-drain", makeRequest(otherOrigin, { limit: 50 }), "user0@example.com").allowed,
      ).toBe(true);
    }
    expect(service.acquire("admin-outbox-drain", makeRequest(otherOrigin, { limit: 50 }), "user0@example.com").allowed).toBe(
      false,
    );
  });

  it("guard path ignores body email for admin kinds (defense in depth with the service)", async () => {
    const guard = new RateLimitGuard(service, new Reflector());
    const origin = "203.0.113.32";
    for (let i = 0; i < 30; i += 1) {
      await expect(
        guard.canActivate(
          makeContext("admin-provider-dispatch", makeRequest(origin, { limit: 25, email: `u${i}@example.com` }), makeReply()),
        ),
      ).resolves.toBe(true);
    }
    const reply = makeReply();
    await expect(
      guard.canActivate(
        makeContext("admin-provider-dispatch", makeRequest(origin, { limit: 25, email: "other@example.com" }), reply),
      ),
    ).rejects.toMatchObject({ status: 429, response: { code: "RATE_LIMITED" } });
    expect(reply.headersSent["Retry-After"]).toMatch(/^\d+$/);
  });

  it("chain: non-admin gets 403 BEFORE any budget is consumed (regression)", async () => {
    const adminGuard = new PlatformAdminGuard();
    const rateGuard = new RateLimitGuard(service, new Reflector());
    const origin = "203.0.113.33";

    // Ten non-admin attempts: each rejected by the admin gate…
    // NOTE: the guard is synchronous, so invoke it inside an async closure
    // for `rejects` to observe the throw.
    const runAdminGate = (ctx: ExecutionContext) => (async () => adminGuard.canActivate(ctx))();
    for (let i = 0; i < 10; i += 1) {
      const req = makeAuthedRequest(false, origin);
      const ctx = makeContext("admin-outbox-drain", req, makeReply());
      await expect(runAdminGate(ctx)).rejects.toMatchObject({
        status: 403,
        response: { code: "FORBIDDEN" },
      });
      // …and the rate limiter is never reached, so the budget stays intact.
    }
    // The origin still owns its full 30-admit budget for a legitimate admin.
    const adminReq = () => makeAuthedRequest(true, origin);
    for (let i = 0; i < 30; i += 1) {
      const ctx = makeContext("admin-outbox-drain", adminReq(), makeReply());
      await expect(runAdminGate(ctx)).resolves.toBe(true);
      await expect(rateGuard.canActivate(ctx)).resolves.toBe(true);
    }
    const reply = makeReply();
    await expect(rateGuard.canActivate(makeContext("admin-outbox-drain", adminReq(), reply))).rejects.toMatchObject({
      status: 429,
      response: { code: "RATE_LIMITED" },
    });
    expect(reply.headersSent["Retry-After"]).toMatch(/^\d+$/);
  });

  it("chain: unauthenticated request is 401 at the admin gate (never reaches the limiter)", async () => {
    const adminGuard = new PlatformAdminGuard();
    // No `request.auth`: AuthGuard did not resolve a session.
    const ctx = makeContext("admin-outbox-drain", makeRequest(), makeReply());
    await expect((async () => adminGuard.canActivate(ctx))()).rejects.toMatchObject({
      status: 401,
      response: { code: "UNAUTHENTICATED" },
    });
  });
});
