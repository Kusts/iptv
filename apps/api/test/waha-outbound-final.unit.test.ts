import { afterEach, describe, expect, it } from "vitest";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../src/commands/command-bus.js";
import { registerCrmCommands } from "../src/crm/crm.commands.js";
import { WahaGatewayAdapter } from "../src/communications/messaging-gateway.js";
import {
  MemoryOutboundAttachmentStore,
  resetOutboundAttachmentStoreForTests,
  resolveOutboundAttachment,
  setOutboundAttachmentStoreForTests,
} from "../src/communications/waha-outbound-attachments.js";
import { registerCommunicationCommands } from "../src/communications/communications.commands.js";
import { resetGatewayForTests, setGatewayForTests, type SendMediaResult } from "../src/communications/messaging-gateway.js";
import { clearSessionBindingsForTests } from "../src/communications/waha-sessions.js";
import { memoryStateOf } from "../src/crm/wave2-store.js";
import type { CommandHandlerContext } from "../src/commands/command-bus.js";
import { MemoryDb } from "./fakes/memory-fakes.js";

/**
 * FIX-WAHA-FINAL negatives (unit, zero network):
 * (1) unknown byte signatures refuse even when the record MIME is allowlisted;
 * (2) sniffed-vs-registered equality: PNG bytes registered/declared as JPEG refuse;
 * (3) adapter revalidates registration/tenant/content via the injected store —
 *     unknown refs FAIL without touching the network.
 */

const TENANT = "77777777-7777-4777-8777-777777777771";

function actor(tenantId: string = TENANT): CommandActor {
  return {
    userId: "77777777-7777-4777-8777-777777777772",
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
    canonicalName: "Final Fix Customer",
    identities: [{ identityType: "WHATSAPP", normalizedValue: "5511999990505" }],
  })) as { ok: true; data: { id: string } };
  const conv = (await bus.execute<{ id: string }>(actor(), "conversation.start_manual", {
    personId: person.data.id,
    channel: "WHATSAPP",
  })) as { ok: true; data: { id: string } };
  return conv.data.id;
}

function pngBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

afterEach(() => {
  resetGatewayForTests();
  clearSessionBindingsForTests();
  resetOutboundAttachmentStoreForTests();
});

describe("FIX-WAHA-FINAL (1): unknown signatures refuse", () => {
  it("refuses unrecognized bytes even with an allowlisted record MIME", async () => {
    const { store } = setup();
    const unknown = new Uint8Array(64);
    unknown.set([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08], 0);
    store.register({
      tenantId: TENANT,
      ref: "att-unknown-sig-0001",
      kind: "IMAGE",
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      bytes: unknown,
    });
    const direct = await resolveOutboundAttachment({
      tenantId: TENANT,
      attachmentRef: "att-unknown-sig-0001",
      kind: "IMAGE",
      declaredMimeType: "image/jpeg",
      declaredFileSizeBytes: 64,
    });
    expect(direct).toMatchObject({ ok: false, code: "validation_failed" });
  });

  it("refuses via the command before persist/send", async () => {
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
    const unknown = new Uint8Array(64);
    unknown.set([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33], 0);
    store.register({
      tenantId: TENANT,
      ref: "att-unknown-sig-0002",
      kind: "IMAGE",
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      bytes: unknown,
    });
    const conversationId = await startChain(bus);
    const result = await bus.execute(actor(), "message.send_media_manual", {
      conversationId,
      kind: "IMAGE",
      attachmentRef: "att-unknown-sig-0002",
      mimeType: "image/jpeg",
      fileSizeBytes: 64,
    });
    expect(result).toMatchObject({ ok: false, code: "validation_failed" });
    expect(calls).toBe(0);
    expect([...wave2State(db).messages.values()]).toHaveLength(0);
  });
});

describe("FIX-WAHA-FINAL (2): sniffed-vs-registered equality", () => {
  it("refuses PNG bytes registered/declared as JPEG", async () => {
    const { store } = setup();
    store.register({
      tenantId: TENANT,
      ref: "att-png-as-jpeg-0001",
      kind: "IMAGE",
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      bytes: pngBytes(128),
    });
    const direct = await resolveOutboundAttachment({
      tenantId: TENANT,
      attachmentRef: "att-png-as-jpeg-0001",
      kind: "IMAGE",
      declaredMimeType: "image/jpeg",
      declaredFileSizeBytes: 128,
    });
    expect(direct).toMatchObject({ ok: false, code: "validation_failed" });
    if (!direct.ok) {
      expect(direct.message).toMatch(/sniffed image\/png != registered/);
    }
  });

  it("accepts PNG bytes registered/declared as PNG (equality holds)", async () => {
    const { store } = setup();
    store.register({
      tenantId: TENANT,
      ref: "att-png-ok-0001",
      kind: "IMAGE",
      mimeType: "image/png",
      fileName: "photo.png",
      bytes: pngBytes(128),
    });
    const direct = await resolveOutboundAttachment({
      tenantId: TENANT,
      attachmentRef: "att-png-ok-0001",
      kind: "IMAGE",
      declaredMimeType: "image/png",
      declaredFileSizeBytes: 128,
    });
    expect(direct.ok).toBe(true);
  });
});

describe("FIX-WAHA-FINAL (3): adapter revalidates before POST", () => {
  it("fails unknown opaque refs without touching the network", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: "never" }), { status: 200 });
    }) as unknown as typeof fetch;
    const store = new MemoryOutboundAttachmentStore();
    const adapter = new WahaGatewayAdapter("http://127.0.0.1:9", "k", "default", 3000, fetchImpl, store);
    const result = await adapter.sendMedia({
      tenantId: TENANT,
      conversationId: "00000000-0000-4000-8000-000000000000",
      to: "5511999990505@c.us",
      kind: "IMAGE",
      attachmentRef: "att-never-registered-final-0001",
      mimeType: "image/jpeg",
      fileName: null,
      caption: null,
      durationSeconds: null,
    });
    expect(result).toMatchObject({ ok: false, code: "FAILED" });
    expect(calls).toBe(0);
  });

  it("fails mismatched content without touching the network (default fail-closed store)", async () => {
    const { store } = setup();
    store.register({
      tenantId: TENANT,
      ref: "att-png-as-jpeg-0002",
      kind: "IMAGE",
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      bytes: pngBytes(64),
    });
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: "never" }), { status: 200 });
    }) as unknown as typeof fetch;
    // No explicit store injected: adapter falls back to the active
    // fail-closed global registry (populated above), revalidates, refuses.
    const adapter = new WahaGatewayAdapter("http://127.0.0.1:9", "k", "default", 3000, fetchImpl);
    const result = await adapter.sendMedia({
      tenantId: TENANT,
      conversationId: "00000000-0000-4000-8000-000000000000",
      to: "5511999990505@c.us",
      kind: "IMAGE",
      attachmentRef: "att-png-as-jpeg-0002",
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      caption: null,
      durationSeconds: null,
    });
    expect(result).toMatchObject({ ok: false, code: "FAILED" });
    expect(calls).toBe(0);
  });
});
