import { describe, expect, it } from "vitest";
import {
  HttpWahaMediaPort,
  isLoopbackHostname,
  normalizePublicBaseOrigin,
  resolveMediaTargetUrl,
  wahaMediaPortFromEnv,
  type WahaMediaDescriptor,
} from "../src/communications/waha-media.js";

/**
 * EXEC-WAHA-MEDIA-FETCH-20261020: loopback → public origin rewrite.
 *
 * WAHA reports its own files as `http://localhost:3000/api/files/<nome>`
 * (loopback of the WAHA server, unreachable and never allowlistable).
 * The port rewrites ONLY the origin to the configured public base
 * (`WAHA_BASE_URL`), keeping path/query/fragment byte-for-byte, and the
 * `X-Api-Key` flow applies to the rewritten public origin exactly as to a
 * natively public URL. Zero real network: every fetch is a stub double and
 * every localhost URL must produce zero fetch calls.
 *
 * Deterministic fixtures: counters only, never UUID-head slices.
 */

const FIXTURE_KEY = "host-rewrite fixture key, not a credential";

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(
  handler: (url: string) => { status: number; mime?: string; bytes?: Uint8Array },
  calls: CapturedCall[] = [],
): typeof fetch {
  return (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers ?? {}) } });
    const out = handler(url);
    const bytes = out.bytes ?? new Uint8Array([]);
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? (out.mime ?? null) : null) },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  }) as unknown as typeof fetch;
}

function imageDescriptor(mediaUrl: string): WahaMediaDescriptor {
  return {
    contentType: "IMAGE",
    mediaUrl,
    declaredMime: "image/jpeg",
    fileName: null,
    sizeBytes: null,
    durationSeconds: null,
    caption: null,
  };
}

describe("isLoopbackHostname", () => {
  it.each([["localhost"], ["LOCALHOST"], ["[::1]"], ["127.0.0.1"], ["127.0.0.2"], ["127.255.0.1"], ["::1"], ["::ffff:127.0.0.1"]])(
    "treats %s as loopback",
    (host) => {
      expect(isLoopbackHostname(host)).toBe(true);
    },
  );

  it.each([["waha.test"], ["waha.local"], ["10.0.0.1"], ["192.168.1.10"], ["example.com"], ["127.0.0.1.evil.test"]])(
    "does not treat %s as loopback",
    (host) => {
      expect(isLoopbackHostname(host)).toBe(false);
    },
  );
});

describe("normalizePublicBaseOrigin", () => {
  it("normalizes a public base to its exact origin", () => {
    expect(normalizePublicBaseOrigin("https://waha.test:3000/some/path")).toBe("https://waha.test:3000");
  });

  it.each([["http://localhost:3000"], ["https://localhost"], ["http://127.0.0.1:3000"], ["http://[::1]:3000"]])(
    "refuses a loopback base (%s)",
    (base) => {
      expect(normalizePublicBaseOrigin(base)).toBeNull();
    },
  );

  it.each([[null], [undefined], [""], ["   "], ["not a url %%"], ["ftp://waha.test"]])(
    "refuses %s",
    (base) => {
      expect(normalizePublicBaseOrigin(base as string | null)).toBeNull();
    },
  );
});

describe("resolveMediaTargetUrl", () => {
  it("passes a public URL through verbatim", () => {
    const url = "https://waha.test/api/files/img-0001.jpg?x=1#f";
    expect(resolveMediaTargetUrl(url, "https://waha.test")?.toString()).toBe(url);
  });

  it("rewrites only the origin of a loopback URL, path/query/hash byte-for-byte", () => {
    const resolved = resolveMediaTargetUrl(
      "http://localhost:3000/api/files/abc%20def.jpg?token=abc&x=1#frag",
      "https://waha.test",
    );
    expect(resolved?.toString()).toBe("https://waha.test/api/files/abc%20def.jpg?token=abc&x=1#frag");
  });

  it("returns null for loopback without a usable base (fail closed)", () => {
    expect(resolveMediaTargetUrl("http://localhost:3000/api/files/a.jpg", null)).toBeNull();
    expect(resolveMediaTargetUrl("http://localhost:3000/api/files/a.jpg", "http://localhost:3000")).toBeNull();
    expect(resolveMediaTargetUrl("http://localhost:3000/api/files/a.jpg", "not a url %%")).toBeNull();
  });

  it("returns null for a malformed media URL", () => {
    expect(resolveMediaTargetUrl("%%%", "https://waha.test")).toBeNull();
  });
});

