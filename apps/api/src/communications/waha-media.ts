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
  /** Hosts allowed as download origins. Empty (default) refuses everything. */
  allowedHosts?: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  apiKey?: string;
}

/**
 * HTTP downloader with an origin allowlist (SSRF guard), timeout, fetched
 * size cap, and post-download MIME gate. With no `allowedHosts` configured it
 * refuses every URL — fail-closed by default.
 */
export class HttpWahaMediaPort implements WahaMediaPort {
  readonly name = "waha-media-http";
  private readonly allowedHosts: string[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string | null;

  constructor(options: HttpWahaMediaOptions = {}) {
    this.allowedHosts = options.allowedHosts ?? [];
    this.timeoutMs = options.timeoutMs ?? MEDIA_DOWNLOAD_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey ?? null;
  }

  async download(descriptor: WahaMediaDescriptor): Promise<MediaDownloadResult> {
    const preflight = validateMediaDescriptor(descriptor);
    if (!preflight.ok) {
      return preflight;
    }
    let url: URL;
    try {
      url = new URL(descriptor.mediaUrl as string);
    } catch {
      return { ok: false, code: "media_invalid", reason: "malformed media url" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, code: "media_invalid", reason: `refused media scheme: ${url.protocol}` };
    }
    if (!this.allowedHosts.includes(url.hostname)) {
      return { ok: false, code: "media_unavailable", reason: `media host not allowlisted: ${url.hostname}` };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey !== null) {
        headers["X-Api-Key"] = this.apiKey;
      }
      const res = await this.fetchImpl(url.toString(), { headers, signal: controller.signal });
      if (!res.ok) {
        return { ok: false, code: "media_download_failed", reason: `media fetch HTTP ${res.status}` };
      }
      const buffer = new Uint8Array(await res.arrayBuffer());
      if (buffer.length > MEDIA_MAX_BYTES[descriptor.contentType]) {
        return {
          ok: false,
          code: "media_invalid",
          reason: `oversized ${descriptor.contentType}: ${buffer.length} > ${MEDIA_MAX_BYTES[descriptor.contentType]}`,
        };
      }
      const mimeGate = assertFetchedMime(descriptor.contentType, res.headers.get("content-type"));
      if (!mimeGate.ok) {
        return { ok: false, code: "media_invalid", reason: mimeGate.reason };
      }
      const mimeType = (res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "application/octet-stream");
      return { ok: true, fetched: { bytes: buffer, mimeType, sizeBytes: buffer.length } };
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
