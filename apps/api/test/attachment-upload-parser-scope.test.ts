import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  ATTACHMENT_UPLOAD_BODY_LIMIT_BYTES,
  ATTACHMENT_UPLOAD_CONTENT_TYPE,
  ATTACHMENT_UPLOAD_ROUTE_PATH,
  isAttachmentUploadContentType,
  isAttachmentUploadRequest,
  registerAttachmentUploadParser,
} from "../src/communications/attachment-upload-parser.js";

/**
 * FIX-WAHA-PARSER-20261020 (unit, zero network, zero DB — bare Fastify).
 *
 * The vendor `application/vnd.iptv.attachment+json` parser carries a 48 MiB
 * ceiling, but Fastify parses the body BEFORE Nest guards (auth/rate-limit)
 * run. A root-scoped 48 MiB parser therefore buffers up to 48 MiB on EVERY
 * route — including unauthenticated and rate-blocked requests — before any
 * rejection. The fix gates the vendor type in `onRequest` (runs before
 * parsing, hence before ANY buffering):
 * - vendor type off `POST /v1/communications/attachments` → 415, so the
 *   48 MiB ceiling never engages off-route (a ~2 MiB body the old global
 *   parser would have buffered is refused outright);
 * - vendor type on-route with no session token at all → 401, mirroring
 *   AuthGuard's missing-token rejection, before buffering.
 * - the upload route itself keeps the 48 MiB ceiling with valid credentials
 *   (small proves parsing; the 2 MiB envelope the default 1 MiB JSON parser
 *   would 413 is accepted here);
 * - non-vendor traffic is untouched by the gate.
 *
 * Deterministic fixtures: fixed ~2 MiB filler (between the 1 MiB default
 * and the 48 MiB ceiling), no randomness, no secrets.
 */

const TWO_MIB = 2 * 1024 * 1024;

function fillerJson(bytes: number): string {
  return JSON.stringify({ kind: "IMAGE", mimeType: "image/jpeg", contentBase64: "x".repeat(bytes) });
}

describe("attachment upload parser scoping (FIX-WAHA-PARSER-20261020)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    registerAttachmentUploadParser(app);
    app.post(ATTACHMENT_UPLOAD_ROUTE_PATH, async (req) => ({ ok: true, bytes: JSON.stringify(req.body).length }));
    app.post("/v1/auth/login", async () => ({ ok: true }));
    app.get("/v1/communications/conversations", async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("pins the route ceiling (48 MiB, unchanged) and the route path", () => {
    expect(ATTACHMENT_UPLOAD_BODY_LIMIT_BYTES).toBe(48 * 1024 * 1024);
    expect(ATTACHMENT_UPLOAD_ROUTE_PATH).toBe("/v1/communications/attachments");
  });

  it("isAttachmentUploadRequest matches only POST + exact path (query strings ignored)", () => {
    expect(isAttachmentUploadRequest({ method: "POST", url: "/v1/communications/attachments" })).toBe(true);
    expect(isAttachmentUploadRequest({ method: "POST", url: "/v1/communications/attachments?x=1" })).toBe(true);
    expect(isAttachmentUploadRequest({ method: "GET", url: "/v1/communications/attachments" })).toBe(false);
    expect(isAttachmentUploadRequest({ method: "POST", url: "/v1/communications/attachments/" })).toBe(false);
    expect(isAttachmentUploadRequest({ method: "POST", url: "/v1/auth/login" })).toBe(false);
  });

  it("isAttachmentUploadContentType ignores parameters/case and non-vendor types", () => {
    expect(isAttachmentUploadContentType({ headers: { "content-type": ATTACHMENT_UPLOAD_CONTENT_TYPE } })).toBe(true);
    expect(
      isAttachmentUploadContentType({ headers: { "content-type": `${ATTACHMENT_UPLOAD_CONTENT_TYPE}; charset=utf-8` } }),
    ).toBe(true);
    expect(
      isAttachmentUploadContentType({ headers: { "content-type": "Application/VND.IPTV.Attachment+JSON" } }),
    ).toBe(true);
    expect(isAttachmentUploadContentType({ headers: { "content-type": "application/json" } })).toBe(false);
    expect(isAttachmentUploadContentType({ headers: {} })).toBe(false);
  });

  it("rejects the vendor type off-route (small body) with 415 before parsing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": ATTACHMENT_UPLOAD_CONTENT_TYPE },
      payload: fillerJson(64),
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("rejects the vendor type off-route (2 MiB body) with 415 — the 48 MiB ceiling never engages", async () => {
    // Between the 1 MiB default and the 48 MiB ceiling: the pre-fix global
    // parser buffered this whole body before the route 404'd; now it is
    // refused in onRequest with zero buffering.
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": ATTACHMENT_UPLOAD_CONTENT_TYPE },
      payload: fillerJson(TWO_MIB),
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("rejects the vendor type on off-route methods (GET) with 415", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/communications/conversations",
      headers: { "content-type": ATTACHMENT_UPLOAD_CONTENT_TYPE },
      payload: fillerJson(64),
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("rejects the vendor type on-route without any session token with 401 before buffering", async () => {
    // Same 2 MiB envelope: refused in onRequest (no Authorization header,
    // no cookie), mirroring AuthGuard's missing-token 401, before buffering.
    const res = await app.inject({
      method: "POST",
      url: ATTACHMENT_UPLOAD_ROUTE_PATH,
      headers: { "content-type": ATTACHMENT_UPLOAD_CONTENT_TYPE },
      payload: fillerJson(TWO_MIB),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "UNAUTHENTICATED", message: "missing session token" });
  });

  it("keeps the upload route working with credentials (small vendor body parses)", async () => {
    const res = await app.inject({
      method: "POST",
      url: ATTACHMENT_UPLOAD_ROUTE_PATH,
      headers: { "content-type": ATTACHMENT_UPLOAD_CONTENT_TYPE, authorization: "Bearer test-token-0001" },
      payload: fillerJson(64),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("keeps the upload route working with credentials for a 2 MiB vendor envelope (scoped 48 MiB ceiling)", async () => {
    // The default 1 MiB JSON parser would 413 this envelope; the scoped
    // vendor ceiling accepts it — only here, only with credentials.
    const res = await app.inject({
      method: "POST",
      url: ATTACHMENT_UPLOAD_ROUTE_PATH,
      headers: { "content-type": ATTACHMENT_UPLOAD_CONTENT_TYPE, authorization: "Bearer test-token-0001" },
      payload: fillerJson(TWO_MIB),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("accepts vendor parameters (charset) on-route with credentials", async () => {
    const res = await app.inject({
      method: "POST",
      url: ATTACHMENT_UPLOAD_ROUTE_PATH,
      headers: {
        "content-type": `${ATTACHMENT_UPLOAD_CONTENT_TYPE}; charset=utf-8`,
        authorization: "Bearer test-token-0001",
      },
      payload: fillerJson(64),
    });
    expect(res.statusCode).toBe(200);
  });

  it("leaves non-vendor traffic untouched (plain JSON off-route and on-route pass the gate)", async () => {
    const off = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email: "a@example.com" },
    });
    expect(off.statusCode).toBe(200);

    // No token: the gate ignores plain JSON (the real app's AuthGuard still
    // 401s post-parse; this bare instance has no guards by design).
    const on = await app.inject({
      method: "POST",
      url: ATTACHMENT_UPLOAD_ROUTE_PATH,
      headers: { "content-type": "application/json" },
      payload: { kind: "IMAGE" },
    });
    expect(on.statusCode).toBe(200);
  });
});
