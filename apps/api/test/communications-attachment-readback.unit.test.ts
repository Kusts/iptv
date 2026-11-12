import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CommunicationsController } from "../src/communications/communications.controller.js";
import {
  MemoryOutboundAttachmentStore,
  resetOutboundAttachmentStoreForTests,
  setOutboundAttachmentStoreForTests,
} from "../src/communications/waha-outbound-attachments.js";
import {
  MemoryInboundAttachmentStore,
  resetInboundAttachmentStoreForTests,
  setInboundAttachmentStoreForTests,
} from "../src/communications/waha-inbound-attachments.js";

const OUT_REF = "att-0123456789abcdef0123456789abcdef";

function harness(tenantId: string) {
  const headers = new Map<string, string>();
  const send = vi.fn((bytes: Buffer) => bytes);
  const reply = {
    header: vi.fn((name: string, value: string) => {
      headers.set(name, value);
      return reply;
    }),
    send,
  } as unknown as FastifyReply;
  const controller = new CommunicationsController(null, {} as never);
  const req = { tenant: { id: tenantId } } as FastifyRequest;
  return { controller, req, reply, headers, send };
}

afterEach(() => {
  resetOutboundAttachmentStoreForTests();
  resetInboundAttachmentStoreForTests();
});

describe("GET communications attachments", () => {
  it("returns outbound bytes and safe media headers", async () => {
    const store = new MemoryOutboundAttachmentStore();
    const bytes = new Uint8Array([1, 2, 3]);
    store.register({ tenantId: "tenant-a", ref: OUT_REF, kind: "AUDIO", mimeType: "audio/ogg", fileName: 'voice".ogg', bytes });
    setOutboundAttachmentStoreForTests(store);
    const h = harness("tenant-a");

    await h.controller.readAttachment(OUT_REF, h.req, h.reply);

    expect(h.headers.get("Content-Type")).toBe("audio/ogg");
    expect(h.headers.get("Content-Disposition")).toContain('filename="voice_.ogg"');
    expect(h.send).toHaveBeenCalledWith(Buffer.from(bytes));
  });

  it("falls back to inbound store and refuses another tenant", async () => {
    const inbound = new MemoryInboundAttachmentStore();
    const created = await inbound.create("tenant-a", {
      kind: "IMAGE", mimeType: "image/jpeg", fileName: "in.jpg",
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    setInboundAttachmentStoreForTests(inbound);
    const sameTenant = harness("tenant-a");
    await sameTenant.controller.readAttachment(created.ref, sameTenant.req, sameTenant.reply);
    expect(sameTenant.headers.get("Content-Type")).toBe("image/jpeg");

    const otherTenant = harness("tenant-b");
    await expect(otherTenant.controller.readAttachment(
      created.ref, otherTenant.req, otherTenant.reply,
    )).rejects.toMatchObject({ status: 404 });
  });
});
