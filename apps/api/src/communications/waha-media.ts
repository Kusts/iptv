/**
 * WAHA inbound media/audio ingest (G01/WAHA closure).
 *
 * Bounded seam: the normalizer identifies image/audio/document/video inbound
 * shapes; this module validates and fetches the bytes behind an explicit,
 * injectable port. Production wiring stays fail-closed (empty allowlist →
 * every download refused, recorded as an exception, never a message row), and
 * tests inject controlled doubles — no network calls to real WAHA/WhatsApp.
 *
 * Limits (per canonical gate `10-integrations-certification.md:17-21`,
 * "required media/audio"):
 * - IMAGE ≤ 8 MiB, AUDIO ≤ 16 MiB, DOCUMENT ≤ 16 MiB, VIDEO ≤ 32 MiB.
 * - AUDIO duration ≤ 600 s when the provider reports it; when unreported no
 *   duration gate applies (recorded as `durationUnknown: true`).
 * - Download timeout 10 s default. MIME allowlists per content type; a
 *   declared/fetched mismatch is an invalid file, never persisted as media.
 *
 * TRANSCRIPTION SEAM (explicit follow-up, NOT implemented here): audio that
 * ingests successfully carries
 * `metadata_json.transcription = { status: "PENDING_FOLLOW_UP" }`. No
 * transcription service exists in the codebase (verified 2026-10-11: only
 * docs mentions of transcripts, no code port). A future pipeline should claim
 * rows by that marker; until then audio is stored with metadata only.
 */

export type WahaMediaContentType = "IMAGE" | "AUDIO" | "DOCUMENT" | "VIDEO";

export interface WahaMediaDescriptor {
  contentType: WahaMediaContentType;
  /** Where to fetch the bytes (WAHA-hosted URL). Null when unreported. */
  mediaUrl: string | null;
  /** MIME as declared by the webhook payload, if any. */
  declaredMime: string | null;
  fileName: string | null;
  /** Provider-reported size/duration, when present. */
  sizeBytes: number | null;
  durationSeconds: number | null;
  caption: string | null;
}

export const MEDIA_MAX_BYTES: Record<WahaMediaContentType, number> = {
  IMAGE: 8 * 1024 * 1024,
  AUDIO: 16 * 1024 * 1024,
  DOCUMENT: 16 * 1024 * 1024,
  VIDEO: 32 * 1024 * 1024,
};

export const MEDIA_MIME_ALLOWLIST: Record<WahaMediaContentType, readonly string[]> = {
  IMAGE: ["image/jpeg", "image/png", "image/webp"],
  AUDIO: ["audio/mpeg", "audio/ogg", "audio/mp4", "audio/wav", "audio/webm", "audio/aac", "audio/x-wav"],
  DOCUMENT: ["application/pdf"],
  VIDEO: ["video/mp4"],
};

export const MEDIA_MAX_AUDIO_SECONDS = 600;
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 10_000;

/**
 * Max redirects followed per download. Every hop is revalidated (scheme +
 * origin allowlist); the redirect chain never inherits trust from the
 * initial URL, and `redirect: "manual"` keeps the loop explicit.
 */
export const MEDIA_MAX_REDIRECT_HOPS = 3;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Parse a `Content-Length` header value. Returns null when absent, empty, or
 * non-numeric (multiple values: first entry wins). A null result means "no
 * trustworthy pre-check" — the bounded stream read below stays authoritative.
 */
