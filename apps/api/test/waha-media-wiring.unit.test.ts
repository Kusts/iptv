import { afterEach, describe, expect, it } from "vitest";
import { defaultWahaMediaPort, wahaMediaPortFromEnv } from "../src/communications/waha-media.js";
import { WahaMediaPortProvider } from "../src/communications/waha-media.provider.js";

/**
 * EXEC-WAHA-MEDIA-WIRING-20261020: env wiring of `WAHA_MEDIA_PORT`.
 *
 * - With `WAHA_BASE_URL` + `WAHA_API_KEY` present, the port allowlists exactly
 *   the WAHA origin and sends the key as an `X-Api-Key` header (never in the
 *   URL, never logged — only presence is observable).
 * - With either var absent/blank (or an unparsable base URL) the port stays
 *   fail-closed, identical to `defaultWahaMediaPort()`: zero fetches, every
 *   download refused.
 * - Zero real network: every fetch here is a controlled stub double.
 */

const FIXTURE_KEY = "waha-media-wiring fixture key, not a credential";

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

function imageDescriptor(mediaUrl: string) {
  return {
    contentType: "IMAGE" as const,
    mediaUrl,
    declaredMime: "image/jpeg",
    fileName: null,
    sizeBytes: null,
    durationSeconds: null,
    caption: null,
  };
}

const savedBaseUrl = process.env["WAHA_BASE_URL"];
const savedApiKey = process.env["WAHA_API_KEY"];

afterEach(() => {
  if (savedBaseUrl === undefined) {
    delete process.env["WAHA_BASE_URL"];
  } else {
    process.env["WAHA_BASE_URL"] = savedBaseUrl;
  }
  if (savedApiKey === undefined) {
    delete process.env["WAHA_API_KEY"];
  } else {
    process.env["WAHA_API_KEY"] = savedApiKey;
  }
});

describe("wahaMediaPortFromEnv", () => {
  it("sends X-Api-Key on the WAHA origin when env is present", async () => {
    const calls: CapturedCall[] = [];
    const port = wahaMediaPortFromEnv(
      { WAHA_BASE_URL: "https://waha.test", WAHA_API_KEY: FIXTURE_KEY },
      stubFetch(() => ({ status: 200, mime: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) }), calls),
    );
    const result = await port.download(imageDescriptor("https://waha.test/api/files/img-0001.jpg"));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://waha.test/api/files/img-0001.jpg");
    expect(calls[0]?.url).not.toContain("api-key");
    expect(calls[0]?.headers["X-Api-Key"]).toBe(FIXTURE_KEY);
  });

  it("allowlists the WAHA host: a foreign origin is refused without fetching", async () => {
    const calls: CapturedCall[] = [];
    const port = wahaMediaPortFromEnv(
      { WAHA_BASE_URL: "https://waha.test", WAHA_API_KEY: FIXTURE_KEY },
      stubFetch(() => ({ status: 200, mime: "image/jpeg", bytes: new Uint8Array([1]) }), calls),
    );
    const result = await port.download(imageDescriptor("https://evil.test/stolen.jpg"));
    expect(result).toMatchObject({ ok: false, code: "media_unavailable" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["both absent", {}],
    ["blank base url", { WAHA_BASE_URL: "", WAHA_API_KEY: FIXTURE_KEY }],
    ["blank api key", { WAHA_BASE_URL: "https://waha.test", WAHA_API_KEY: "   " }],
    ["key without base", { WAHA_API_KEY: FIXTURE_KEY }],
    ["base without key", { WAHA_BASE_URL: "https://waha.test" }],
    ["unparsable base", { WAHA_BASE_URL: "not a url %%", WAHA_API_KEY: FIXTURE_KEY }],
  ])("stays fail-closed when %s (zero fetch, same as the default)", async (_label, env) => {
    const calls: CapturedCall[] = [];
    const port = wahaMediaPortFromEnv(
      env,
      stubFetch(() => ({ status: 200, mime: "image/jpeg", bytes: new Uint8Array([1]) }), calls),
    );
    const expected = await defaultWahaMediaPort().download(
      imageDescriptor("https://waha.test/api/files/img-0001.jpg"),
    );
    const result = await port.download(imageDescriptor("https://waha.test/api/files/img-0001.jpg"));
    expect(calls).toHaveLength(0);
    expect(result).toEqual(expected);
    expect(result).toMatchObject({ ok: false, code: "media_unavailable" });
  });

  it("never leaks the key into reasons or urls (presence only)", async () => {
    const calls: CapturedCall[] = [];
    const port = wahaMediaPortFromEnv(
      { WAHA_BASE_URL: "https://waha.test", WAHA_API_KEY: FIXTURE_KEY },
      stubFetch(() => ({ status: 200, mime: "image/jpeg", bytes: new Uint8Array([1]) }), calls),
    );
    const refused = await port.download(imageDescriptor("https://evil.test/stolen.jpg"));
    const serialized = JSON.stringify(refused);
    expect(serialized).not.toContain(FIXTURE_KEY);
    for (const call of calls) {
      expect(call.url).not.toContain(FIXTURE_KEY);
    }
  });
});

describe("WahaMediaPortProvider", () => {
  it("resolves fail-closed without env (zero fetch, identical to the default)", async () => {
    delete process.env["WAHA_BASE_URL"];
    delete process.env["WAHA_API_KEY"];
    const port = WahaMediaPortProvider.useFactory();
    const expected = await defaultWahaMediaPort().download(
      imageDescriptor("https://waha.test/api/files/img-0001.jpg"),
    );
    // No fetch stub is injected here on purpose: the fail-closed port must
    // refuse before any request is issued, so the global fetch is untouched.
    const result = await port.download(imageDescriptor("https://waha.test/api/files/img-0001.jpg"));
    expect(result).toEqual(expected);
    expect(result).toMatchObject({ ok: false, code: "media_unavailable" });
  });
});
