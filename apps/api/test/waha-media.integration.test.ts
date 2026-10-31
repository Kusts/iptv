import { createHash } from "node:crypto";
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
import { resetGatewayForTests } from "../src/communications/messaging-gateway.js";
import { PgInboundAttachmentStore } from "../src/communications/pg-inbound-attachment-store.js";
import { WahaWebhookService } from "../src/communications/waha-webhook.service.js";
import type {
  MediaDownloadResult,
  WahaMediaDescriptor,
  WahaMediaPort,
} from "../src/communications/waha-media.js";

/**
 * WAHA media/audio inbound (requires TEST_DATABASE_URL).
 *
 * Full-stack webhook → authorized ingest → conversation-linked persistence
 * with a CONTROLLED media double (no network, no live WhatsApp):
 * - verified downloads are validated against their REAL bytes (caps/MIME/
 *   magic-byte sniff), persisted tenant-scoped (`platform.inbound_attachments`,
 *   migration 062) under an opaque `in-` ref, and ingested as message rows
 *   with the real content type (IMAGE/AUDIO/DOCUMENT) + `attachment_ref` +
 *   `mediaMetadataFor` metadata (AUDIO keeps the explicit
 *   `transcription: PENDING_FOLLOW_UP` follow-up marker — no transcription
 *   pipeline exists yet);
 * - oversized, MIME-mismatched, unavailable, and failed downloads are acked
 *   (202) and recorded as OPEN exceptions — never message rows;
 * - unknown senders stay UNMATCHED (fail-closed): no message row, even after
 *   a verified download+store (the stored row stays tenant-scoped);
 * - duplicate webhooks never duplicate message rows (tenant-scoped dedupe);
 * - the same external id under another tenant lands on that tenant only.
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

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const WAHA_SECRET = "waha-media-secret";
const SENDER = "5511999990202";

/**
 * Controlled media double: only `https://waha.test/` artifacts exist;
 * `.../missing` simulates a provider-side failure. Everything else is
 * refused exactly like the fail-closed production port. Fetched bytes carry
 * REAL magic-byte signatures per kind so the inbound byte gate (sniff) can
 * pass on the happy path — exactly what production validates.
 */
const STUB_BYTES: Record<string, { bytes: Uint8Array; mimeType: string }> = {
  IMAGE: { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7]), mimeType: "image/jpeg" },
  AUDIO: { bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53, 7, 7, 7]), mimeType: "audio/ogg" },
  DOCUMENT: { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 7, 7, 7]), mimeType: "application/pdf" },
  VIDEO: {
    bytes: new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]),
    mimeType: "video/mp4",
  },
};

const stubMediaPort: WahaMediaPort = {
  name: "media-stub",
  async download(descriptor: WahaMediaDescriptor): Promise<MediaDownloadResult> {
    if (descriptor.mediaUrl === null) {
      return { ok: false, code: "media_unavailable", reason: "media url not reported by provider payload" };
    }
    if (!descriptor.mediaUrl.startsWith("https://waha.test/")) {
      return { ok: false, code: "media_unavailable", reason: "media host not allowlisted" };
    }
    if (descriptor.mediaUrl.includes("/missing")) {
      return { ok: false, code: "media_download_failed", reason: "media fetch HTTP 404" };
    }
    if (descriptor.contentType === "DOCUMENT" && descriptor.declaredMime !== "application/pdf") {
      return { ok: false, code: "media_invalid", reason: `mismatched MIME for DOCUMENT: ${descriptor.declaredMime}` };
    }
    if (descriptor.sizeBytes !== null && descriptor.sizeBytes > 16 * 1024 * 1024) {
      return { ok: false, code: "media_invalid", reason: `oversized ${descriptor.contentType}` };
    }
    const fixture = STUB_BYTES[descriptor.contentType];
    if (fixture === undefined) {
      return { ok: false, code: "media_invalid", reason: `unsupported stub content type: ${descriptor.contentType}` };
    }
    return {
      ok: true,
      fetched: {
        bytes: fixture.bytes,
        mimeType: descriptor.declaredMime ?? fixture.mimeType,
        sizeBytes: fixture.bytes.length,
      },
    };
  },
};