function parseContentLength(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const first = value.split(",")[0]?.trim() ?? "";
  if (!/^\d+$/.test(first)) {
    return null;
  }
  const parsed = Number(first);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Bounded body read. A present `ReadableStream` is consumed chunk by chunk
 * with a running total; the read aborts (fail-closed) as soon as the cap is
 * exceeded, so an unbounded or lying origin cannot force the full payload
 * into memory. A null body (opaque/empty responses, non-streaming doubles)
 * is refused unless a present, numeric `Content-Length` fits the cap — and
 * even then the single-shot read is rechecked after the fact.
 */
async function readBoundedBytes(
  res: Response,
  cap: number,
): Promise<
  | { ok: true; bytes: Uint8Array }
  | { ok: false; code: "media_invalid" | "media_download_failed"; reason: string }
> {
  const stream = res.body;
  if (stream === null) {
    const declared = parseContentLength(res.headers.get("content-length"));
    if (declared === null || declared > cap) {
      return { ok: false, code: "media_download_failed", reason: "media body unavailable for bounded read" };
    }
    const buffer = new Uint8Array(await res.arrayBuffer());
    if (buffer.length > cap) {
      return {
        ok: false,
        code: "media_invalid",
        reason: `oversized download: ${buffer.length} > ${cap}`,
      };
    }
    return { ok: true, bytes: buffer };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const raw: unknown = value;
      let chunk: Uint8Array;
      if (typeof raw === "string") {
        chunk = new TextEncoder().encode(raw);
      } else if (raw instanceof Uint8Array) {
        chunk = raw;
      } else if (ArrayBuffer.isView(raw)) {
        chunk = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      } else {
        try {
          await reader.cancel();
        } catch {
          // Release-only; the failure below is authoritative.
        }
        return { ok: false, code: "media_download_failed", reason: "unsupported media stream chunk" };
      }
      total += chunk.length;
      if (total > cap) {
        try {
          await reader.cancel();
        } catch {
          // Release-only; the refusal below is authoritative.
        }
        return { ok: false, code: "media_invalid", reason: `oversized download: exceeds ${cap} bytes` };
      }
      chunks.push(chunk);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "media_download_failed", reason: `media stream failed: ${message}` };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, bytes };
}

export type MediaValidation =
  | { ok: true; descriptor: WahaMediaDescriptor }
  | { ok: false; code: "media_unavailable" | "media_invalid"; reason: string };

/**
 * Pure pre-flight validation over the descriptor (no I/O): availability,
 * declared-size cap, declared-MIME allowlist, reported-duration cap.
 * A fetched `Content-Type` mismatch is checked again post-download by the
 * port (`assertFetchedMime`).
 */
export function validateMediaDescriptor(descriptor: WahaMediaDescriptor): MediaValidation {
  if (descriptor.mediaUrl === null) {
    return { ok: false, code: "media_unavailable", reason: "media url not reported by provider payload" };
  }
  if (descriptor.sizeBytes !== null && descriptor.sizeBytes > MEDIA_MAX_BYTES[descriptor.contentType]) {
    return {
      ok: false,
      code: "media_invalid",
      reason: `oversized ${descriptor.contentType}: ${descriptor.sizeBytes} > ${MEDIA_MAX_BYTES[descriptor.contentType]}`,
    };
  }
  if (descriptor.declaredMime !== null) {
    const mime = descriptor.declaredMime.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!MEDIA_MIME_ALLOWLIST[descriptor.contentType].includes(mime)) {
      return {
        ok: false,
        code: "media_invalid",
        reason: `mismatched MIME for ${descriptor.contentType}: ${descriptor.declaredMime}`,
      };
    }
  }
  if (
    descriptor.contentType === "AUDIO" &&
    descriptor.durationSeconds !== null &&
    descriptor.durationSeconds > MEDIA_MAX_AUDIO_SECONDS
  ) {
    return {
      ok: false,
      code: "media_invalid",
      reason: `audio duration ${descriptor.durationSeconds}s exceeds ${MEDIA_MAX_AUDIO_SECONDS}s`,
    };
  }
  return { ok: true, descriptor };
}

/** Post-download MIME gate: fetched bytes must match the content type. */
export function assertFetchedMime(
  contentType: WahaMediaContentType,
  fetchedMime: string | null,
): { ok: true } | { ok: false; reason: string } {
  if (fetchedMime === null) {
    return { ok: false, reason: `missing Content-Type for ${contentType}` };
  }
  const mime = fetchedMime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!MEDIA_MIME_ALLOWLIST[contentType].includes(mime)) {
    return { ok: false, reason: `mismatched fetched MIME for ${contentType}: ${fetchedMime}` };
  }
  return { ok: true };
}

export interface FetchedMedia {
  bytes: Uint8Array;
  mimeType: string;
  sizeBytes: number;
}

export type MediaDownloadResult =
  | { ok: true; fetched: FetchedMedia }
  | { ok: false; code: "media_unavailable" | "media_download_failed" | "media_invalid"; reason: string };

export interface WahaMediaPort {
  readonly name: string;
  download(descriptor: WahaMediaDescriptor): Promise<MediaDownloadResult>;
}

