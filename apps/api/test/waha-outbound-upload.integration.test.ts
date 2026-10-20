import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createDb, applyMigrations } from "@iptv/database";
import type { CommandActor } from "@iptv/domain";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";
import { ATTACHMENT_UPLOAD_CONTENT_TYPE } from "../src/communications/attachment-upload-parser.js";
import { currentOutboundAttachmentStore } from "../src/communications/waha-outbound-attachments.js";
import { PgOutboundAttachmentStore } from "../src/communications/pg-outbound-attachment-store.js";
import { resetGatewayForTests } from "../src/communications/messaging-gateway.js";
import { RateLimitService } from "../src/auth/rate-limit.service.js";
import { CommandBus } from "../src/commands/command-bus.js";

/**
 * EXEC-WAHA-BACKING-20261020 (requires TEST_DATABASE_URL, disposable DB).
 *
 * End-to-end on the persistent lane (zero fetch to real WAHA):
 * - the boot wiring installs `PgOutboundAttachmentStore` as the default
 *   (no memory store is configured anywhere in this file);
 * - `POST /v1/communications/attachments` registers real bytes and returns
 *   an opaque ref; `POST .../send-media` with that ref is SENT (echo gateway);
 * - cross-tenant refs refuse; oversize/MIME uploads refuse; sends without a
 *   prior upload refuse;
 * - `Idempotency-Key` replays the same ref; the vendor content-type carries
 *   the scoped body limit while plain JSON is 415.
 *
 * Deterministic fixtures: counters only, never UUID-head slices.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

let counter = 0;
function tag(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, "0")}`;
}

function magicBytes(kind: "IMAGE" | "AUDIO" | "DOCUMENT" | "VIDEO", size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  const head: number[] =
    kind === "IMAGE"
      ? [0xff, 0xd8, 0xff, 0xe0]
      : kind === "AUDIO"
        ? [0x4f, 0x67, 0x67, 0x53]
        : kind === "DOCUMENT"
          ? [0x25, 0x50, 0x44, 0x46]
          : [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32];
  bytes.set(head, 0);
  return bytes;
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

describe.skipIf(!hasDb)("outbound attachment upload -> send-media (Pg lane, requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let tenantId = "";
  let userId = "";
  let token = "";
  let bus: CommandBus;
  let conversationId = "";

  function actor(id: string = tenantId, user: string = userId): CommandActor {
    return {
      userId: user,
      isPlatformAdmin: false,
      tenantId: id,
      roleKeys: ["tenant_owner"],
      permissions: ["crm.person.read", "crm.lead.write", "conversation.reply"],
      actorType: "human",
    };
  }

  function inject(opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    contentType?: string;
    idempotencyKey?: string;
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = { "x-tenant-context-revision": "0" };
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
    }
    if (opts.contentType !== undefined) {
      headers["content-type"] = opts.contentType;
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

  function uploadPayload(kind: string, mimeType: string, size: number, extra: Record<string, unknown> = {}) {
    const k = kind as "IMAGE" | "AUDIO" | "DOCUMENT" | "VIDEO";
    return { kind, mimeType, fileName: `${tag("file")}.bin`, contentBase64: b64(magicBytes(k, size)), ...extra };
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    delete process.env["WAHA_BASE_URL"];
    delete process.env["WAHA_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    resetGatewayForTests();
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);

    // Default lane proof: nothing in this file installs a memory store — the
    // boot provider must have wired the persistent Pg backing.
    expect(currentOutboundAttachmentStore()).toBeInstanceOf(PgOutboundAttachmentStore);

    const register = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: `${tag("mail")}@example.com`, password: "correct-horse-8", tenantName: "Upload Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    tenantId = body.activeTenantId;
    userId = body.user.id;
    token = body.token;

    const person = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Upload Customer",
      identities: [{ identityType: "WHATSAPP", normalizedValue: "5511999990303" }],
    });
    if (!person.ok) {
      throw new Error(`person.register failed: ${JSON.stringify(person)}`);
    }
    const conv = await bus.execute<{ id: string }>(actor(), "conversation.start_manual", {
      personId: person.data.id,
      channel: "WHATSAPP",
    });
    if (!conv.ok) {
      throw new Error(`conversation.start_manual failed: ${JSON.stringify(conv)}`);
    }
    conversationId = conv.data.id;
  }, 120_000);

  afterAll(async () => {
    resetGatewayForTests();
    await app?.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
  });

  it("upload -> opaque ref -> send-media SENT end to end on the Pg lane", async () => {
    const uploaded = await inject({
      method: "POST",
      url: "/v1/communications/attachments",
      token,
      contentType: ATTACHMENT_UPLOAD_CONTENT_TYPE,
      payload: uploadPayload("IMAGE", "image/jpeg", 1024),
    });
    expect(uploaded.statusCode).toBe(201);
    const created = uploaded.json<{ attachmentRef: string; mimeType: string; sizeBytes: number }>();
    expect(created.attachmentRef).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
    expect(created).toMatchObject({ mimeType: "image/jpeg", sizeBytes: 1024 });

    const sent = await inject({
      method: "POST",
      url: `/v1/communications/conversations/${conversationId}/send-media`,
      token,
      payload: { kind: "IMAGE", attachmentRef: created.attachmentRef, mimeType: "image/jpeg", fileSizeBytes: 1024 },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ deliveryStatus: "SENT" });

    const rows = await db
      .selectFrom("platform.outbound_attachments")
      .select(["ref", "mime_type", "size_bytes"])
      .where("tenant_id", "=", tenantId)
      .where("ref", "=", created.attachmentRef)
      .execute();
    expect(rows).toHaveLength(1);

    const messages = await db
      .selectFrom("communication.messages")
      .select(["content_type", "attachment_ref"])
      .where("tenant_id", "=", tenantId)
      .where("conversation_id", "=", conversationId)
      .execute();
    expect(messages).toMatchObject([{ content_type: "IMAGE", attachment_ref: created.attachmentRef }]);
  });

  it("refuses a send with no prior upload and isolates refs per tenant", async () => {
    const unknown = await inject({
      method: "POST",
      url: `/v1/communications/conversations/${conversationId}/send-media`,
      token,
      payload: { kind: "IMAGE", attachmentRef: "att-never-uploaded-pg-0001", mimeType: "image/jpeg", fileSizeBytes: 16 },
    });
    expect(unknown.statusCode).toBe(400);

    const other = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: `${tag("mail")}@example.com`, password: "correct-horse-8", tenantName: "Upload Other" },
    });
    expect(other.statusCode).toBe(201);
    const otherBody = other.json<{ token: string; activeTenantId: string; user: { id: string } }>();

    const otherPerson = await bus.execute<{ id: string }>(
      actor(otherBody.activeTenantId, otherBody.user.id),
      "person.register",
      {
        canonicalName: "Upload Other Customer",
        identities: [{ identityType: "WHATSAPP", normalizedValue: "5511999990405" }],
      },
    );
    if (!otherPerson.ok) {
      throw new Error(`other person.register failed: ${JSON.stringify(otherPerson)}`);
    }
    const otherConv = await bus.execute<{ id: string }>(
      actor(otherBody.activeTenantId, otherBody.user.id),
      "conversation.start_manual",
      { personId: otherPerson.data.id, channel: "WHATSAPP" },
    );
    if (!otherConv.ok) {
      throw new Error(`other conversation.start_manual failed: ${JSON.stringify(otherConv)}`);
    }

    // Tenant A's ref is invisible to tenant B.
    const ownUpload = await db
      .selectFrom("platform.outbound_attachments")
      .select(["ref"])
      .where("tenant_id", "=", tenantId)
      .limit(1)
      .execute();
    expect(ownUpload.length).toBeGreaterThan(0);
    const cross = await inject({
      method: "POST",
      url: `/v1/communications/conversations/${otherConv.data.id}/send-media`,
      token: otherBody.token,
      payload: {
        kind: "IMAGE",
        attachmentRef: ownUpload[0]?.ref ?? "att-missing",
        mimeType: "image/jpeg",
        fileSizeBytes: 1024,
      },
    });
    expect(cross.statusCode).toBe(400);
    const foreign = await db
      .selectFrom("platform.outbound_attachments")
      .select(["ref"])
      .where("tenant_id", "=", otherBody.activeTenantId)
      .execute();
    expect(foreign).toHaveLength(0);
  });

  it("refuses oversized and MIME-mismatched uploads before persisting", async () => {
    const before = await db
      .selectFrom("platform.outbound_attachments")
      .select(["ref"])
      .where("tenant_id", "=", tenantId)
      .execute();

    const oversized = await inject({
      method: "POST",
      url: "/v1/communications/attachments",
      token,
      contentType: ATTACHMENT_UPLOAD_CONTENT_TYPE,
      payload: uploadPayload("IMAGE", "image/jpeg", 8 * 1024 * 1024 + 1),
    });
    expect(oversized.statusCode).toBe(400);

    // JPEG bytes declared as PNG: both allowlisted for IMAGE, contents differ.
    const mismatched = await inject({
      method: "POST",
      url: "/v1/communications/attachments",
      token,
      contentType: ATTACHMENT_UPLOAD_CONTENT_TYPE,
      payload: uploadPayload("IMAGE", "image/png", 64),
    });
    expect(mismatched.statusCode).toBe(400);

    const after = await db
      .selectFrom("platform.outbound_attachments")
      .select(["ref"])
      .where("tenant_id", "=", tenantId)
      .execute();
    expect(after).toHaveLength(before.length);
  });

  it("replays the same ref for the same idempotency key", async () => {
    const key = `upload-${tag("idem")}`;
    const payload = uploadPayload("DOCUMENT", "application/pdf", 512);
    const first = await inject({
      method: "POST",
      url: "/v1/communications/attachments",
      token,
      contentType: ATTACHMENT_UPLOAD_CONTENT_TYPE,
      idempotencyKey: key,
      payload,
    });
    expect(first.statusCode).toBe(201);
    const second = await inject({
      method: "POST",
      url: "/v1/communications/attachments",
      token,
      contentType: ATTACHMENT_UPLOAD_CONTENT_TYPE,
      idempotencyKey: key,
      payload,
    });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
  });

  it("scopes the raised body limit to the vendor media type (plain JSON keeps the 1 MiB default)", async () => {
    // Small plain-JSON uploads work: the route is transport-agnostic, only
    // the byte ceiling differs per content type.
    const small = await inject({
      method: "POST",
      url: "/v1/communications/attachments",
      token,
      contentType: "application/json",
      payload: uploadPayload("IMAGE", "image/jpeg", 64),
    });
    expect(small.statusCode).toBe(201);

    // ~2 MiB of real bytes (~2.8 MiB JSON) exceeds Fastify's 1 MiB default
    // parser: plain JSON is rejected before the handler, while the vendor
    // media type (48 MiB ceiling) accepts the same envelope.
    const big = uploadPayload("IMAGE", "image/jpeg", 2 * 1024 * 1024);
    const viaJson = await inject({
      method: "POST",
      url: "/v1/communications/attachments",
      token,
      contentType: "application/json",
      payload: big,
    });
    expect(viaJson.statusCode).toBe(413);
    const viaVendor = await inject({
      method: "POST",
      url: "/v1/communications/attachments",
      token,
      contentType: ATTACHMENT_UPLOAD_CONTENT_TYPE,
      payload: big,
    });
    expect(viaVendor.statusCode).toBe(201);
  });

  it("rate-limits the upload route per origin (30 admits, then 429 + Retry-After)", async () => {
    app.get(RateLimitService).resetAll();
    for (let i = 0; i < 30; i += 1) {
      const res = await inject({
        method: "POST",
        url: "/v1/communications/attachments",
        token,
        contentType: ATTACHMENT_UPLOAD_CONTENT_TYPE,
        payload: uploadPayload("IMAGE", "image/jpeg", 64),
      });
      expect(res.statusCode).toBe(201);
    }
    const blocked = await inject({
      method: "POST",
      url: "/v1/communications/attachments",
      token,
      contentType: ATTACHMENT_UPLOAD_CONTENT_TYPE,
      payload: uploadPayload("IMAGE", "image/jpeg", 64),
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });
});