describe.skipIf(!hasDb)("WAHA media inbound (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let tenantId = "";
  let userId = "";
  let bus: CommandBus;

  const tenantKey = `wm-${tag("key")}`;
  const journey = { personId: "", conversationId: "" };

  function actor(): CommandActor {
    return {
      userId,
      isPlatformAdmin: false,
      tenantId,
      roleKeys: ["tenant_owner"],
      permissions: ["crm.person.read", "crm.lead.write", "conversation.reply"],
      actorType: "human",
    };
  }

  function inject(opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    secret?: string;
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
      headers["x-tenant-context-revision"] = "0";
    }
    if (opts.secret !== undefined) {
      headers["x-waha-secret"] = opts.secret;
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

  function mediaPayload(externalId: string, media: Record<string, unknown>, caption = "") {
    return {
      event: "message",
      session: "default",
      payload: {
        id: externalId,
        from: `${SENDER}@c.us`,
        fromMe: false,
        body: caption,
        caption: caption === "" ? undefined : caption,
        timestamp: 1758912000,
        ...media,
      },
    };
  }

  async function messagesByExternal(externalId: string, tenant: string = tenantId) {
    return db
      .selectFrom("communication.messages")
      .select(["id", "content_type", "attachment_ref", "conversation_id", "person_id", "metadata_json"])
      .where("tenant_id", "=", tenant)
      .where("external_message_id", "=", externalId)
      .execute();
  }

  async function exceptionByExternal(externalId: string) {
    return db
      .selectFrom("communication.exceptions")
      .select(["id", "status", "reason", "payload_json"])
      .where("tenant_id", "=", tenantId)
      .where("external_message_id", "=", externalId)
      .execute();
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
    // Test-only seam: swap the fail-closed production media port for the
    // controlled double on the singleton (no provider registration change).
    const webhooks = app.get(WahaWebhookService);
    (webhooks as unknown as { mediaPort: WahaMediaPort }).mediaPort = stubMediaPort;

    const register = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: `wm-${tag("mail")}@example.com`, password: "correct-horse-8", tenantName: "Media Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    tenantId = body.activeTenantId;
    userId = body.user.id;

    await db
      .insertInto("communication.tenant_channels")
      .values({
        id: newId(),
        tenant_id: tenantId,
        channel: "WHATSAPP",
        tenant_key: tenantKey,
        webhook_secret_hash: sha256Hex(WAHA_SECRET),
        status: "ACTIVE",
        waha_session_name: null,
        waha_status: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    const person = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Media Customer",
      identities: [{ identityType: "WHATSAPP", normalizedValue: SENDER }],
    });
    if (!person.ok) {
      throw new Error(`person.register failed: ${JSON.stringify(person)}`);
    }
    journey.personId = person.data.id;
    const conv = await bus.execute<{ id: string }>(actor(), "conversation.start_manual", {
      personId: journey.personId,
      channel: "WHATSAPP",
    });
    if (!conv.ok) {
      throw new Error(`conversation.start_manual failed: ${JSON.stringify(conv)}`);
    }
    journey.conversationId = conv.data.id;
  }, 120_000);

  afterAll(async () => {
    resetGatewayForTests();
    await app?.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
  });

  it("verified image persists bytes and ingests an IMAGE message with attachment_ref", async () => {
    const externalId = tag("wamsg-img");
    const res = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKey}`,
      secret: WAHA_SECRET,
      payload: mediaPayload(externalId, {
        type: "image",
        mediaUrl: "https://waha.test/api/files/img-0001.jpg",
        mimetype: "image/jpeg",
        fileSize: 120_000,
      }, "foto do medidor"),
    });
    expect(res.statusCode).toBe(202);
    // Bytes validated + persisted tenant-scoped: a real IMAGE message row
    // with an opaque `in-` ref (never a fabricated/unbacked ref).
    const rows = await messagesByExternal(externalId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content_type).toBe("IMAGE");
    const ref = rows[0]?.attachment_ref;
    expect(typeof ref).toBe("string");
    expect(ref?.startsWith("in-")).toBe(true);
    expect(rows[0]?.conversation_id).toBe(journey.conversationId);
    const metadata = rows[0]?.metadata_json as Record<string, unknown>;
    expect(metadata["mediaKind"]).toBe("IMAGE");
    expect(metadata["mimeType"]).toBe("image/jpeg");
    // Stored bytes round-trip tenant-scoped behind the ref.
    const stored = await new PgInboundAttachmentStore(db).resolve(tenantId, ref as string);
    expect(stored?.mimeType).toBe("image/jpeg");
    expect(stored?.fileName).toBeNull();
    expect(Array.from(stored?.bytes ?? [])).toEqual(Array.from(STUB_BYTES["IMAGE"]?.bytes ?? new Uint8Array()));
    expect(await exceptionByExternal(externalId)).toHaveLength(0);
  });

  it("verified audio persists bytes and ingests an AUDIO message with the transcription follow-up marker", async () => {
    const externalId = tag("wamsg-audio");
    const res = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKey}`,
      secret: WAHA_SECRET,
      payload: mediaPayload(externalId, {
        type: "ptt",
        mediaUrl: "https://waha.test/api/files/ptt-0001.ogg",
        mimetype: "audio/ogg",
        duration: 42,
      }),
    });
    expect(res.statusCode).toBe(202);
    const rows = await messagesByExternal(externalId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content_type).toBe("AUDIO");
    const ref = rows[0]?.attachment_ref;
    expect(typeof ref).toBe("string");
    expect(ref?.startsWith("in-")).toBe(true);
    const metadata = rows[0]?.metadata_json as Record<string, unknown>;
    expect(metadata["mediaKind"]).toBe("AUDIO");
    expect(metadata["durationSeconds"]).toBe(42);
    // The follow-up seam lives on message metadata: nothing claims a
    // transcription pipeline exists.
    expect(metadata["transcription"]).toEqual({ status: "PENDING_FOLLOW_UP", engine: null, transcriptRef: null });
    const stored = await new PgInboundAttachmentStore(db).resolve(tenantId, ref as string);
    expect(stored?.mimeType).toBe("audio/ogg");
    expect(Array.from(stored?.bytes ?? [])).toEqual(Array.from(STUB_BYTES["AUDIO"]?.bytes ?? new Uint8Array()));
    expect(await exceptionByExternal(externalId)).toHaveLength(0);
  });

  it("verified document persists bytes and ingests a DOCUMENT message with filename", async () => {
    const externalId = tag("wamsg-doc");
    const res = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKey}`,
      secret: WAHA_SECRET,
      payload: mediaPayload(externalId, {
        type: "document",
        mediaUrl: "https://waha.test/api/files/fatura-0001.pdf",
        mimetype: "application/pdf",
        filename: "fatura.pdf",
        fileSize: 55_000,
      }),
    });
    expect(res.statusCode).toBe(202);
    const rows = await messagesByExternal(externalId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content_type).toBe("DOCUMENT");
    const ref = rows[0]?.attachment_ref;
    expect(typeof ref).toBe("string");
    expect(ref?.startsWith("in-")).toBe(true);
    const metadata = rows[0]?.metadata_json as Record<string, unknown>;
    expect(metadata["mediaKind"]).toBe("DOCUMENT");
    expect(metadata["fileName"]).toBe("fatura.pdf");
    const stored = await new PgInboundAttachmentStore(db).resolve(tenantId, ref as string);
    expect(stored?.mimeType).toBe("application/pdf");
    expect(stored?.fileName).toBe("fatura.pdf");
    expect(await exceptionByExternal(externalId)).toHaveLength(0);
  });

  it("oversized file is acked but recorded as an exception, never a message", async () => {
    const externalId = tag("wamsg-big");
    const res = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKey}`,
      secret: WAHA_SECRET,
      payload: mediaPayload(externalId, {
        type: "image",
        mediaUrl: "https://waha.test/api/files/huge.jpg",
        mimetype: "image/jpeg",
        fileSize: 64 * 1024 * 1024,
      }),
    });
    expect(res.statusCode).toBe(202);
    expect(await messagesByExternal(externalId)).toHaveLength(0);
    const exceptions = await exceptionByExternal(externalId);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.status).toBe("OPEN");
    expect(exceptions[0]?.reason).toMatch(/^media_invalid/);
  });

  it("mismatched MIME is acked but recorded as an exception, never a message", async () => {
    const externalId = tag("wamsg-mime");
    const res = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKey}`,
      secret: WAHA_SECRET,
      payload: mediaPayload(externalId, {
        type: "document",
        mediaUrl: "https://waha.test/api/files/evil.html",
        mimetype: "text/html",
        filename: "evil.html",
      }),
    });
    expect(res.statusCode).toBe(202);
    expect(await messagesByExternal(externalId)).toHaveLength(0);
    const exceptions = await exceptionByExternal(externalId);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.reason).toMatch(/^media_invalid/);
  });

  it("unavailable media (no url) is acked but recorded as an exception", async () => {
    const externalId = tag("wamsg-nourl");
    const res = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKey}`,
      secret: WAHA_SECRET,
      payload: mediaPayload(externalId, { type: "audio" }),
    });
    expect(res.statusCode).toBe(202);
    expect(await messagesByExternal(externalId)).toHaveLength(0);
    const exceptions = await exceptionByExternal(externalId);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.reason).toMatch(/^media_unavailable/);
  });

  it("download failure is acked but recorded as an exception, never a message", async () => {
    const externalId = tag("wamsg-missing");
    const res = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKey}`,
      secret: WAHA_SECRET,
      payload: mediaPayload(externalId, {
        type: "image",
        mediaUrl: "https://waha.test/api/files/missing.jpg",
        mimetype: "image/jpeg",
      }),
    });
    expect(res.statusCode).toBe(202);
    expect(await messagesByExternal(externalId)).toHaveLength(0);
    const exceptions = await exceptionByExternal(externalId);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.reason).toMatch(/^media_download_failed/);
  });

  it("duplicate media webhook never duplicates the message row", async () => {
    const externalId = tag("wamsg-dup");
    const payload = mediaPayload(externalId, {
      type: "image",
      mediaUrl: "https://waha.test/api/files/dup.jpg",
      mimetype: "image/jpeg",
      fileSize: 9000,
    });
    const first = await inject({ method: "POST", url: `/v1/webhooks/waha/${tenantKey}`, secret: WAHA_SECRET, payload });
    expect(first.statusCode).toBe(202);
    const second = await inject({ method: "POST", url: `/v1/webhooks/waha/${tenantKey}`, secret: WAHA_SECRET, payload });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ accepted: true, deduped: true });
    const rows = await messagesByExternal(externalId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content_type).toBe("IMAGE");
    expect(await exceptionByExternal(externalId)).toHaveLength(0);
  });

  it("media from an unknown sender stays UNMATCHED (fail-closed, never a message row)", async () => {
    const externalId = tag("wamsg-unknown");
    const res = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${tenantKey}`,
      secret: WAHA_SECRET,
      payload: {
        event: "message",
        session: "default",
        payload: {
          id: externalId,
          from: "5511999990303@c.us",
          fromMe: false,
          body: "",
          timestamp: 1758912000,
          type: "image",
          mediaUrl: "https://waha.test/api/files/unknown.jpg",
          mimetype: "image/jpeg",
        },
      },
    });
    expect(res.statusCode).toBe(202);
    expect(await messagesByExternal(externalId)).toHaveLength(0);
    const exceptions = await exceptionByExternal(externalId);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.status).toBe("OPEN");
    expect(exceptions[0]?.reason).toMatch(/no matching person or conversation/);
  });

  it("the same external id under another tenant is isolated to that tenant", async () => {
    const other = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: `wm-other-${tag("mail")}@example.com`, password: "correct-horse-8", tenantName: "Media Other" },
    });
    expect(other.statusCode).toBe(201);
    const otherBody = other.json<{ token: string; activeTenantId: string }>();
    const otherKey = `wm-other-${tag("key")}`;
    await db
      .insertInto("communication.tenant_channels")
      .values({
        id: newId(),
        tenant_id: otherBody.activeTenantId,
        channel: "WHATSAPP",
        tenant_key: otherKey,
        webhook_secret_hash: sha256Hex(WAHA_SECRET),
        status: "ACTIVE",
        waha_session_name: null,
        waha_status: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    // No person/conversation exists there: the verified media download
    // persists under the OTHER tenant, then quarantines as UNMATCHED under
    // the OTHER tenant — nothing lands here.
    const externalId = tag("wamsg-xtenant");
    const res = await inject({
      method: "POST",
      url: `/v1/webhooks/waha/${otherKey}`,
      secret: WAHA_SECRET,
      payload: mediaPayload(externalId, {
        type: "image",
        mediaUrl: "https://waha.test/api/files/x.jpg",
        mimetype: "image/jpeg",
        fileSize: 1000,
      }),
    });
    expect(res.statusCode).toBe(202);
    expect(await messagesByExternal(externalId, tenantId)).toHaveLength(0);
    const foreign = await db
      .selectFrom("communication.exceptions")
      .select(["id"])
      .where("tenant_id", "=", otherBody.activeTenantId)
      .where("external_message_id", "=", externalId)
      .execute();
    expect(foreign).toHaveLength(1);
  });
});