export interface HttpWahaMediaOptions {
  /**
   * Allowed download origins. Entries may be bare hosts (`waha.example`,
   * optionally with `:port`) — pinned to `https:` — or full origins
   * (`https://waha.example`, `http://waha.local:3000`). Empty (default)
   * refuses everything. Comparison is exact `URL.origin`
   * (scheme+host+port): an `https` entry never authorizes the `http`
   * downgrade or a port swap.
   *
   * Loopback origins (`localhost`, `127.0.0.0/8`, `::1`) are NEVER
   * admitted, even when listed here: entries that normalize to a loopback
   * origin are dropped from the allowlist at construction, so a
   * misconfigured caller cannot authorize a fetch back into loopback.
   */
  allowedHosts?: string[];
  /**
   * Public WAHA origin used ONLY to rewrite a loopback `media.url`
   * (`http://localhost:3000/api/files/<nome>`, the loopback the WAHA
   * server reports for its own files and which is never allowlistable).
   * When a `media.url` host is loopback, ONLY its origin is replaced by
   * this base — path/query/fragment travel byte-for-byte and the
   * `X-Api-Key` flow applies to the rewritten public origin exactly as to
   * a natively public URL. Null/invalid/loopback (fail-closed default)
   * keeps the current refusal: loopback URLs are refused, never fetched.
   */
  publicBaseOrigin?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Optional WAHA API key for authorized `media.url` downloads (official
   * `X-Api-Key` header flow). Sent as an `X-Api-Key` header on every fetched
   * hop whose exact origin is allowlisted — never as a `?x-api-key=` URL
   * query (server-side query auth is forbidden: it leaks into logs). Empty
   * or absent means "no credential": no header is sent and the origin gate
   * is unchanged (optional, fail-closed clear).
   */
  apiKey?: string;
}

/**
 * Normalize one allowlist entry to an exact origin (`URL.origin`). Bare
 * hosts pin to `https:`; entries with `://` are taken as explicit origins
 * (the only way to authorize plain `http:`). Returns null when unparseable
 * or on a non-http(s) scheme — fail closed.
 */
function normalizeAllowedOrigin(entry: string): string | null {
  const trimmed = entry.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Loopback-host detection for the media-URL rewrite gate (EXEC-WAHA-MEDIA-FETCH).
 *
 * WAHA reports its own hosted files as `http://localhost:3000/api/files/<nome>`
 * — loopback of the WAHA server itself, unreachable from the API and never
 * allowlistable. Matches `localhost` (incl. `*.localhost`), the full
 * `127.0.0.0/8` range, `::1`, and the mapped `::ffff:127.0.0.0/8` form.
 * Comparison is on the lowercased `URL.hostname` (IPv6 without brackets).
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  // `URL.hostname` keeps IPv6 brackets (`[::1]`); strip them for comparison.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "localhost" || bare.endsWith(".localhost")) {
    return true;
  }
  if (bare === "::1") {
    return true;
  }
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) {
    return true;
  }
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) {
    return true;
  }
  return false;
}

/**
 * Normalize a public-base origin for the loopback rewrite. Returns the exact
 * `URL.origin` when the base parses to `http(s):` with a NON-loopback host,
 * else null (absent/invalid/loopback base ⇒ fail closed, exactly like an
 * empty allowlist — loopback is never accepted as a fetch destination).
 */
export function normalizePublicBaseOrigin(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }
  try {
    const base = new URL(raw.trim());
    if (base.protocol !== "https:" && base.protocol !== "http:") {
      return null;
    }
    if (isLoopbackHostname(base.hostname)) {
      return null;
    }
    return base.origin;
  } catch {
    return null;
  }
}

/**
 * Resolve the fetch target for a `media.url`. Non-loopback URLs pass through
 * verbatim (the exact-origin allowlist below stays authoritative). Loopback
 * URLs are rewritten to `publicBaseOrigin` — origin ONLY, path/query/hash
 * byte-for-byte — and return null when no usable public base exists (fail
 * closed, same refusal as today) or when the media URL itself is malformed.
 */
export function resolveMediaTargetUrl(
  mediaUrl: string,
  publicBaseOrigin: string | null,
): URL | null {
  let current: URL;
  try {
    current = new URL(mediaUrl);
  } catch {
    return null;
  }
  if (!isLoopbackHostname(current.hostname)) {
    return current;
  }
  const base = normalizePublicBaseOrigin(publicBaseOrigin);
  if (base === null) {
    return null;
  }
  return new URL(`${base}${current.pathname}${current.search}${current.hash}`);
}

