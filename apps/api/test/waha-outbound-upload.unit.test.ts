import { afterEach, describe, expect, it } from "vitest";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../src/commands/command-bus.js";
import { registerCrmCommands } from "../src/crm/crm.commands.js";
import { MEDIA_MAX_AUDIO_SECONDS, MEDIA_MAX_BYTES } from "../src/communications/waha-media.js";
import { registerCommunicationCommands } from "../src/communications/communications.commands.js";
import {
  OUTBOUND_REF_PATTERN,
  MemoryOutboundAttachmentStore,
  resetOutboundAttachmentStoreForTests,
  setOutboundAttachmentStoreForTests,
  type OutboundAttachmentRecord,
} from "../src/communications/waha-outbound-attachments.js";
import { resetGatewayForTests, setGatewayForTests, type SendMediaResult } from "../src/communications/messaging-gateway.js";
import { clearSessionBindingsForTests } from "../src/communications/waha-sessions.js";
import { RateLimitService } from "../src/auth/rate-limit.service.js";
import type { FastifyRequest } from "fastify";
import { memoryStateOf } from "../src/crm/wave2-store.js";
import type { CommandHandlerContext } from "../src/commands/command-bus.js";
import { MemoryDb } from "./fakes/memory-fakes.js";

/**
 * EXEC-WAHA-BACKING-20261020 (unit, zero network, memory lane):
 * - `attachment.upload` registers REAL bytes behind an opaque ref; the ref
 *   resolves tenant-scoped and a later `message.send_media_manual` is SENT;
 * - unknown refs (no prior upload) and cross-tenant refs refuse;
 * - oversize real bytes, MIME/sniff mismatches, unknown signatures, bad
 *   base64, and audio rule violations refuse at upload;
 * - idempotency-key replays the same ref, conflicts on a different payload;
 * - the new upload rate-limit kind budgets per origin (30 admits, then 429).
 *
 * Deterministic fixtures: counters only, never UUID-head slices.
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

/** Real-bytes fixtures: correct magic headers so the sniff gate passes. */
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

async function startChain(bus: CommandBus, tenantId: string = TENANT): Promise<string> {
  const useActor = actor(tenantId);
  const person = (await bus.execute<{ id: string }>(useActor, "person.register", {
    canonicalName: "Upload Customer",
    identities: [{ identityType: "WHATSAPP", normalizedValue: "5511999990404" }],
  })) as { ok: true; data: { id: string } };
  const conv = (await bus.execute<{ id: string }>(useActor, "conversation.start_manual", {
    personId: person.data.id,
    channel: "WHATSAPP",
  })) as { ok: true; data: { id: string } };
  return conv.data.id;
}

afterEach(() => {
  resetGatewayForTests();
  clearSessionBindingsForTests();
  resetOutboundAttachmentStoreForTests();
});

