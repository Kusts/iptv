import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  ATTACHMENT_UPLOAD_CONTENT_TYPE,
  ATTACHMENT_UPLOAD_ROUTE_PATH,
  registerAttachmentUploadParser,
} from "../src/communications/attachment-upload-parser.js";
import { bindUploadPreadmitDeps } from "../src/communications/upload-preadmit.js";
import { RateLimitService } from "../src/auth/rate-limit.service.js";

/**
 * FIX-WAHA-PREADMIT-20261020 (unit, zero network, zero DB — bare Fastify).
 *
 * Closes the MEDIUM left open by FIX-WAHA-PARSER: the old gate only checked
 * token PRESENCE, so any `Authorization: Bearer x` forced buffering+parsing
 * of up to 48 MiB before the post-parse guards rejected. The gate now also
 * resolves the session (SAME `resolveSession` `AuthGuard` uses) and peeks at
 * the origin budget (SAME policy/derivation/trusted-proxy `RateLimitGuard`
 * charges, read-only so the single charge stays post-parse exactly once).
 *
 * No-parse proof strategy: every inadmissible request below carries a
 * MALFORMED JSON body. If Fastify buffered+parsed, the vendor parser would
 * answer 400 `invalid attachment upload JSON`; the gate answers 401/429
 * instead — and a `JSON.parse` spy stays silent, proving the parser never
 * ran (hence zero bytes usefully buffered). A well-formed control proves
 * the harness DOES detect parsing (400 + spy called).
 *
 * Deterministic fixtures: fixed tokens, fixed malformed bodies, a real
 * `RateLimitService` with a real bounded store (no fakes for the limiter —
 * the point is the gate shares the guard's enforcement).
 */

const MALFORMED_JSON = '{"kind":"IMAGE","contentBase64":"';
const SMALL_JSON = JSON.stringify({ kind: "IMAGE", mimeType: "image/jpeg", contentBase64: "eA==" });

const VALID_TOKEN = "valid-token-0001";
const INVALID_TOKEN = "invalid-token-0001";

function fakeAuth(throwOnResolve = false) {
  return {
    resolveSession: async (input: { token: string }) => {
      if (throwOnResolve) {
        throw new Error("db blip");
      }
      return input.token === VALID_TOKEN ? { sessionId: "session-test" } : null;
    },
  };
}

async function buildApp(deps: { auth?: ReturnType<typeof fakeAuth> | null; rateLimit?: RateLimitService | null }) {
  const app: FastifyInstance = Fastify();
  registerAttachmentUploadParser(app);
  bindUploadPreadmitDeps({
    auth: (deps.auth ?? null) as never,
    rateLimit: deps.rateLimit ?? null,
  });
  app.post(ATTACHMENT_UPLOAD_ROUTE_PATH, async (req) => ({ ok: true, bytes: JSON.stringify(req.body).length }));
  await app.ready();
  return app;
}

function injectVendor(
  app: FastifyInstance,
  opts: { token?: string; payload: string; remoteAddress?: string; forwardedFor?: string },
) {
  const headers: Record<string, string> = { "content-type": ATTACHMENT_UPLOAD_CONTENT_TYPE };
  if (opts.token !== undefined) {
    headers["authorization"] = `Bearer ${opts.token}`;
  }
  if (opts.forwardedFor !== undefined) {
    headers["x-forwarded-for"] = opts.forwardedFor;
  }
  return app.inject({
    method: "POST",
    url: ATTACHMENT_UPLOAD_ROUTE_PATH,
    headers,
    payload: opts.payload,
    remoteAddress: opts.remoteAddress ?? "127.0.0.1",
  });
}

function fakeServiceRequest(remoteAddress: string, forwardedFor?: string) {
  const headers: Record<string, string> = {};
  if (forwardedFor !== undefined) {
    headers["x-forwarded-for"] = forwardedFor;
  }
  return { socket: { remoteAddress }, headers } as never;
}

