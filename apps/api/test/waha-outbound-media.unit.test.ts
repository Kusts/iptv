import { afterEach, describe, expect, it } from "vitest";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../src/commands/command-bus.js";
import { registerCrmCommands } from "../src/crm/crm.commands.js";
import {
  GatewayUnknownError,
  LocalEchoGateway,
  SEND_MEDIA_ENDPOINT,
  WahaGatewayAdapter,
  resetGatewayForTests,
  setGatewayForTests,
  tracedGateway,
  type MessagingGatewayPort,
  type SendMediaInput,
  type SendMediaResult,
} from "../src/communications/messaging-gateway.js";
import { registerCommunicationCommands } from "../src/communications/communications.commands.js";
import {
  MemoryOutboundAttachmentStore,
  resetOutboundAttachmentStoreForTests,
  setOutboundAttachmentStoreForTests,
} from "../src/communications/waha-outbound-attachments.js";
import { getRiskState } from "../src/communications/waha-risk-state.js";
import { bindSession, clearSessionBindingsForTests } from "../src/communications/waha-sessions.js";
import { memoryStateOf } from "../src/crm/wave2-store.js";
import type { CommandHandlerContext } from "../src/commands/command-bus.js";
import { MemoryDb } from "./fakes/memory-fakes.js";

/**
 * WAHA outbound media/áudio (test-only doubles, zero network): kind →
 * endpoint mapping with the `sendText` transport taxonomy, command guards
 * (caps/MIME/áudio 600 s/áudio exige autorização), OUTBOUND com
 * `content_type`/`attachment_ref` reais, UNKNOWN→QUEUED+PAUSED sem
 * blind-retry. `sendText`/G01 intactos (nenhum teste aqui toca texto).
 *
 * Deterministic fixtures: counters only, never UUID-head slices.
 */

const TENANT = "33333333-3333-4333-8333-333333333333";

function actor(tenantId: string = TENANT): CommandActor {
  return {
    userId: "44444444-4444-4444-8444-444444444444",
    isPlatformAdmin: false,
    tenantId,
    roleKeys: ["tenant_owner"],
    permissions: ["crm.person.read", "crm.lead.write", "conversation.reply"],
    actorType: "human",
  };
}

function setup() {
  const db = new MemoryDb();
  const bus = new CommandBus(db);
  registerCrmCommands(bus);
  registerCommunicationCommands(bus);
  const store = new MemoryOutboundAttachmentStore();
  setOutboundAttachmentStoreForTests(store);
  return { db, bus, store };
}

/** Real-bytes fixtures: correct magic headers so the sniff gate passes. */
function magicBytes(kind: string, size: number): Uint8Array {
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

function registerAttachment(
  store: MemoryOutboundAttachmentStore,
  ref: string,
  kind: "IMAGE" | "DOCUMENT" | "AUDIO" | "VIDEO",
  mimeType: string,
  size: number,
): void {
  store.register({
    tenantId: TENANT,
    ref,
    kind,
    mimeType,
    fileName: `${ref}.bin`,
    bytes: magicBytes(kind, size),
  });
}

/** Wave 2 in-memory rows behind a tenant tx (keyed by the tx object, like the handlers see it). */
function wave2State(db: MemoryDb, tenantId: string = TENANT) {
  const state = memoryStateOf({ tx: db.txFor(tenantId) } as unknown as CommandHandlerContext);
  if (state === null) {
    throw new Error("no Wave 2 state available");
  }
  return state;
}

async function registerPerson(bus: CommandBus) {
  return (await bus.execute<{ id: string }>(actor(), "person.register", {
    canonicalName: "Media Customer",
    identities: [{ identityType: "WHATSAPP", normalizedValue: "5511999990202" }],
  })) as { ok: true; data: { id: string } };
}

async function startConversation(bus: CommandBus, personId: string) {
  return bus.execute<{ id: string }>(actor(), "conversation.start_manual", {
    personId,
    channel: "WHATSAPP",
  });
}

function mediaPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    kind: "IMAGE",
    attachmentRef: "att-ref-image-0001",
    mimeType: "image/jpeg",
    fileName: "photo.jpg",
    caption: "olá",
    fileSizeBytes: 1024,
    ...overrides,
  };
}

