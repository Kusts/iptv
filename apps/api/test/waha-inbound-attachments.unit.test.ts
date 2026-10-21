import { afterEach, describe, expect, it } from "vitest";
import {
  INBOUND_REF_PATTERN,
  MemoryInboundAttachmentStore,
  currentInboundAttachmentStore,
  generateInboundRef,
  resetInboundAttachmentStoreForTests,
  setInboundAttachmentStoreForTests,
  validateInboundAttachmentRef,
  validateInboundUploadBytes,
} from "../src/communications/waha-inbound-attachments.js";

/**
 * EXEC-WAHA-MEDIA-FETCH-20261020: inbound byte gate + memory store.
 *
 * The gate runs over the REAL fetched bytes (caps/MIME/magic-byte sniff,
 * same discipline as the outbound registry) with one deliberate inbound
 * difference: NO `customerAuthorized` consent gate — consent governs
 * sending, not receiving; inbound AUDIO only honors the 600 s duration cap
 * when a duration is reported. Zero network, zero credentials.
 *
 * Deterministic fixtures: counters only, never UUID-head slices.
 */

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 9, 9, 9, 9]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 9, 9, 9, 9]);

afterEach(() => {
  resetInboundAttachmentStoreForTests();
});

describe("validateInboundUploadBytes", () => {
  it("accepts JPEG bytes declared as image/jpeg", () => {
    expect(
      validateInboundUploadBytes({ kind: "IMAGE", mimeType: "image/jpeg", bytes: JPEG }),
    ).toMatchObject({ ok: true, normalizedMime: "image/jpeg" });
  });

  it("accepts inbound AUDIO without any customer authorization (receive ≠ send)", () => {
    const check = validateInboundUploadBytes({ kind: "AUDIO", mimeType: "audio/ogg", bytes: OGG, durationSeconds: 42 });
    expect(check).toMatchObject({ ok: true, normalizedMime: "audio/ogg" });
  });

  it("refuses inbound AUDIO over the 600 s duration cap when reported", () => {
    expect(
      validateInboundUploadBytes({ kind: "AUDIO", mimeType: "audio/ogg", bytes: OGG, durationSeconds: 601 }),
    ).toMatchObject({ ok: false, code: "validation_failed" });
  });

  it("refuses oversized real bytes", () => {
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    big[0] = 0xff;
    big[1] = 0xd8;
    big[2] = 0xff;
    expect(validateInboundUploadBytes({ kind: "IMAGE", mimeType: "image/jpeg", bytes: big })).toMatchObject({
      ok: false,
      code: "validation_failed",
    });
  });

  it("refuses disallowlisted MIME for the kind", () => {
    expect(validateInboundUploadBytes({ kind: "IMAGE", mimeType: "text/html", bytes: JPEG })).toMatchObject({
      ok: false,
      code: "validation_failed",
    });
  });

  it("refuses unrecognized byte signatures", () => {
    expect(
      validateInboundUploadBytes({ kind: "IMAGE", mimeType: "image/jpeg", bytes: new Uint8Array([7, 7, 7]) }),
    ).toMatchObject({ ok: false, code: "validation_failed" });
  });

  it("refuses sniffed-vs-declared mismatch (PNG bytes declared as JPEG)", () => {
    expect(validateInboundUploadBytes({ kind: "IMAGE", mimeType: "image/jpeg", bytes: PNG })).toMatchObject({
      ok: false,
      code: "validation_failed",
    });
  });

  it("refuses empty bytes", () => {
    expect(
      validateInboundUploadBytes({ kind: "DOCUMENT", mimeType: "application/pdf", bytes: new Uint8Array([]) }),
    ).toMatchObject({ ok: false, code: "validation_failed" });
  });

  it("accepts PDF bytes declared as application/pdf", () => {
    expect(validateInboundUploadBytes({ kind: "DOCUMENT", mimeType: "application/pdf", bytes: PDF })).toMatchObject({
      ok: true,
      normalizedMime: "application/pdf",
    });
  });
});

describe("generateInboundRef / validateInboundAttachmentRef", () => {
  it("mints opaque `in-` refs matching the pattern", () => {
    const ref = generateInboundRef();
    expect(INBOUND_REF_PATTERN.test(ref)).toBe(true);
    expect(ref.startsWith("in-")).toBe(true);
    expect(validateInboundAttachmentRef(ref)).toEqual({ ok: true });
  });

  it.each([["https://evil.test/x.jpg"], ["//evil.test/x"], ["data:image/png;base64,xx"], ["att with space"], [""]])(
    "refuses free-URL-shaped ref %s",
    (ref) => {
      expect(validateInboundAttachmentRef(ref).ok).toBe(false);
    },
  );
});

describe("MemoryInboundAttachmentStore", () => {
  it("persists then resolves within the same tenant", async () => {
    const store = new MemoryInboundAttachmentStore();
    setInboundAttachmentStoreForTests(store);
    expect(currentInboundAttachmentStore()).toBe(store);
    const created = await store.create("tenant-a", {
      kind: "IMAGE",
      mimeType: "image/jpeg",
      fileName: "a.jpg",
      bytes: JPEG,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error("expected ok");
    }
    const resolved = await store.resolve("tenant-a", created.ref);
    expect(resolved?.mimeType).toBe("image/jpeg");
    expect(resolved?.fileName).toBe("a.jpg");
    expect(Array.from(resolved?.bytes ?? [])).toEqual(Array.from(JPEG));
  });

  it("isolates tenants and refuses unknown refs (fail closed)", async () => {
    const store = new MemoryInboundAttachmentStore();
    const created = await store.create("tenant-a", {
      kind: "DOCUMENT",
      mimeType: "application/pdf",
      fileName: null,
      bytes: PDF,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error("expected ok");
    }
    expect(await store.resolve("tenant-b", created.ref)).toBeNull();
    expect(await store.resolve("tenant-a", "in-unknown")).toBeNull();
    expect(await store.resolve("tenant-a", "https://evil.test/x.jpg")).toBeNull();
  });

  it("refuses invalid bytes at create (nothing stored)", async () => {
    const store = new MemoryInboundAttachmentStore();
    const created = await store.create("tenant-a", {
      kind: "IMAGE",
      mimeType: "text/html",
      fileName: null,
      bytes: JPEG,
    });
    expect(created).toMatchObject({ ok: false, code: "validation_failed" });
  });

  it("empty store refuses create with storage_unavailable (webhook queues ingest-pending)", async () => {
    resetInboundAttachmentStoreForTests();
    const result = await currentInboundAttachmentStore().create("tenant-a", {
      kind: "IMAGE",
      mimeType: "image/jpeg",
      fileName: null,
      bytes: JPEG,
    });
    expect(result).toMatchObject({ ok: false, code: "storage_unavailable" });
    expect(await currentInboundAttachmentStore().resolve("tenant-a", "in-anything")).toBeNull();
  });
});
