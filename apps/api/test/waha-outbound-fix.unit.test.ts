import { afterEach, describe, expect, it } from "vitest";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../src/commands/command-bus.js";
import { registerCrmCommands } from "../src/crm/crm.commands.js";
import {
  MEDIA_MAX_BYTES,
} from "../src/communications/waha-media.js";
import {
  WahaGatewayAdapter,
} from "../src/communications/messaging-gateway.js";
import { registerCommunicationCommands } from "../src/communications/communications.commands.js";
import {
  MemoryOutboundAttachmentStore,
  resetOutboundAttachmentStoreForTests,
  setOutboundAttachmentStoreForTests,
} from "../src/communications/waha-outbound-attachments.js";
import { resetGatewayForTests, setGatewayForTests, type SendMediaResult } from "../src/communications/messaging-gateway.js";
import { clearSessionBindingsForTests } from "../src/communications/waha-sessions.js";
import { memoryStateOf } from "../src/crm/wave2-store.js";
import type { CommandHandlerContext } from "../src/commands/command-bus.js";
import { MemoryDb } from "./fakes/memory-fakes.js";

/**
 * FIX-WAHA-OUTBOUND negatives (unit, zero network):
 * - SSRF: free-URL `attachmentRef` refused before persist/send (incl.
 *   adapter defense-in-depth with zero fetch calls), unknown and
 *   cross-tenant refs refused;
 * - real caps/MIME: declared-small-but-really-oversized refused, declared
 *   MIME/size mismatches vs the registered record refused, sniffed-content
 *   mismatch refused;
 * - UNKNOWN gateway *result* parks QUEUED + PAUSED exactly like a thrown
 *   `GatewayUnknownError` (no message.sent.v1, blind resend refused).
 */

const TENANT = "55555555-5555-4555-8555-555555555555";
const OTHER_TENANT = "66666666-6666-4666-8666-666666666666";