interface RecordedFetch {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

function stubFetch(handler: (url: string) => Response): {
  fetchImpl: typeof fetch;
  calls: RecordedFetch[];
} {
  const calls: RecordedFetch[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: {
        method: init?.method,
        headers: init?.headers as Record<string, string>,
        body: init?.body as string,
      },
    });
    return handler(String(url));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  resetGatewayForTests();
  clearSessionBindingsForTests();
  resetOutboundAttachmentStoreForTests();
});

describe("waha outbound media adapter (fetch stub, zero network)", () => {
  it("maps kinds to endpoints (IMAGE→sendImage, DOCUMENT→sendFile, AUDIO→sendVoice, VIDEO→sendVideo)", async () => {
    expect(SEND_MEDIA_ENDPOINT).toEqual({
      IMAGE: "sendImage",
      DOCUMENT: "sendFile",
      AUDIO: "sendVoice",
      VIDEO: "sendVideo",
    });
    const store = new MemoryOutboundAttachmentStore();
    setOutboundAttachmentStoreForTests(store);
    const mimeFor = { IMAGE: "image/jpeg", DOCUMENT: "application/pdf", AUDIO: "audio/ogg", VIDEO: "video/mp4" } as const;
    const kinds = ["IMAGE", "DOCUMENT", "AUDIO", "VIDEO"] as const;
    for (const kind of kinds) {
      store.register({
        tenantId: TENANT,
        ref: `att-${kind}`,
        kind,
        mimeType: mimeFor[kind],
        fileName: "f.bin",
        bytes: magicBytes(kind, 64),
      });
    }
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { id: "wamsg-media-1" }));
    const adapter = new WahaGatewayAdapter("http://127.0.0.1:9", "stub-key", "default", 3000, fetchImpl);
    for (const kind of kinds) {
      const result = await adapter.sendMedia({
        tenantId: TENANT,
        conversationId: newId(),
        to: "5511999990202@c.us",
        kind,
        attachmentRef: `att-${kind}`,
        mimeType: mimeFor[kind],
        fileName: "f.bin",
        caption: null,
        durationSeconds: null,
      });
      expect(result).toEqual({ ok: true, providerMessageId: "wamsg-media-1" });
    }
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:9/api/sendImage",
      "http://127.0.0.1:9/api/sendFile",
      "http://127.0.0.1:9/api/sendVoice",
      "http://127.0.0.1:9/api/sendVideo",
    ]);
    const first = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(first["chatId"]).toBe("5511999990202@c.us");
    expect(first["session"]).toBe("default");
    expect(calls[0]?.init.headers?.["X-Api-Key"]).toBe("stub-key");
    expect(first["file"]).toMatchObject({ url: "att-IMAGE", mimetype: "image/jpeg" });
  });

  it("maps 429→CAPPED and non-2xx→FAILED", async () => {
    const store = new MemoryOutboundAttachmentStore();
    setOutboundAttachmentStoreForTests(store);
    store.register({
      tenantId: TENANT,
      ref: "att-1",
      kind: "IMAGE",
      mimeType: "image/jpeg",
      fileName: "f.bin",
      bytes: magicBytes("IMAGE", 64),
    });
    store.register({
      tenantId: TENANT,
      ref: "att-2",
      kind: "VIDEO",
      mimeType: "video/mp4",
      fileName: "f.bin",
      bytes: magicBytes("VIDEO", 64),
    });
    const capped = stubFetch(() => jsonResponse(429, { message: "slow down" }));
    const cappedAdapter = new WahaGatewayAdapter("http://127.0.0.1:9", "k", "default", 3000, capped.fetchImpl);
    await expect(
      cappedAdapter.sendMedia({
        tenantId: TENANT,
        conversationId: newId(),
        to: "5511999990202@c.us",
        kind: "IMAGE",
        attachmentRef: "att-1",
        mimeType: "image/jpeg",
        fileName: null,
        caption: null,
        durationSeconds: null,
      }),
    ).resolves.toMatchObject({ ok: false, code: "CAPPED" });

    const failed = stubFetch(() => jsonResponse(500, { message: "boom" }));
    const failedAdapter = new WahaGatewayAdapter("http://127.0.0.1:9", "k", "default", 3000, failed.fetchImpl);
    await expect(
      failedAdapter.sendMedia({
        tenantId: TENANT,
        conversationId: newId(),
        to: "5511999990202@c.us",
        kind: "VIDEO",
        attachmentRef: "att-2",
        mimeType: "video/mp4",
        fileName: null,
        caption: null,
        durationSeconds: null,
      }),
    ).resolves.toMatchObject({ ok: false, code: "FAILED" });
  });

  it("surfaces abort as UNKNOWN and 2xx-without-id as UNKNOWN (never invents an id)", async () => {
    const store = new MemoryOutboundAttachmentStore();
    setOutboundAttachmentStoreForTests(store);
    store.register({
      tenantId: TENANT,
      ref: "att-a",
      kind: "AUDIO",
      mimeType: "audio/ogg",
      fileName: null,
      bytes: magicBytes("AUDIO", 64),
    });
    store.register({
      tenantId: TENANT,
      ref: "att-d",
      kind: "DOCUMENT",
      mimeType: "application/pdf",
      fileName: null,
      bytes: magicBytes("DOCUMENT", 64),
    });
    const abortImpl = (async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    const abortAdapter = new WahaGatewayAdapter("http://127.0.0.1:9", "k", "default", 3000, abortImpl);
    await expect(
      abortAdapter.sendMedia({
        tenantId: TENANT,
        conversationId: newId(),
        to: "5511999990202@c.us",
        kind: "AUDIO",
        attachmentRef: "att-a",
        mimeType: "audio/ogg",
        fileName: null,
        caption: null,
        durationSeconds: 12,
      }),
    ).rejects.toBeInstanceOf(GatewayUnknownError);

    const noid = stubFetch(() => jsonResponse(200, { noId: true }));
    const noidAdapter = new WahaGatewayAdapter("http://127.0.0.1:9", "k", "default", 3000, noid.fetchImpl);
    await expect(
      noidAdapter.sendMedia({
        tenantId: TENANT,
        conversationId: newId(),
        to: "5511999990202@c.us",
        kind: "DOCUMENT",
        attachmentRef: "att-d",
        mimeType: "application/pdf",
        fileName: null,
        caption: null,
        durationSeconds: null,
      }),
    ).rejects.toBeInstanceOf(GatewayUnknownError);
  });

  it("refuses a session-mismatched send without touching the network", async () => {
    bindSession(TENANT, "tenant-a-session");
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { id: "wamsg-never" }));
    const adapter = new WahaGatewayAdapter("http://127.0.0.1:9", "k", "tenant-a-session", 3000, fetchImpl);
    const result = await adapter.sendMedia({
      tenantId: TENANT,
      conversationId: newId(),
      to: "5511999990202@c.us",
      kind: "IMAGE",
      attachmentRef: "att-x",
      mimeType: "image/jpeg",
      fileName: null,
      caption: null,
      durationSeconds: null,
      session: "tenant-b-session",
    });
    expect(result).toMatchObject({ ok: false, code: "SESSION_MISMATCH" });
    expect(calls).toHaveLength(0);
  });

  it("echo gateway records media sends with echo ids", async () => {
    const echo = new LocalEchoGateway();
    const result = await echo.sendMedia({
      tenantId: TENANT,
      conversationId: newId(),
      to: "5511999990202@c.us",
      kind: "IMAGE",
      attachmentRef: "att-echo",
      mimeType: "image/png",
      fileName: "e.png",
      caption: "hi",
      durationSeconds: null,
    });
    expect(result.ok).toBe(true);
    expect(echo.sentMediaInputs).toHaveLength(1);
    expect(echo.sentInputs).toHaveLength(0);
  });

  it("tracedGateway forwards sendMedia and preserves legacy doubles without it", async () => {
    const withMedia: MessagingGatewayPort = {
      name: "with-media",
      async sendText() {
        return { ok: true, providerMessageId: "t" };
      },
      async sendMedia(input: SendMediaInput): Promise<SendMediaResult> {
        return { ok: true, providerMessageId: `media:${input.kind}` };
      },
    };
    const traced = tracedGateway(withMedia);
    await expect(
      traced.sendMedia?.({
        tenantId: TENANT,
        conversationId: newId(),
        to: "5511999990202@c.us",
        kind: "VIDEO",
        attachmentRef: "att-v",
        mimeType: "video/mp4",
        fileName: null,
        caption: null,
        durationSeconds: null,
      }),
    ).resolves.toEqual({ ok: true, providerMessageId: "media:VIDEO" });

    const legacy: MessagingGatewayPort = {
      name: "legacy-text-only",
      async sendText() {
        return { ok: true, providerMessageId: "t" };
      },
    };
    expect(tracedGateway(legacy).sendMedia).toBeUndefined();
  });
});