describe("attachment.upload memory lane: upload -> ref -> send-media SENT", () => {
  it("registers real bytes behind an opaque ref and sends SENT", async () => {
    const { db, bus } = setup();
    let calls = 0;
    setGatewayForTests({
      name: "media-recording",
      async sendText() {
        return { ok: true, providerMessageId: "text-unused" };
      },
      async sendMedia(): Promise<SendMediaResult> {
        calls += 1;
        return { ok: true, providerMessageId: "media-confirm-1" };
      },
    });
    const conversationId = await startChain(bus);
    const uploaded = await bus.execute<{
      attachmentRef: string;
      kind: string;
      mimeType: string;
      fileName: string | null;
      sizeBytes: number;
    }>(actor(), "attachment.upload", {
      kind: "IMAGE",
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      contentBase64: b64(magicBytes("IMAGE", 1024)),
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) {
      throw new Error(`upload failed: ${JSON.stringify(uploaded)}`);
    }
    expect(uploaded.data.attachmentRef).toMatch(OUTBOUND_REF_PATTERN);
    expect(uploaded.data).toMatchObject({ kind: "IMAGE", mimeType: "image/jpeg", fileName: "photo.jpg", sizeBytes: 1024 });

    const sent = await bus.execute(actor(), "message.send_media_manual", {
      conversationId,
      kind: "IMAGE",
      attachmentRef: uploaded.data.attachmentRef,
      mimeType: "image/jpeg",
      fileSizeBytes: 1024,
    });
    expect(sent).toMatchObject({ ok: true, data: { deliveryStatus: "SENT", providerMessageId: "media-confirm-1" } });
    expect(calls).toBe(1);
    expect([...wave2State(db).messages.values()]).toHaveLength(1);
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("message.sent.v1");
  });

  it("refuses a send with no prior upload (unknown ref)", async () => {
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
    const conversationId = await startChain(bus);
    const result = await bus.execute(actor(), "message.send_media_manual", {
      conversationId,
      kind: "IMAGE",
      attachmentRef: "att-never-uploaded-0001",
      mimeType: "image/jpeg",
      fileSizeBytes: 1024,
    });
    expect(result).toMatchObject({ ok: false, code: "validation_failed" });
    expect(calls).toBe(0);
    expect([...wave2State(db).messages.values()]).toHaveLength(0);
  });

  it("isolates refs per tenant (cross-tenant send refuses)", async () => {
    const { bus, store } = setup();
    setGatewayForTests({
      name: "media-never",
      async sendText() {
        return { ok: true, providerMessageId: "t" };
      },
      async sendMedia(): Promise<SendMediaResult> {
        return { ok: true, providerMessageId: "never" };
      },
    });
    const foreign = magicBytes("IMAGE", 64);
    const record: OutboundAttachmentRecord = {
      tenantId: OTHER_TENANT,
      ref: "att-foreign-upload-0001",
      kind: "IMAGE",
      mimeType: "image/jpeg",
      fileName: "f.jpg",
      bytes: foreign,
    };
    store.register(record);
    const conversationId = await startChain(bus, TENANT);
    const cross = await bus.execute(actor(TENANT), "message.send_media_manual", {
      conversationId,
      kind: "IMAGE",
      attachmentRef: "att-foreign-upload-0001",
      mimeType: "image/jpeg",
      fileSizeBytes: 64,
    });
    expect(cross).toMatchObject({ ok: false, code: "validation_failed" });
  });
});

describe("attachment.upload validation (real bytes win)", () => {
  it("refuses really-oversized bytes even though no declared size exists at upload", async () => {
    const { bus } = setup();
    const result = await bus.execute(actor(), "attachment.upload", {
      kind: "IMAGE",
      mimeType: "image/jpeg",
      contentBase64: b64(magicBytes("IMAGE", MEDIA_MAX_BYTES.IMAGE + 1)),
    });
    expect(result).toMatchObject({ ok: false, code: "validation_failed" });
  });

  it("refuses sniffed-vs-declared mismatches and unknown signatures", async () => {
    const { bus } = setup();
    // JPEG bytes declared as PNG: both allowlisted for IMAGE, contents differ.
    const mismatch = await bus.execute(actor(), "attachment.upload", {
      kind: "IMAGE",
      mimeType: "image/png",
      contentBase64: b64(magicBytes("IMAGE", 64)),
    });
    expect(mismatch).toMatchObject({ ok: false, code: "validation_failed" });

    // Random bytes: no known magic signature.
    const unknown = await bus.execute(actor(), "attachment.upload", {
      kind: "IMAGE",
      mimeType: "image/jpeg",
      contentBase64: b64(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    });
    expect(unknown).toMatchObject({ ok: false, code: "validation_failed" });

    // Non-canonical base64 (whitespace) is not accepted.
    const badEncoding = await bus.execute(actor(), "attachment.upload", {
      kind: "IMAGE",
      mimeType: "image/jpeg",
      contentBase64: `${b64(magicBytes("IMAGE", 64))}\n`,
    });
    expect(badEncoding).toMatchObject({ ok: false, code: "validation_failed" });
  });

  it("enforces audio authorization and the duration cap at upload", async () => {
    const { bus } = setup();
    const noConsent = await bus.execute(actor(), "attachment.upload", {
      kind: "AUDIO",
      mimeType: "audio/ogg",
      contentBase64: b64(magicBytes("AUDIO", 64)),
      durationSeconds: 30,
    });
    expect(noConsent).toMatchObject({ ok: false, code: "validation_failed" });

    const tooLong = await bus.execute(actor(), "attachment.upload", {
      kind: "AUDIO",
      mimeType: "audio/ogg",
      contentBase64: b64(magicBytes("AUDIO", 64)),
      durationSeconds: MEDIA_MAX_AUDIO_SECONDS + 1,
      customerAuthorized: true,
    });
    expect(tooLong).toMatchObject({ ok: false, code: "validation_failed" });

    const consented = await bus.execute(actor(), "attachment.upload", {
      kind: "AUDIO",
      mimeType: "audio/ogg",
      contentBase64: b64(magicBytes("AUDIO", 64)),
      durationSeconds: 30,
      customerAuthorized: true,
    });
    expect(consented.ok).toBe(true);
  });
});

describe("attachment.upload idempotency-key", () => {
  it("replays the same ref for the same payload, conflicts on a different payload", async () => {
    const { bus } = setup();
    const payload = {
      kind: "IMAGE",
      mimeType: "image/jpeg",
      contentBase64: b64(magicBytes("IMAGE", 128)),
    };
    const first = await bus.execute(actor(), "attachment.upload", payload, { idempotencyKey: "upload-key-1" });
    expect(first.ok).toBe(true);
    const second = await bus.execute(actor(), "attachment.upload", payload, { idempotencyKey: "upload-key-1" });
    expect(second).toEqual(first);
    const conflict = await bus.execute(
      actor(),
      "attachment.upload",
      { ...payload, fileName: "other.jpg" },
      { idempotencyKey: "upload-key-1" },
    );
    expect(conflict).toMatchObject({ ok: false, code: "validation_failed" });
  });
});

describe("communications-attachments-upload rate limit (origin-only backstop)", () => {
  function makeRequest(remoteAddress = "203.0.113.44"): FastifyRequest {
    return {
      id: "req-upload-test",
      method: "POST",
      url: "/v1/communications/attachments",
      socket: { remoteAddress },
      headers: {},
      body: {},
    } as unknown as FastifyRequest;
  }

  it("admits 30 then denies with retry-after; other origins unaffected", () => {
    const service = new RateLimitService();
    const origin = "203.0.113.44";
    for (let i = 0; i < 30; i += 1) {
      expect(service.acquire("communications-attachments-upload", makeRequest(origin), undefined).allowed).toBe(true);
    }
    const blocked = service.acquire("communications-attachments-upload", makeRequest(origin), undefined);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(service.acquire("communications-attachments-upload", makeRequest("198.51.100.7"), undefined).allowed).toBe(
      true,
    );
  });
});
