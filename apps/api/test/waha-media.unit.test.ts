import { describe, expect, it } from "vitest";
import { CommandBus } from "../src/commands/command-bus.js";
import { registerCrmCommands } from "../src/crm/crm.commands.js";
import { registerCommunicationCommands } from "../src/communications/communications.commands.js";
import {
  identifyWahaMedia,
  normalizeWahaPayload,
} from "../src/communications/waha-normalizer.js";
import {
  assertFetchedMime,
  HttpWahaMediaPort,
  MEDIA_MAX_BYTES,
  MEDIA_MAX_REDIRECT_HOPS,
  mediaMetadataFor,
  validateMediaDescriptor,
  type WahaMediaDescriptor,
} from "../src/communications/waha-media.js";
import { MemoryDb } from "./fakes/memory-fakes.js";
import type { CommandActor } from "@iptv/domain";

/**
 * G01/WAHA media unit suite (no DB, no network — controlled stubs only).
 * Fixture payloads use deterministic counters, never UUID-head slices.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";

let counter = 0;
function tag(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, "0")}`;
}

function actor(): CommandActor {
  return {
    userId: "22222222-2222-4222-8222-222222222222",
    isPlatformAdmin: false,
    tenantId: TENANT,
    roleKeys: ["tenant_owner"],
    permissions: ["crm.person.read", "crm.lead.write", "conversation.reply"],
    actorType: "human",
  };
}

function imagePayload() {
  return {
    id: tag("wamsg-img"),
    from: "5511999990001@c.us",
    fromMe: false,
    type: "image",
    body: "",
    caption: "foto do medidor",
    mediaUrl: "https://waha.test/api/files/img-0001.jpg",
    mimetype: "image/jpeg",
    fileSize: 120_000,
    timestamp: 1758912000,
  };
}

describe("WAHA media identification (normalizer)", () => {
  it("leaves text-only inbound on the TEXT path (media null)", () => {
    const normalized = normalizeWahaPayload({
      event: "message",
      session: "default",
      payload: { id: tag("wamsg"), from: "5511999990001@c.us", fromMe: false, body: "oi", timestamp: 1758912000 },
    });
    expect(normalized.kind).toBe("message");
    if (normalized.kind !== "message") {
      throw new Error("expected message");
    }
    expect(normalized.text).toBe("oi");
    expect(normalized.media).toBeNull();
  });

  it("identifies a valid image with caption and size", () => {
    const media = identifyWahaMedia(imagePayload() as unknown as Record<string, unknown>);
    expect(media).toMatchObject({
      contentType: "IMAGE",
      mediaUrl: "https://waha.test/api/files/img-0001.jpg",
      declaredMime: "image/jpeg",
      sizeBytes: 120_000,
      caption: "foto do medidor",
    });
  });

  it("identifies ptt voice notes as AUDIO", () => {
    const media = identifyWahaMedia({
      id: tag("wamsg"),
      from: "5511999990001@c.us",
      fromMe: false,
      type: "ptt",
      mediaUrl: "https://waha.test/api/files/ptt-0001.ogg",
      mimetype: "audio/ogg",
      duration: 42,
      timestamp: 1758912000,
    });
    expect(media).toMatchObject({ contentType: "AUDIO", durationSeconds: 42 });
  });

  it("identifies a pdf document with filename", () => {
    const media = identifyWahaMedia({
      id: tag("wamsg"),
      from: "5511999990001@c.us",
      fromMe: false,
      type: "document",
      mediaUrl: "https://waha.test/api/files/fatura-0001.pdf",
      mimetype: "application/pdf",
      filename: "fatura.pdf",
      fileSize: 55_000,
      timestamp: 1758912000,
    });
    expect(media).toMatchObject({ contentType: "DOCUMENT", fileName: "fatura.pdf" });
  });

  it("infers media from URL + MIME hint when `type` is absent", () => {
    const media = identifyWahaMedia({
      id: tag("wamsg"),
      from: "5511999990001@c.us",
      fromMe: false,
      mediaUrl: "https://waha.test/api/files/img-0002.png",
      mimetype: "image/png",
      timestamp: 1758912000,
    });
    expect(media).toMatchObject({ contentType: "IMAGE" });
  });

  it("returns null for non-media types (location/sticker shapes)", () => {
    expect(identifyWahaMedia({ type: "location", latitude: -23.5, longitude: -46.6 })).toBeNull();
    expect(identifyWahaMedia({ type: "sticker" })).toBeNull();
    expect(identifyWahaMedia({ body: "plain text" })).toBeNull();
  });

  it("keeps an explicit media type without artifacts as media (unavailable, never TEXT)", () => {
    const normalized = normalizeWahaPayload({
      event: "message",
      session: "default",
      payload: { id: tag("wamsg"), from: "5511999990001@c.us", fromMe: false, type: "audio", timestamp: 1758912000 },
    });
    expect(normalized.kind).toBe("message");
    if (normalized.kind !== "message") {
      throw new Error("expected message");
    }
    expect(normalized.media).toMatchObject({ contentType: "AUDIO", mediaUrl: null });
  });

  it("treats explicit hasMedia signaling without URL/MIME/type as media (never TEXT)", () => {
    const media = identifyWahaMedia({
      id: tag("wamsg"),
      from: "5511999990001@c.us",
      fromMe: false,
      hasMedia: true,
      body: "",
      timestamp: 1758912000,
    });
    expect(media).toMatchObject({ contentType: "DOCUMENT", mediaUrl: null, declaredMime: null });
    const normalized = normalizeWahaPayload({
      event: "message",
      session: "default",
      payload: {
        id: tag("wamsg"),
        from: "5511999990001@c.us",
        fromMe: false,
        hasMedia: true,
        body: "",
        timestamp: 1758912000,
      },
    });
    expect(normalized.kind).toBe("message");
    if (normalized.kind !== "message") {
      throw new Error("expected message");
    }
    expect(normalized.media).toMatchObject({ mediaUrl: null });
  });

  it("infers the media kind from a MIME hint when hasMedia carries no URL", () => {
    const media = identifyWahaMedia({
      id: tag("wamsg"),
      from: "5511999990001@c.us",
      fromMe: false,
      hasMedia: true,
      mimetype: "image/png",
      timestamp: 1758912000,
    });
    expect(media).toMatchObject({ contentType: "IMAGE", mediaUrl: null, declaredMime: "image/png" });
  });

  it("leaves plain text without media signaling on the TEXT path", () => {
    expect(identifyWahaMedia({ body: "texto puro, sem sinal de mídia" })).toBeNull();
  });
});

describe("media descriptor validation (pure)", () => {
  function descriptor(overrides: Partial<WahaMediaDescriptor> = {}): WahaMediaDescriptor {
    return {
      contentType: "IMAGE",
      mediaUrl: "https://waha.test/api/files/img-0001.jpg",
      declaredMime: "image/jpeg",
      fileName: null,
      sizeBytes: 120_000,
      durationSeconds: null,
      caption: null,
      ...overrides,
    };
  }

  it("accepts a valid image descriptor", () => {
    expect(validateMediaDescriptor(descriptor())).toMatchObject({ ok: true });
  });

  it("rejects an oversized file", () => {
    const result = validateMediaDescriptor(descriptor({ sizeBytes: MEDIA_MAX_BYTES.IMAGE + 1 }));
    expect(result).toMatchObject({ ok: false, code: "media_invalid" });
    if (result.ok) {
      throw new Error("expected invalid");
    }
    expect(result.reason).toMatch(/oversized IMAGE/);
  });

  it("rejects a mismatched MIME (html declared as document)", () => {
    const result = validateMediaDescriptor(
      descriptor({ contentType: "DOCUMENT", declaredMime: "text/html" }),
    );
    expect(result).toMatchObject({ ok: false, code: "media_invalid" });
    if (result.ok) {
      throw new Error("expected invalid");
    }
    expect(result.reason).toMatch(/mismatched MIME/);
  });

  it("marks missing media urls unavailable (never TEXT-downgraded)", () => {
    const result = validateMediaDescriptor(descriptor({ mediaUrl: null }));
    expect(result).toMatchObject({ ok: false, code: "media_unavailable" });
  });

  it("rejects audio beyond the duration cap", () => {
    const result = validateMediaDescriptor(
      descriptor({ contentType: "AUDIO", mediaUrl: "https://waha.test/f.ogg", declaredMime: "audio/ogg", durationSeconds: 601 }),
    );
    expect(result).toMatchObject({ ok: false, code: "media_invalid" });
  });

  it("gates fetched Content-Type bytes against the content type", () => {
    expect(assertFetchedMime("IMAGE", "image/jpeg")).toEqual({ ok: true });
    expect(assertFetchedMime("IMAGE", "text/html").ok).toBe(false);
    expect(assertFetchedMime("AUDIO", null).ok).toBe(false);
  });
});

describe("HttpWahaMediaPort with a controlled fetch double (no network)", () => {
  interface StubMediaResponse {
    status: number;
    mime?: string;
    location?: string;
    contentLength?: string;
    bytes?: Uint8Array;
    chunks?: Uint8Array[];
    bodyNull?: boolean;
    onPull?: () => void;
  }

  interface CapturedCall {
    url: string;
    headers: Record<string, string>;
  }

  function stubFetch(
    handler: (url: string, callIndex: number) => StubMediaResponse,
    calls: CapturedCall[] = [],
  ): typeof fetch {
    return (async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const url = String(input);
      calls.push({ url, headers: { ...(init?.headers ?? {}) } });
      const out = handler(url, calls.length - 1);
      const headerMap: Record<string, string | null> = {
        "content-type": out.mime ?? null,
        location: out.location ?? null,
        "content-length": out.contentLength ?? null,
      };
      const chunks = out.chunks ?? (out.bytes !== undefined ? [out.bytes] : []);
      let body: ReadableStream<Uint8Array> | null = null;
      if (!out.bodyNull && (out.chunks !== undefined || out.bytes !== undefined)) {
        let index = 0;
        body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              out.onPull?.();
              if (index >= chunks.length) {
                controller.close();
                return;
              }
              controller.enqueue(chunks[index] as Uint8Array);
              index += 1;
            },
          },
          // Zero watermark: chunks are produced only when actually read, so
          // pull counters measure consumed bytes, not prefetched ones.
          { highWaterMark: 0 },
        );
      }
      const payload = out.bytes ?? new Uint8Array([]);
      return {
        ok: out.status >= 200 && out.status < 300,
        status: out.status,
        headers: { get: (name: string) => headerMap[name.toLowerCase()] ?? null },
        body,
        arrayBuffer: async () =>
          payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer,
      };
    }) as unknown as typeof fetch;
  }

  function imageDescriptor(): WahaMediaDescriptor {
    return {
      contentType: "IMAGE",
      mediaUrl: "https://waha.test/api/files/img-0001.jpg",
      declaredMime: "image/jpeg",
      fileName: null,
      sizeBytes: null,
      durationSeconds: null,
      caption: "foto",
    };
  }

  it("downloads a valid image from an allowlisted host", async () => {
    let calls = 0;
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      fetchImpl: stubFetch(() => {
        calls += 1;
        return { status: 200, mime: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) };
      }),
    });
    const result = await port.download(imageDescriptor());
    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.fetched.mimeType).toBe("image/jpeg");
    expect(result.fetched.sizeBytes).toBe(3);
  });

  it("refuses a non-allowlisted host without fetching (fail-closed)", async () => {
    let calls = 0;
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      fetchImpl: stubFetch(() => {
        calls += 1;
        return { status: 200, mime: "image/jpeg", bytes: new Uint8Array([1]) };
      }),
    });
    const result = await port.download({
      ...imageDescriptor(),
      mediaUrl: "https://evil.test/api/files/img-0001.jpg",
    });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ ok: false, code: "media_unavailable" });
  });

  it("refuses an https→http downgrade without fetching or leaking the api key", async () => {
    const calls: CapturedCall[] = [];
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      apiKey: "secret-key",
      fetchImpl: stubFetch((url) => {
        if (url === "https://waha.test/api/files/img-0001.jpg") {
          return { status: 302, location: "http://waha.test/api/files/img-0001.jpg" };
        }
        return { status: 200, mime: "image/jpeg", bytes: new Uint8Array([9]) };
      }, calls),
    });
    const result = await port.download(imageDescriptor());
    expect(result).toMatchObject({ ok: false, code: "media_unavailable" });
    if (result.ok) {
      throw new Error("expected refusal");
    }
    expect(result.reason).toMatch(/redirect origin not allowlisted: http:\/\/waha\.test/);
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.url.startsWith("http://"))).toBe(false);
  });

  it("refuses a port-swapped redirect without fetching it", async () => {
    const calls: CapturedCall[] = [];
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      apiKey: "secret-key",
      fetchImpl: stubFetch((url) => {
        if (url === "https://waha.test/api/files/img-0001.jpg") {
          return { status: 302, location: "https://waha.test:8443/api/files/img-0001.jpg" };
        }
        return { status: 200, mime: "image/jpeg", bytes: new Uint8Array([9]) };
      }, calls),
    });
    const result = await port.download(imageDescriptor());
    expect(result).toMatchObject({ ok: false, code: "media_unavailable" });
    if (result.ok) {
      throw new Error("expected refusal");
    }
    expect(result.reason).toMatch(/redirect origin not allowlisted: https:\/\/waha\.test:8443/);
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.url.includes(":8443"))).toBe(false);
  });

  it("refuses a direct http URL when only the https origin is allowlisted", async () => {
    let calls = 0;
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      fetchImpl: stubFetch(() => {
        calls += 1;
        return { status: 200, mime: "image/jpeg", bytes: new Uint8Array([1]) };
      }),
    });
    const result = await port.download({
      ...imageDescriptor(),
      mediaUrl: "http://waha.test/api/files/img-0001.jpg",
    });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ ok: false, code: "media_unavailable" });
  });

  it("accepts an explicit http origin entry (the only way to authorize plain http)", async () => {
    const port = new HttpWahaMediaPort({
      allowedHosts: ["http://waha.test"],
      fetchImpl: stubFetch(() => ({ status: 200, mime: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) })),
    });
    const result = await port.download({
      ...imageDescriptor(),
      mediaUrl: "http://waha.test/api/files/img-0001.jpg",
    });
    expect(result.ok).toBe(true);
  });

  it("maps provider 404 to download failure", async () => {
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      fetchImpl: stubFetch(() => ({ status: 404, mime: "application/json", bytes: new Uint8Array([]) })),
    });
    await expect(port.download(imageDescriptor())).resolves.toMatchObject({
      ok: false,
      code: "media_download_failed",
    });
  });

  it("maps a transport throw to download failure", async () => {
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      fetchImpl: (async () => {
        throw new Error("socket reset");
      }) as unknown as typeof fetch,
    });
    const result = await port.download(imageDescriptor());
    expect(result).toMatchObject({ ok: false, code: "media_download_failed" });
  });

  it("rejects fetched bytes whose MIME mismatches the declared type", async () => {
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      fetchImpl: stubFetch(() => ({ status: 200, mime: "text/html", bytes: new Uint8Array([60, 104, 116]) })),
    });
    await expect(port.download(imageDescriptor())).resolves.toMatchObject({
      ok: false,
      code: "media_invalid",
    });
  });

  it("rejects fetched bytes beyond the size cap with a bounded stream read", async () => {
    let pulls = 0;
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      fetchImpl: stubFetch(() => ({
        status: 200,
        mime: "image/jpeg",
        bytes: new Uint8Array(MEDIA_MAX_BYTES.IMAGE + 16),
        onPull: () => {
          pulls += 1;
        },
      })),
    });
    await expect(port.download(imageDescriptor())).resolves.toMatchObject({
      ok: false,
      code: "media_invalid",
    });
    // Single oversized chunk: the read aborts on the first pull, never
    // accumulating the full payload.
    expect(pulls).toBe(1);
  });

  it("refuses an allowlisted→evil redirect without fetching evil or leaking the api key", async () => {
    const calls: CapturedCall[] = [];
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      apiKey: "secret-key",
      fetchImpl: stubFetch((url) => {
        if (url === "https://waha.test/api/files/img-0001.jpg") {
          return { status: 302, location: "https://evil.test/stolen.jpg" };
        }
        return { status: 200, mime: "image/jpeg", bytes: new Uint8Array([9]) };
      }, calls),
    });
    const result = await port.download(imageDescriptor());
    expect(result).toMatchObject({ ok: false, code: "media_unavailable" });
    if (result.ok) {
      throw new Error("expected refusal");
    }
    expect(result.reason).toMatch(/redirect origin not allowlisted: https:\/\/evil\.test/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["X-Api-Key"]).toBe("secret-key");
    expect(calls.some((call) => call.url.includes("evil.test"))).toBe(false);
  });

  it("follows a relative allowlisted redirect and sends the api key on every hop", async () => {
    const calls: CapturedCall[] = [];
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      apiKey: "secret-key",
      fetchImpl: stubFetch((url) => {
        if (url === "https://waha.test/api/files/img-0001.jpg") {
          return { status: 302, location: "/api/files/img-0002.jpg" };
        }
        return { status: 200, mime: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) };
      }, calls),
    });
    const result = await port.download(imageDescriptor());
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      "https://waha.test/api/files/img-0001.jpg",
      "https://waha.test/api/files/img-0002.jpg",
    ]);
    for (const call of calls) {
      expect(call.headers["X-Api-Key"]).toBe("secret-key");
    }
  });

  it("sends X-Api-Key on the integral media.url and maps 401 to download failure", async () => {
    const calls: CapturedCall[] = [];
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      apiKey: "secret-key",
      fetchImpl: stubFetch(() => ({ status: 401, mime: "application/json", bytes: new Uint8Array([]) }), calls),
    });
    const result = await port.download(imageDescriptor());
    expect(result).toMatchObject({ ok: false, code: "media_download_failed" });
    if (result.ok) {
      throw new Error("expected refusal");
    }
    expect(result.reason).toMatch(/HTTP 401/);
    // Single integral URL fetch: verbatim descriptor URL, no binary-only
    // endpoint, no `?download=true`, no key material in the query string.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://waha.test/api/files/img-0001.jpg");
    expect(calls[0]?.url).not.toContain("x-api-key");
    expect(calls[0]?.url).not.toContain("download=true");
    expect(calls[0]?.headers["X-Api-Key"]).toBe("secret-key");
  });

  it("never sends the api key as a URL query on success (header only)", async () => {
    const calls: CapturedCall[] = [];
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      apiKey: "secret-key",
      fetchImpl: stubFetch(
        () => ({ status: 200, mime: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) }),
        calls,
      ),
    });
    const result = await port.download(imageDescriptor());
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://waha.test/api/files/img-0001.jpg");
    expect(new URL(calls[0]?.url ?? "").search).toBe("");
    expect(calls[0]?.headers["X-Api-Key"]).toBe("secret-key");
  });

  it("omits X-Api-Key when no apiKey is configured (optional, fail-closed clear)", async () => {
    const calls: CapturedCall[] = [];
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      fetchImpl: stubFetch(
        () => ({ status: 200, mime: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) }),
        calls,
      ),
    });
    const result = await port.download(imageDescriptor());
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect("X-Api-Key" in (calls[0]?.headers ?? {})).toBe(false);
  });

  it("treats an empty apiKey as absent (no empty header emitted)", async () => {
    const calls: CapturedCall[] = [];
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      apiKey: "",
      fetchImpl: stubFetch(
        () => ({ status: 200, mime: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) }),
        calls,
      ),
    });
    const result = await port.download(imageDescriptor());
    expect(result.ok).toBe(true);
    expect("X-Api-Key" in (calls[0]?.headers ?? {})).toBe(false);
  });

  it("refuses a redirect chain past the hop budget", async () => {
    const calls: CapturedCall[] = [];
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      fetchImpl: stubFetch((url) => ({ status: 302, location: `${url}/next` }), calls),
    });
    const result = await port.download(imageDescriptor());
    expect(result).toMatchObject({ ok: false, code: "media_download_failed" });
    if (result.ok) {
      throw new Error("expected refusal");
    }
    expect(result.reason).toMatch(/exceeded/);
    expect(calls).toHaveLength(1 + MEDIA_MAX_REDIRECT_HOPS);
  });

  it("refuses an oversized content-length before reading the body", async () => {
    let pulls = 0;
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      fetchImpl: stubFetch(() => ({
        status: 200,
        mime: "image/jpeg",
        contentLength: String(MEDIA_MAX_BYTES.IMAGE + 1),
        chunks: [new Uint8Array([1, 2, 3])],
        onPull: () => {
          pulls += 1;
        },
      })),
    });
    const result = await port.download(imageDescriptor());
    expect(result).toMatchObject({ ok: false, code: "media_invalid" });
    if (result.ok) {
      throw new Error("expected refusal");
    }
    expect(result.reason).toMatch(/oversized IMAGE/);
    expect(pulls).toBe(0);
  });

  it("aborts a chunked stream without content-length above the cap with bounded reads", async () => {
    let pulls = 0;
    let bytesRead = 0;
    const oneMiB = new Uint8Array(1024 * 1024);
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      fetchImpl: stubFetch(() => ({
        status: 200,
        mime: "image/jpeg",
        chunks: Array.from({ length: 20 }, () => oneMiB),
        onPull: () => {
          pulls += 1;
          bytesRead += oneMiB.length;
        },
      })),
    });
    const result = await port.download(imageDescriptor());
    expect(result).toMatchObject({ ok: false, code: "media_invalid" });
    if (result.ok) {
      throw new Error("expected refusal");
    }
    expect(result.reason).toMatch(/exceeds/);
    // IMAGE cap is 8 MiB: the 9th MiB trips the abort, so at most 9 pulls
    // and 9 MiB ever cross the boundary — never the full 20 MiB.
    expect(pulls).toBeLessThanOrEqual(9);
    expect(bytesRead).toBeLessThanOrEqual(MEDIA_MAX_BYTES.IMAGE + oneMiB.length);
  });

  it("refuses a null body without a valid content-length (fail-closed)", async () => {
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      fetchImpl: stubFetch(() => ({ status: 200, mime: "image/jpeg", bodyNull: true })),
    });
    await expect(port.download(imageDescriptor())).resolves.toMatchObject({
      ok: false,
      code: "media_download_failed",
    });
  });

  it("accepts a null body only with a valid content-length, rechecked after the read", async () => {
    const port = new HttpWahaMediaPort({
      allowedHosts: ["waha.test"],
      fetchImpl: stubFetch(() => ({
        status: 200,
        mime: "image/jpeg",
        contentLength: "3",
        bytes: new Uint8Array([1, 2, 3]),
        bodyNull: true,
      })),
    });
    const result = await port.download(imageDescriptor());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.fetched.sizeBytes).toBe(3);
  });
});

describe("media metadata + ingest validation seam", () => {
  it("marks audio transcription as explicit follow-up (no pipeline invented)", () => {
    const metadata = mediaMetadataFor(
      {
        contentType: "AUDIO",
        mediaUrl: "https://waha.test/f.ogg",
        declaredMime: "audio/ogg",
        fileName: null,
        sizeBytes: 9000,
        durationSeconds: null,
        caption: null,
      },
      { bytes: new Uint8Array([1]), mimeType: "audio/ogg", sizeBytes: 1 },
    );
    expect(metadata["transcription"]).toEqual({ status: "PENDING_FOLLOW_UP", engine: null, transcriptRef: null });
    expect(metadata["durationUnknown"]).toBe(true);
  });

  it("omits the transcription marker for non-audio media", () => {
    const metadata = mediaMetadataFor(
      {
        contentType: "IMAGE",
        mediaUrl: "https://waha.test/i.jpg",
        declaredMime: "image/jpeg",
        fileName: null,
        sizeBytes: 10,
        durationSeconds: null,
        caption: null,
      },
      null,
    );
    expect("transcription" in metadata).toBe(false);
  });

  it("rejects media ingest without attachmentRef (mirrors the DB check)", async () => {
    const db = new MemoryDb();
    const bus = new CommandBus(db);
    registerCrmCommands(bus);
    registerCommunicationCommands(bus);
    const person = (await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Media P",
      identities: [{ identityType: "WHATSAPP", normalizedValue: "5511999990001" }],
    })) as { ok: true; data: { id: string } };
    const conv = (await bus.execute<{ id: string }>(actor(), "conversation.start_manual", {
      personId: person.data.id,
      channel: "WHATSAPP",
    })) as { ok: true; data: { id: string } };
    expect(conv.data.id).toMatch(/^[0-9a-f-]{36}$/);

    const missing = await bus.execute(actor(), "message.ingest", {
      channel: "WHATSAPP",
      externalMessageId: tag("wamsg"),
      from: "5511999990001@c.us",
      text: "",
      occurredAt: new Date().toISOString(),
      contentType: "IMAGE",
    });
    expect(missing.ok ? null : missing.code).toBe("validation_failed");

    const stored = await bus.execute(actor(), "message.ingest", {
      channel: "WHATSAPP",
      externalMessageId: tag("wamsg"),
      from: "5511999990001@c.us",
      text: "",
      occurredAt: new Date().toISOString(),
      contentType: "IMAGE",
      attachmentRef: "waha:test:image",
      mediaMetadata: { mediaKind: "IMAGE" },
    });
    expect(stored.ok).toBe(true);
  });
});