describe("message.send_media_manual command (MemoryDb chain)", () => {
  it("persists OUTBOUND with real content_type/attachment_ref, SENT delivery and message.sent.v1", async () => {
    const { db, bus, store } = setup();
    registerAttachment(store, "att-ref-image-0001", "IMAGE", "image/jpeg", 1024);
    const sent: SendMediaInput[] = [];
    setGatewayForTests({
      name: "media-recording",
      async sendText() {
        return { ok: true, providerMessageId: "text-unused" };
      },
      async sendMedia(input: SendMediaInput): Promise<SendMediaResult> {
        sent.push(input);
        return { ok: true, providerMessageId: "media-confirm-1" };
      },
    });
    const person = await registerPerson(bus);
    const conv = (await startConversation(bus, person.data.id)) as { ok: true; data: { id: string } };
    const result = await bus.execute(actor(), "message.send_media_manual", {
      conversationId: conv.data.id,
      ...mediaPayload(),
    });
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ ok: true, data: { deliveryStatus: "SENT", providerMessageId: "media-confirm-1" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "IMAGE", attachmentRef: "att-ref-image-0001", session: "default" });

    const state = wave2State(db);
    const rows = [...state.messages.values()].filter((m) => m.direction === "OUTBOUND");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contentType: "IMAGE", attachmentRef: "att-ref-image-0001", bodyText: "olá" });
    expect(state.deliveries).toMatchObject([
      { status: "SENT", externalDeliveryId: "media-confirm-1", errorCode: null },
    ]);
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("message.sent.v1");
  });

  it("refuses audio without customer authorization before any send", async () => {
    const { db, bus } = setup();
    let calls = 0;
    setGatewayForTests({
      name: "media-never",
      async sendText() {
        return { ok: true, providerMessageId: "t" };
      },
      async sendMedia(): Promise<SendMediaResult> {
        calls += 1;
        return { ok: true, providerMessageId: "never" };
      },
    });
    const person = await registerPerson(bus);
    const conv = (await startConversation(bus, person.data.id)) as { ok: true; data: { id: string } };
    const result = await bus.execute(actor(), "message.send_media_manual", {
      conversationId: conv.data.id,
      kind: "AUDIO",
      attachmentRef: "att-audio-1",
      mimeType: "audio/ogg",
      durationSeconds: 30,
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, code: "validation_failed" });
    expect(calls).toBe(0);
    expect([...wave2State(db).messages.values()]).toHaveLength(0);
  });

  it("refuses oversized media, MIME mismatch and overlong audio", async () => {
    const { bus, store } = setup();
    registerAttachment(store, "att-audio-3", "AUDIO", "audio/ogg", 512);
    setGatewayForTests({
      name: "media-never",
      async sendText() {
        return { ok: true, providerMessageId: "t" };
      },
      async sendMedia(): Promise<SendMediaResult> {
        return { ok: true, providerMessageId: "never" };
      },
    });
    const person = await registerPerson(bus);
    const conv = (await startConversation(bus, person.data.id)) as { ok: true; data: { id: string } };

    const oversized = await bus.execute(actor(), "message.send_media_manual", {
      conversationId: conv.data.id,
      ...mediaPayload({ fileSizeBytes: 8 * 1024 * 1024 + 1 }),
    });
    expect(oversized).toMatchObject({ ok: false, code: "validation_failed" });

    const mime = await bus.execute(actor(), "message.send_media_manual", {
      conversationId: conv.data.id,
      ...mediaPayload({ mimeType: "application/pdf" }),
    });
    expect(mime).toMatchObject({ ok: false, code: "validation_failed" });

    const longAudio = await bus.execute(actor(), "message.send_media_manual", {
      conversationId: conv.data.id,
      kind: "AUDIO",
      attachmentRef: "att-audio-2",
      mimeType: "audio/ogg",
      durationSeconds: 601,
      customerAuthorized: true,
    });
    expect(longAudio).toMatchObject({ ok: false, code: "validation_failed" });

    const consented = await bus.execute(actor(), "message.send_media_manual", {
      conversationId: conv.data.id,
      kind: "AUDIO",
      attachmentRef: "att-audio-3",
      mimeType: "audio/ogg",
      durationSeconds: 600,
      customerAuthorized: true,
    });
    expect(consented.ok).toBe(true);
  });

  it("parks UNKNOWN media as QUEUED+PAUSED and refuses blind resend until reconcile", async () => {
    const { db, bus, store } = setup();
    registerAttachment(store, "att-ref-image-0001", "IMAGE", "image/jpeg", 1024);
    registerAttachment(store, "att-ref-image-0002", "IMAGE", "image/jpeg", 1024);
    let calls = 0;
    setGatewayForTests({
      name: "media-unknown",
      async sendText() {
        return { ok: true, providerMessageId: "t" };
      },
      async sendMedia(): Promise<SendMediaResult> {
        calls += 1;
        throw new GatewayUnknownError();
      },
    });
    const person = await registerPerson(bus);
    const conv = (await startConversation(bus, person.data.id)) as { ok: true; data: { id: string } };
    const uncertain = await bus.execute(actor(), "message.send_media_manual", {
      conversationId: conv.data.id,
      ...mediaPayload(),
    });
    expect(uncertain).toMatchObject({ ok: true, data: { deliveryStatus: "QUEUED", providerMessageId: null } });
    expect(calls).toBe(1);
    const state = wave2State(db);
    expect(state.deliveries).toMatchObject([{ status: "QUEUED", errorCode: "UNKNOWN_EFFECT" }]);
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("conversation.paused.v1");
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).not.toContain("message.sent.v1");

    const replay = await bus.execute(actor(), "message.send_media_manual", {
      conversationId: conv.data.id,
      ...mediaPayload({ attachmentRef: "att-ref-image-0002" }),
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.message).toMatch(/reconcile_required/);
    }
    expect(calls).toBe(1);
  });

  it("records provider CAPPED on media and marks risk", async () => {
    const { db, bus, store } = setup();
    registerAttachment(store, "att-doc-1", "DOCUMENT", "application/pdf", 512);
    setGatewayForTests({
      name: "media-capped",
      async sendText() {
        return { ok: true, providerMessageId: "t" };
      },
      async sendMedia(): Promise<SendMediaResult> {
        return { ok: false, code: "CAPPED", message: "timelock" };
      },
    });
    const person = await registerPerson(bus);
    const conv = (await startConversation(bus, person.data.id)) as { ok: true; data: { id: string } };
    const result = await bus.execute(actor(), "message.send_media_manual", {
      conversationId: conv.data.id,
      kind: "DOCUMENT",
      attachmentRef: "att-doc-1",
      mimeType: "application/pdf",
      fileSizeBytes: 512,
    });
    expect(result).toMatchObject({ ok: true, data: { deliveryStatus: "FAILED" } });
    expect(wave2State(db).deliveries).toMatchObject([{ status: "FAILED", errorCode: "CAPPED" }]);
    expect(getRiskState(TENANT, "WHATSAPP")).toBe("CAPPED");
  });
});