/**
 * HTTP downloader with an exact-origin allowlist (SSRF guard), manual
 * redirect handling (every hop revalidated, max {@link MEDIA_MAX_REDIRECT_HOPS}
 * followed), timeout, bounded stream read with a `Content-Length` pre-check,
 * and a header-only MIME gate before any byte is read. With no allowlist
 * configured it refuses every URL — fail-closed by default. The `X-Api-Key`
 * credential is only ever attached to a request whose exact origin
 * (scheme+host+port) is allowlisted — an `https` entry never sends the key
 * over the `http` downgrade or to a swapped port.
 */
export class HttpWahaMediaPort implements WahaMediaPort {
  readonly name = "waha-media-http";
  private readonly allowedOrigins: Set<string>;
  private readonly publicBaseOrigin: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string | null;

  constructor(options: HttpWahaMediaOptions = {}) {
    this.allowedOrigins = new Set(
      (options.allowedHosts ?? [])
        .map((entry) => normalizeAllowedOrigin(entry))
        .filter((origin): origin is string => origin !== null)
        // Loopback is never allowlistable: a configured localhost entry is
        // dropped here, so no fetch is ever issued back into loopback.
        .filter((origin) => {
          try {
            return !isLoopbackHostname(new URL(origin).hostname);
          } catch {
            return false;
          }
        }),
    );
    this.publicBaseOrigin = normalizePublicBaseOrigin(options.publicBaseOrigin ?? null);
    this.timeoutMs = options.timeoutMs ?? MEDIA_DOWNLOAD_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    // Empty/whitespace-only keys are treated as absent (repo convention:
    // empty env values mean "not configured") so no empty `X-Api-Key`
    // header is ever emitted; the credential itself is used verbatim.
    const candidateKey = options.apiKey ?? null;
    this.apiKey = candidateKey !== null && candidateKey.trim().length > 0 ? candidateKey : null;
  }

