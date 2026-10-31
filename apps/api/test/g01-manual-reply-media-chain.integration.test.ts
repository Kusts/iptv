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
import {
  GatewayUnknownError,
  resetGatewayForTests,
  setGatewayForTests,
  type SendMediaInput,
  type SendMediaResult,
  type SendTextInput,
  type SendTextResult,
} from "../src/communications/messaging-gateway.js";
import {
  MemoryOutboundAttachmentStore,
  resetOutboundAttachmentStoreForTests,
  setOutboundAttachmentStoreForTests,
} from "../src/communications/waha-outbound-attachments.js";

/**
 * G01-clone media chain on a CONTROLLED adapter (no live WhatsApp actions,
 * no network, disposable TEST_DATABASE_URL only):
 *
 * manual media reply (`POST send-media`) → adapter sendMedia → verifiable
 * delivery confirmation on the SAME conversation, then UNKNOWN parks
 * QUEUED+PAUSED and replay is refused until reconcile.
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

const WAHA_FIXTURE_TOKEN = "g01-media test fixture, not a credential";
const SENDER = "5511999990303";

/** Controlled adapter: records text + media sends, returns verifiable confirmations. */
const sentTexts: SendTextInput[] = [];
const sentMedia: SendMediaInput[] = [];
const recordingGateway = {
  name: "g01-media-recording",
  async sendText(input: SendTextInput): Promise<SendTextResult> {
    sentTexts.push(input);
    return { ok: true, providerMessageId: `g01-media-text-${sentTexts.length}` };
  },
  async sendMedia(input: SendMediaInput): Promise<SendMediaResult> {
    sentMedia.push(input);
    return { ok: true, providerMessageId: `g01-media-confirm-${sentMedia.length}` };
  },
};

let unknownCalls = 0;
const unknownGateway = {
  name: "g01-media-unknown",
  async sendText(): Promise<SendTextResult> {
    unknownCalls += 1;
    throw new GatewayUnknownError();
  },
  async sendMedia(): Promise<SendMediaResult> {
    unknownCalls += 1;
    throw new GatewayUnknownError();
  },
};