function actor(tenantId: string = TENANT): CommandActor {
  return {
    userId: "77777777-7777-4777-8777-777777777777",
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

function wave2State(db: MemoryDb, tenantId: string = TENANT) {
  const state = memoryStateOf({ tx: db.txFor(tenantId) } as unknown as CommandHandlerContext);
  if (state === null) {
    throw new Error("no Wave 2 state available");
  }
  return state;
}

async function startChain(bus: CommandBus) {
  const person = (await bus.execute<{ id: string }>(actor(), "person.register", {
    canonicalName: "Outbound Fix Customer",
    identities: [{ identityType: "WHATSAPP", normalizedValue: "5511999990404" }],
  })) as { ok: true; data: { id: string } };
  const conv = (await bus.execute<{ id: string }>(actor(), "conversation.start_manual", {
    personId: person.data.id,
    channel: "WHATSAPP",
  })) as { ok: true; data: { id: string } };
  return conv.data.id;
}

function registeredImage(store: MemoryOutboundAttachmentStore, ref: string, size = 1024): void {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  store.register({ tenantId: TENANT, ref, kind: "IMAGE", mimeType: "image/jpeg", fileName: "photo.jpg", bytes });
}

afterEach(() => {
  resetGatewayForTests();
  clearSessionBindingsForTests();
  resetOutboundAttachmentStoreForTests();
});

describe("FIX-WAHA-OUTBOUND: free-URL attachmentRef refused (delegated-SSRF guard)", () => {
  const freeUrls = [
    "https://evil.example/x.jpg",
    "http://169.254.169.254/latest/meta-data/",
    "http://waha.internal:3000/api/files/x",
    "data:image/png;base64,iVBORw0KGgo=",
    "//evil.example/x.jpg",
    "file:///etc/passwd",
    "att evil ref",
  ];

  for (const ref of freeUrls) {
    it(`refuses ${ref.slice(0, 32)} before persist/send`, async () => {
      const { db, bus } = setup();
      let calls = 0;
      setGatewayForTests({
        name: "never",
        async sendText() {
          return { ok: true, providerMessageId: "t" };
        },
        async sendMedia(): Promise<SendMediaResult> {
          calls += 1;
          return { ok: true, providerMessageId: "never" };
        },
      });
      const conversationId = await startChain(bus);
      const result = await bus.execute(actor(), "message.send_media_manual", {
        conversationId,
        kind: "IMAGE",
        attachmentRef: ref,
        mimeType: "image/jpeg",
        fileSizeBytes: 1024,
      });
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ ok: false, code: "validation_failed" });
      expect(calls).toBe(0);
      expect([...wave2State(db).messages.values()]).toHaveLength(0);
    });
  }

  it("refuses unknown opaque refs and cross-tenant refs", async () => {
    const { db, bus, store } = setup();
    let calls = 0;
    setGatewayForTests({
      name: "never",
      async sendText() {
        return { ok: true, providerMessageId: "t" };
      },
      async sendMedia(): Promise<SendMediaResult> {
        calls += 1;
        return { ok: true, providerMessageId: "never" };
      },
    });
    const conversationId = await startChain(bus);
    const unknown = await bus.execute(actor(), "message.send_media_manual", {
      conversationId,
      kind: "IMAGE",
      attachmentRef: "att-never-registered-0001",
      mimeType: "image/jpeg",
      fileSizeBytes: 1024,
    });
    expect(unknown).toMatchObject({ ok: false, code: "validation_failed" });

    const foreign = new Uint8Array(16);
    foreign.set([0xff, 0xd8, 0xff, 0xe0], 0);
    store.register({
      tenantId: OTHER_TENANT,
      ref: "att-foreign-0001",
      kind: "IMAGE",
      mimeType: "image/jpeg",
      fileName: "f.jpg",
      bytes: foreign,
    });
    const cross = await bus.execute(actor(), "message.send_media_manual", {
      conversationId,
      kind: "IMAGE",
      attachmentRef: "att-foreign-0001",
      mimeType: "image/jpeg",
      fileSizeBytes: 16,
    });
    expect(cross).toMatchObject({ ok: false, code: "validation_failed" });
    expect(calls).toBe(0);
    expect([...wave2State(db).messages.values()]).toHaveLength(0);
  });

  it("gateway adapter refuses free-URL refs without touching the network", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: "never" }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new WahaGatewayAdapter("http://127.0.0.1:9", "k", "default", 3000, fetchImpl);
    const result = await adapter.sendMedia({
      tenantId: TENANT,
      conversationId: "00000000-0000-4000-8000-000000000000",
      to: "5511999990404@c.us",
      kind: "IMAGE",
      attachmentRef: "https://evil.example/x.jpg",
      mimeType: "image/jpeg",
      fileName: null,
      caption: null,
      durationSeconds: null,
    });
    expect(result).toMatchObject({ ok: false, code: "FAILED" });
    expect(calls).toBe(0);
  });
});