describe("upload pre-admit gate (FIX-WAHA-PREADMIT-20261020)", () => {
  let parseSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    parseSpy = vi.spyOn(JSON, "parse");
    parseSpy.mockClear();
  });

  afterEach(async () => {
    bindUploadPreadmitDeps(null);
    vi.restoreAllMocks();
  });

  it("rejects a PRESENT-but-invalid token with 401 before parsing (malformed body, parser silent)", async () => {
    const app = await buildApp({ auth: fakeAuth(), rateLimit: new RateLimitService() });
    try {
      const res = await injectVendor(app, { token: INVALID_TOKEN, payload: MALFORMED_JSON });
      expect(parseSpy).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.body).toContain("UNAUTHENTICATED");
      expect(res.body).toContain("session is invalid or expired");
    } finally {
      await app.close();
    }
  });

  it("rejects a rate-blocked origin with 429 + Retry-After before parsing (malformed body, parser silent)", async () => {
    const service = new RateLimitService();
    // Exhaust the SAME origin budget the post-parse guard charges: 30 admits on 127.0.0.1.
    for (let i = 0; i < 30; i += 1) {
      expect(service.acquire("communications-attachments-upload", fakeServiceRequest("127.0.0.1"), undefined).allowed).toBe(
        true,
      );
    }
    expect(service.peek("communications-attachments-upload", fakeServiceRequest("127.0.0.1"), undefined).allowed).toBe(
      false,
    );
    const app = await buildApp({ auth: fakeAuth(), rateLimit: service });
    try {
      const res = await injectVendor(app, { token: VALID_TOKEN, payload: MALFORMED_JSON });
      expect(parseSpy).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(429);
      expect(res.headers["retry-after"]).toMatch(/^\d+$/);
      expect(res.body).toContain("RATE_LIMITED");
    } finally {
      await app.close();
    }
  });

  it("control: the same malformed body WITH valid credentials reaches the parser (400 + parser ran)", async () => {
    const app = await buildApp({ auth: fakeAuth(), rateLimit: new RateLimitService() });
    try {
      const res = await injectVendor(app, { token: VALID_TOKEN, payload: MALFORMED_JSON });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("invalid attachment upload JSON");
      expect(parseSpy).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("keeps parsing for a valid token on a fresh budget (small vendor body → 200)", async () => {
    const app = await buildApp({ auth: fakeAuth(), rateLimit: new RateLimitService() });
    try {
      const res = await injectVendor(app, { token: VALID_TOKEN, payload: SMALL_JSON });
      expect(res.statusCode).toBe(200);
      expect(parseSpy).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("still rejects a missing token with 401 before parsing (no deps needed)", async () => {
    const app = await buildApp({ auth: fakeAuth(), rateLimit: new RateLimitService() });
    try {
      const res = await injectVendor(app, { payload: MALFORMED_JSON });
      expect(parseSpy).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.body).toContain("missing session token");
    } finally {
      await app.close();
    }
  });

  it("honors trusted-proxy hops exactly like the guard (XFF-derived origin blocked pre-parse)", async () => {
    const service = new RateLimitService({ trustedProxyHops: 1 });
    // Exhaust the budget for the XFF-derived client through the REAL service,
    // the same call path the guard uses — proving shared trusted-proxy semantics.
    for (let i = 0; i < 30; i += 1) {
      expect(
        service.acquire("communications-attachments-upload", fakeServiceRequest("10.9.9.9", "203.0.113.44"), undefined)
          .allowed,
      ).toBe(true);
    }
    const app = await buildApp({ auth: fakeAuth(), rateLimit: service });
    try {
      const blocked = await injectVendor(app, {
        token: VALID_TOKEN,
        payload: MALFORMED_JSON,
        remoteAddress: "10.9.9.9",
        forwardedFor: "203.0.113.44",
      });
      expect(parseSpy).not.toHaveBeenCalled();
      expect(blocked.statusCode).toBe(429);
      // A different XFF client on the same socket is NOT blocked.
      parseSpy.mockClear();
      const allowed = await injectVendor(app, {
        token: VALID_TOKEN,
        payload: SMALL_JSON,
        remoteAddress: "10.9.9.9",
        forwardedFor: "198.51.100.7",
      });
      expect(allowed.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("fail-open: a throwing limiter admits (parser runs; guard still decides post-parse)", async () => {
    const throwing = {
      peek: () => {
        throw new Error("limiter bug");
      },
    } as unknown as RateLimitService;
    const app = await buildApp({ auth: fakeAuth(), rateLimit: throwing });
    try {
      const res = await injectVendor(app, { token: VALID_TOKEN, payload: MALFORMED_JSON });
      expect(res.statusCode).toBe(400);
      expect(parseSpy).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("fail-open: a throwing session lookup admits (parser runs; AuthGuard still decides post-parse)", async () => {
    const app = await buildApp({ auth: fakeAuth(true), rateLimit: new RateLimitService() });
    try {
      const res = await injectVendor(app, { token: VALID_TOKEN, payload: SMALL_JSON });
      // Bare instance has no guards by design: admission here proves the
      // pre-parse gate did not invent a denial on internal error.
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("admits when deps are unbound (structural gate only — pre-DI behavior unchanged)", async () => {
    const app: FastifyInstance = Fastify();
    registerAttachmentUploadParser(app);
    bindUploadPreadmitDeps(null);
    app.post(ATTACHMENT_UPLOAD_ROUTE_PATH, async () => ({ ok: true }));
    await app.ready();
    try {
      const res = await injectVendor(app, { token: INVALID_TOKEN, payload: SMALL_JSON });
      // No session deps: presence-only check passes, parser runs.
      expect(res.statusCode).toBe(200);
      expect(parseSpy).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