describe("HttpWahaMediaPort loopback rewrite (stub fetch, no network)", () => {
  it("rewrites loopback→public, preserving path/query, with X-Api-Key on the public host", async () => {
    const calls: CapturedCall[] = [];
    const port = new HttpWahaMediaPort({
      allowedHosts: ["https://waha.test"],
      publicBaseOrigin: "https://waha.test",
      apiKey: FIXTURE_KEY,
      fetchImpl: stubFetch(() => ({ status: 200, mime: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) }), calls),
    });
    const result = await port.download(
      imageDescriptor("http://localhost:3000/api/files/img-0001.jpg?download=1"),
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://waha.test/api/files/img-0001.jpg?download=1");
    expect(calls[0]?.url).not.toContain("localhost");
    expect(calls[0]?.url).not.toContain(FIXTURE_KEY);
    expect(calls[0]?.headers["X-Api-Key"]).toBe(FIXTURE_KEY);
  });

  it("fetches a natively public allowlisted URL verbatim (no rewrite)", async () => {
    const calls: CapturedCall[] = [];
    const port = new HttpWahaMediaPort({
      allowedHosts: ["https://waha.test"],
      publicBaseOrigin: "https://waha.test",
      apiKey: FIXTURE_KEY,
      fetchImpl: stubFetch(() => ({ status: 200, mime: "image/jpeg", bytes: new Uint8Array([9]) }), calls),
    });
    const result = await port.download(imageDescriptor("https://waha.test/api/files/img-0001.jpg"));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://waha.test/api/files/img-0001.jpg");
  });

  it.each([["http://127.0.0.1:3000/api/files/a.jpg"], ["http://[::1]:3000/api/files/a.jpg"]])(
    "rewrites %s to the public base",
    async (loopbackUrl) => {
      const calls: CapturedCall[] = [];
      const port = new HttpWahaMediaPort({
        allowedHosts: ["https://waha.test"],
        publicBaseOrigin: "https://waha.test",
        fetchImpl: stubFetch(() => ({ status: 200, mime: "image/jpeg", bytes: new Uint8Array([5]) }), calls),
      });
      const result = await port.download(imageDescriptor(loopbackUrl));
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://waha.test/api/files/a.jpg");
    },
  );

  it("refuses loopback with no public base (fail closed, zero fetch)", async () => {
    const calls: CapturedCall[] = [];
    const port = new HttpWahaMediaPort({
      allowedHosts: ["https://waha.test"],
      fetchImpl: stubFetch(() => ({ status: 200, mime: "image/jpeg", bytes: new Uint8Array([1]) }), calls),
    });
    const result = await port.download(imageDescriptor("http://localhost:3000/api/files/a.jpg"));
    expect(result).toMatchObject({ ok: false, code: "media_unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("never allowlists localhost: a configured loopback entry is dropped", async () => {
    const calls: CapturedCall[] = [];
    const port = new HttpWahaMediaPort({
      allowedHosts: ["http://localhost:3000"],
      publicBaseOrigin: "https://waha.test",
      apiKey: FIXTURE_KEY,
      fetchImpl: stubFetch(() => ({ status: 200, mime: "image/jpeg", bytes: new Uint8Array([1]) }), calls),
    });
    // Even with a public base configured, the rewritten public origin was
    // never allowlisted (only localhost was) → still refused, zero fetch,
    // and no key is ever sent toward loopback.
    const result = await port.download(imageDescriptor("http://localhost:3000/api/files/a.jpg"));
    expect(result).toMatchObject({ ok: false, code: "media_unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a loopback redirect target without fetching it or leaking the key", async () => {
    const calls: CapturedCall[] = [];
    const port = new HttpWahaMediaPort({
      allowedHosts: ["https://waha.test"],
      publicBaseOrigin: "https://waha.test",
      apiKey: FIXTURE_KEY,
      fetchImpl: (async (input: unknown, init?: { headers?: Record<string, string> }) => {
        const url = String(input);
        calls.push({ url, headers: { ...(init?.headers ?? {}) } });
        if (url === "https://waha.test/api/files/a.jpg") {
          return {
            ok: false,
            status: 302,
            headers: { get: (name: string) => (name.toLowerCase() === "location" ? "http://localhost:3000/evil" : null) },
            body: null,
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        throw new Error(`unexpected fetch to ${url}`);
      }) as unknown as typeof fetch,
    });
    const result = await port.download(imageDescriptor("https://waha.test/api/files/a.jpg"));
    expect(result).toMatchObject({ ok: false, code: "media_unavailable" });
    expect(calls).toHaveLength(1);
    for (const call of calls) {
      expect(call.url).not.toContain("localhost");
    }
  });
});

describe("wahaMediaPortFromEnv loopback base (stub fetch, no network)", () => {
  it("stays fail-closed when the base URL itself is loopback (never fetched)", async () => {
    const calls: CapturedCall[] = [];
    const port = wahaMediaPortFromEnv(
      { WAHA_BASE_URL: "http://localhost:3000", WAHA_API_KEY: FIXTURE_KEY },
      stubFetch(() => ({ status: 200, mime: "image/jpeg", bytes: new Uint8Array([1]) }), calls),
    );
    const loopback = await port.download(imageDescriptor("http://localhost:3000/api/files/a.jpg"));
    expect(loopback).toMatchObject({ ok: false, code: "media_unavailable" });
    const publicUrl = await port.download(imageDescriptor("https://waha.test/api/files/a.jpg"));
    expect(publicUrl).toMatchObject({ ok: false, code: "media_unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("rewrites WAHA-reported loopback through the env base end to end", async () => {
    const calls: CapturedCall[] = [];
    const port = wahaMediaPortFromEnv(
      { WAHA_BASE_URL: "https://waha.test", WAHA_API_KEY: FIXTURE_KEY },
      stubFetch(() => ({ status: 200, mime: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) }), calls),
    );
    const result = await port.download(imageDescriptor("http://localhost:3000/api/files/img-0001.jpg"));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://waha.test/api/files/img-0001.jpg");
    expect(calls[0]?.headers["X-Api-Key"]).toBe(FIXTURE_KEY);
  });
});