describe("FIX-WAHA-OUTBOUND: real caps/MIME win over declared fields", () => {
  it("refuses really-oversized bytes even when the declared size fits", async () => {
    const { db, bus, store } = setup();
    let calls = 0;
    setGatewayForTests({
      name: "never",
      async sendText() {
        return { ok: true, providerMessageId: "t" };
      },
      async sendMedia(): Promise<SendMediaResult> {
        calls += 1;
        return { ok: true, providerMessageId: "never" };
      },
    });
    const conversationId = await startChain(bus);
    const real = new Uint8Array(MEDIA_MAX_BYTES.IMAGE + 1);
    real.set([0xff, 0xd8, 0xff, 0xe0], 0);
    store.register({
      tenantId: TENANT,
      ref: "att-real-oversized-0001",
      kind: "IMAGE",
      mimeType: "image/jpeg",
      fileName: "big.jpg",
      bytes: real,
    });
    const result = await bus.execute(actor(), "message.send_media_manual", {
      conversationId,
      kind: "IMAGE",
      attachmentRef: "att-real-oversized-0001",
      mimeType: "image/jpeg",
      fileSizeBytes: 1024,
    });
    expect(result).toMatchObject({ ok: false, code: "validation_failed" });
    expect(calls).toBe(0);
    expect([...wave2State(db).messages.values()]).toHaveLength(0);
  });

  it("refuses declared MIME/size mismatches against the registered record", async () => {
    const { bus, store } = setup();
    setGatewayForTests({
      name: "never",
      async sendText() {
        return { ok: true, providerMessageId: "t" };
      },
      async sendMedia(): Promise<SendMediaResult> {
        return { ok: true, providerMessageId: "never" };
      },
    });
    registeredImage(store, "att-mismatch-0001", 1024);
    const conversationId = await startChain(bus);
    const mimeMismatch = await bus.execute(actor(), "message.send_media_manual", {
      conversationId,
      kind: "IMAGE",
      attachmentRef: "att-mismatch-0001",
      mimeType: "image/png",
      fileSizeBytes: 1024,
    });
    expect(mimeMismatch).toMatchObject({ ok: false, code: "validation_failed" });
    const sizeMismatch = await bus.execute(actor(), "message.send_media_manual", {
      conversationId,
      kind: "IMAGE",
      attachmentRef: "att-mismatch-0001",
      mimeType: "image/jpeg",
      fileSizeBytes: 2048,
    });
    expect(sizeMismatch).toMatchObject({ ok: false, code: "validation_failed" });
  });

  it("refuses bytes whose sniffed content is outside the kind allowlist", async () => {
    const { bus, store } = setup();
    setGatewayForTests({
      name: "never",
      async sendText() {
        return { ok: true, providerMessageId: "t" };
      },
      async sendMedia(): Promise<SendMediaResult> {
        return { ok: true, providerMessageId: "never" };
      },
    });
    const pdfAsImage = new Uint8Array(64);
    pdfAsImage.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0);
    store.register({
      tenantId: TENANT,
      ref: "att-sniff-0001",
      kind: "IMAGE",
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      bytes: pdfAsImage,
    });
    const conversationId = await startChain(bus);
    const result = await bus.execute(actor(), "message.send_media_manual", {
      conversationId,
      kind: "IMAGE",
      attachmentRef: "att-sniff-0001",
      mimeType: "image/jpeg",
      fileSizeBytes: 64,
    });
    expect(result).toMatchObject({ ok: false, code: "validation_failed" });
  });
});

describe("FIX-WAHA-OUTBOUND: UNKNOWN gateway result parks like the UNKNOWN exception", () => {
  it("QUEUED + UNKNOWN_EFFECT + PAUSED + conversation.paused.v1, blind resend refused", async () => {
    const { db, bus, store } = setup();
    registeredImage(store, "att-unknown-result-0001", 1024);
    let calls = 0;
    setGatewayForTests({
      name: "media-unknown-result",
      async sendText() {
        return { ok: true, providerMessageId: "t" };
      },
      async sendMedia(): Promise<SendMediaResult> {
        calls += 1;
        return { ok: false, code: "UNKNOWN_EFFECT", message: "inconclusive confirmation" };
      },
    });
    const conversationId = await startChain(bus);
    const uncertain = await bus.execute(actor(), "message.send_media_manual", {
      conversationId,
      kind: "IMAGE",
      attachmentRef: "att-unknown-result-0001",
      mimeType: "image/jpeg",
      fileSizeBytes: 1024,
    });
    expect(uncertain).toMatchObject({ ok: true, data: { deliveryStatus: "QUEUED", providerMessageId: null } });
    expect(calls).toBe(1);
    expect(wave2State(db).deliveries).toMatchObject([{ status: "QUEUED", errorCode: "UNKNOWN_EFFECT" }]);
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("conversation.paused.v1");
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).not.toContain("message.sent.v1");

    registeredImage(store, "att-unknown-result-0002", 1024);
    const replay = await bus.execute(actor(), "message.send_media_manual", {
      conversationId,
      kind: "IMAGE",
      attachmentRef: "att-unknown-result-0002",
      mimeType: "image/jpeg",
      fileSizeBytes: 1024,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.message).toMatch(/reconcile_required/);
    }
    expect(calls).toBe(1);
  });
});