describe.skipIf(!hasDb)("G01-clone media chain (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let token = "";
  let tenantId = "";
  let userId = "";

  const tenantKey = `g01-media-${tag("key")}`;
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
    payload?: Record<string, unknown>;
    idempotencyKey?: string;
  }) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
      headers["x-tenant-context-revision"] = "0";
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

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    delete process.env["WAHA_BASE_URL"];
    delete process.env["WAHA_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    setGatewayForTests(recordingGateway);
    // Tenant-scoped outbound attachment registry (FIX-WAHA-OUTBOUND):
    // opaque refs only — resolved server-side before persist/send.
    const outboundStore = new MemoryOutboundAttachmentStore();
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    const bus = app.get(CommandBus);

    const register = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: `g01-media-${tag("mail")}@example.com`, password: "correct-horse-8", tenantName: "G01 Media Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;

    await db
      .insertInto("communication.tenant_channels")
      .values({
        id: newId(),
        tenant_id: tenantId,
        channel: "WHATSAPP",
        tenant_key: tenantKey,
        webhook_secret_hash: sha256Hex(WAHA_FIXTURE_TOKEN),
        status: "ACTIVE",
        waha_session_name: null,
        waha_status: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    const person = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "G01 Media Customer",
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
    const imageBytes = new Uint8Array(2048);
    imageBytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
    outboundStore.register({
      tenantId,
      ref: "att-g01-image-0001",
      kind: "IMAGE",
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      bytes: imageBytes,
    });
    for (const ref of ["att-g01-doc-0001", "att-g01-doc-0002"]) {
      const pdfBytes = new Uint8Array(512);
      pdfBytes.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0);
      outboundStore.register({
        tenantId,
        ref,
        kind: "DOCUMENT",
        mimeType: "application/pdf",
        fileName: "doc.pdf",
        bytes: pdfBytes,
      });
    }
    setOutboundAttachmentStoreForTests(outboundStore);
  }, 120_000);

  afterAll(async () => {
    resetGatewayForTests();
    resetOutboundAttachmentStoreForTests();
    await app?.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
  });

  it("manual media reply delivers on the SAME conversation with real content_type/attachment_ref", async () => {
    const sent = await inject({
      method: "POST",
      url: `/v1/communications/conversations/${journey.conversationId}/send-media`,
      token,
      idempotencyKey: `g01-media-${tag("idem")}`,
      payload: {
        kind: "IMAGE",
        attachmentRef: "att-g01-image-0001",
        mimeType: "image/jpeg",
        fileName: "photo.jpg",
        caption: "segue a foto",
        fileSizeBytes: 2048,
      },
    });
    expect(sent.statusCode).toBe(201);
    const body = sent.json<{ messageId: string; deliveryStatus: string; providerMessageId: string }>();
    expect(body.deliveryStatus).toBe("SENT");
    expect(body.providerMessageId).toBe("g01-media-confirm-1");

    expect(sentMedia).toHaveLength(1);
    expect(sentMedia[0]).toMatchObject({
      tenantId,
      kind: "IMAGE",
      attachmentRef: "att-g01-image-0001",
      session: "default",
    });
    // Text path untouched: no text send leaked through the media command.
    expect(sentTexts).toHaveLength(0);

    const outbound = await db
      .selectFrom("communication.messages")
      .select(["id", "direction", "conversation_id", "content_type", "attachment_ref", "body_text"])
      .where("tenant_id", "=", tenantId)
      .where("conversation_id", "=", journey.conversationId)
      .where("direction", "=", "OUTBOUND")
      .execute();
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({
      content_type: "IMAGE",
      attachment_ref: "att-g01-image-0001",
      body_text: "segue a foto",
    });
    const delivery = await db
      .selectFrom("communication.message_deliveries")
      .select(["status", "external_delivery_id", "error_code"])
      .where("tenant_id", "=", tenantId)
      .where("message_id", "=", outbound[0]?.id as string)
      .execute();
    expect(delivery).toMatchObject([{ status: "SENT", external_delivery_id: "g01-media-confirm-1", error_code: null }]);
  });

  it("audio without customer authorization is refused before any send", async () => {
    const refused = await inject({
      method: "POST",
      url: `/v1/communications/conversations/${journey.conversationId}/send-media`,
      token,
      payload: {
        kind: "AUDIO",
        attachmentRef: "att-g01-audio-noconsent",
        mimeType: "audio/ogg",
        durationSeconds: 20,
      },
    });
    // Zod-level refusal surfaces as HTTP 400 via the bus; the
    // `customerAuthorized` detail is proven at command level in unit tests.
    expect(refused.statusCode).toBe(400);
    expect(sentMedia).toHaveLength(1);
  });

  it("gateway UNKNOWN parks media QUEUED+PAUSED and replay is refused until reconcile", async () => {
    setGatewayForTests(unknownGateway);
    try {
      const uncertain = await inject({
        method: "POST",
        url: `/v1/communications/conversations/${journey.conversationId}/send-media`,
        token,
        payload: {
          kind: "DOCUMENT",
          attachmentRef: "att-g01-doc-0001",
          mimeType: "application/pdf",
          fileSizeBytes: 512,
        },
      });
      expect(uncertain.statusCode).toBe(201);
      expect(uncertain.json<{ deliveryStatus: string }>().deliveryStatus).toBe("QUEUED");
    } finally {
      setGatewayForTests(recordingGateway);
    }
    expect(unknownCalls).toBe(1);
    expect(sentMedia).toHaveLength(1);

    const deliveries = await db
      .selectFrom("communication.message_deliveries")
      .select(["status", "error_code"])
      .where("tenant_id", "=", tenantId)
      .orderBy("occurred_at", "asc")
      .execute();
    const outbound = deliveries.filter((d) => d.status !== "DELIVERED");
    expect(outbound).toMatchObject([
      { status: "SENT", error_code: null },
      { status: "QUEUED", error_code: "UNKNOWN_EFFECT" },
    ]);
    const convRow = await db
      .selectFrom("communication.conversations")
      .select(["control_mode"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", journey.conversationId)
      .executeTakeFirstOrThrow();
    expect(convRow.control_mode).toBe("PAUSED");

    const replay = await inject({
      method: "POST",
      url: `/v1/communications/conversations/${journey.conversationId}/send-media`,
      token,
      payload: {
        kind: "DOCUMENT",
        attachmentRef: "att-g01-doc-0002",
        mimeType: "application/pdf",
        fileSizeBytes: 512,
      },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json<{ message: string }>().message).toMatch(/reconcile_required/);
    expect(sentMedia).toHaveLength(1);
    expect(unknownCalls).toBe(1);
  });
});