  private checkAllowedUrl(
    url: URL,
    where: "media" | "media redirect",
  ): { ok: true } | { ok: false; code: "media_unavailable" | "media_invalid"; reason: string } {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, code: "media_invalid", reason: `refused ${where} scheme: ${url.protocol}` };
    }
    if (!this.allowedOrigins.has(url.origin)) {
      return { ok: false, code: "media_unavailable", reason: `${where} origin not allowlisted: ${url.origin}` };
    }
    return { ok: true };
  }

  async download(descriptor: WahaMediaDescriptor): Promise<MediaDownloadResult> {
    const preflight = validateMediaDescriptor(descriptor);
    if (!preflight.ok) {
      return preflight;
    }
    const cap = MEDIA_MAX_BYTES[descriptor.contentType];
    let current: URL;
    try {
      current = new URL(descriptor.mediaUrl as string);
    } catch {
      return { ok: false, code: "media_invalid", reason: "malformed media url" };
    }
    if (isLoopbackHostname(current.hostname)) {
      // WAHA-reported loopback (`http://localhost:3000/...`): rewrite ONLY
      // the origin to the configured public base, path/query/hash
      // byte-for-byte. No usable base (absent/invalid/loopback) ⇒ fail
      // closed exactly like a non-allowlisted origin, zero fetch.
      const rewritten = resolveMediaTargetUrl(descriptor.mediaUrl as string, this.publicBaseOrigin);
      if (rewritten === null) {
        return { ok: false, code: "media_unavailable", reason: `media host not allowlisted: ${current.origin}` };
      }
      current = rewritten;
    }
    const initial = this.checkAllowedUrl(current, "media");
    if (!initial.ok) {
      return initial;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      for (let hop = 0; ; hop += 1) {
        const headers: Record<string, string> = {};
        // Every fetched hop passed the exact-origin gate above (the initial
        // URL plus each revalidated redirect target), and the membership is
        // rechecked here so the key is only ever sent to an authorized
        // origin. A downgraded (`http:`) or port-swapped redirect target is
        // refused BEFORE any request to it is issued — the key never leaves
        // the authorized origin.
        if (this.apiKey !== null && this.allowedOrigins.has(current.origin)) {
          headers["X-Api-Key"] = this.apiKey;
        }
        const res = await this.fetchImpl(current.toString(), {
          headers,
          signal: controller.signal,
          redirect: "manual",
        });
        if (REDIRECT_STATUSES.has(res.status)) {
          if (hop >= MEDIA_MAX_REDIRECT_HOPS) {
            return {
              ok: false,
              code: "media_download_failed",
              reason: `media redirect exceeded ${MEDIA_MAX_REDIRECT_HOPS} hops`,
            };
          }
          const location = res.headers.get("location");
          if (location === null) {
            return {
              ok: false,
              code: "media_download_failed",
              reason: `media redirect without location (HTTP ${res.status})`,
            };
          }
          let next: URL;
          try {
            // Relative Location values resolve against the current URL.
            next = new URL(location, current.toString());
          } catch {
            return { ok: false, code: "media_download_failed", reason: "invalid media redirect location" };
          }
          const gated = this.checkAllowedUrl(next, "media redirect");
          if (!gated.ok) {
            return gated;
          }
          current = next;
          continue;
        }
        if (!res.ok) {
          return { ok: false, code: "media_download_failed", reason: `media fetch HTTP ${res.status}` };
        }
        // Header-only MIME gate before any byte is read.
        const mimeGate = assertFetchedMime(descriptor.contentType, res.headers.get("content-type"));
        if (!mimeGate.ok) {
          return { ok: false, code: "media_invalid", reason: mimeGate.reason };
        }
        // Fail fast on a truthful Content-Length; a lying origin is still
        // caught by the bounded stream read below.
        const declared = parseContentLength(res.headers.get("content-length"));
        if (declared !== null && declared > cap) {
          return {
            ok: false,
            code: "media_invalid",
            reason: `oversized ${descriptor.contentType}: ${declared} > ${cap}`,
          };
        }
        const body = await readBoundedBytes(res, cap);
        if (!body.ok) {
          return body;
        }
        const mimeType = (res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "application/octet-stream");
        return { ok: true, fetched: { bytes: body.bytes, mimeType, sizeBytes: body.bytes.length } };
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, code: "media_download_failed", reason: "media fetch timed out" };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "media_download_failed", reason: `media fetch failed: ${message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Fail-closed default: no allowlist, so every download is refused. */
export function defaultWahaMediaPort(): WahaMediaPort {
  return new HttpWahaMediaPort();
}

/**
 * Env wiring for the webhook media path (`WAHA_MEDIA_PORT` provider).
 *
 * Reads `WAHA_BASE_URL` + `WAHA_API_KEY` following the repo rule (empty means
 * absent). When both carry a non-blank value and the base URL parses to a
 * NON-loopback `http(s):` origin, the port allowlists exactly that WAHA
 * origin (`URL.origin`, so scheme+host+port must match), sends the key as an
 * `X-Api-Key` header — never as a URL query, never logged (only presence is
 * observable from the outside) — and rewrites WAHA-reported loopback
 * `media.url`s to that same origin (path/query/hash byte-for-byte).
 *
 * Any missing/blank/unparsable value — or a base URL that itself points at
 * loopback (localhost is never a fetch destination) — keeps the current
 * fail-closed behavior: an empty allowlist that refuses every download,
 * identical to `defaultWahaMediaPort()`.
 */
export function wahaMediaPortFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): WahaMediaPort {
  const baseUrl = env["WAHA_BASE_URL"];
  const apiKey = env["WAHA_API_KEY"];
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    return defaultWahaMediaPort();
  }
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    return defaultWahaMediaPort();
  }
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return defaultWahaMediaPort();
  }
  if (normalizePublicBaseOrigin(origin) === null) {
    // Non-http(s) or loopback base: never allowlist localhost, fail closed.
    return defaultWahaMediaPort();
  }
  return new HttpWahaMediaPort({ apiKey, allowedHosts: [origin], publicBaseOrigin: origin, fetchImpl });
}

/**
 * Metadata persisted on `communication.messages.metadata_json` for ingested
 * media. `transcription.status` is ALWAYS `PENDING_FOLLOW_UP` for audio —
 * the explicit follow-up marker (no transcription pipeline exists yet).
 */
export function mediaMetadataFor(
  descriptor: WahaMediaDescriptor,
  fetched: FetchedMedia | null,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    provider: "waha",
    mediaKind: descriptor.contentType,
    mimeType: fetched?.mimeType ?? descriptor.declaredMime,
    fileName: descriptor.fileName,
    sizeBytes: fetched?.sizeBytes ?? descriptor.sizeBytes,
    durationSeconds: descriptor.durationSeconds,
    durationUnknown: descriptor.durationSeconds === null,
    caption: descriptor.caption,
    sourceUrl: descriptor.mediaUrl,
  };
  if (descriptor.contentType === "AUDIO") {
    base["transcription"] = { status: "PENDING_FOLLOW_UP", engine: null, transcriptRef: null };
  }
  return base;
}
