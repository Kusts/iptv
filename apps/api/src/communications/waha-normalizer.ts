/**
 * WAHA webhook normalizer (Wave 2). Pure function: provider payload in,
 * canonical inbound fact out. Fixture-driven — every accepted shape has a
 * fixture in `test/fixtures/waha-*.json` covered by unit tests.
 *
 * Unknown event types return `{ kind: "unknown" }`: the inbox row is still
 * acked (202) and marked skipped, and domain state is NEVER mutated.
 */

export type NormalizedWaha =
  | {
      kind: "message";
      /** Stable dedupe key: provider + this id (insert-once). */
      externalId: string;
      from: string;
      fromMe: boolean;
      text: string;
      occurredAt: string;
      session: string | null;
      rawEvent: string;
      /**
       * Present when the inbound carries provider media (image/audio/document/
       * video). Text-only inbound has `media: null` and follows the unchanged
       * TEXT path.
       */
      media: NormalizedWahaMedia | null;
    }
  | { kind: "unknown"; rawEvent: string };

/** Provider media attachment identified on an inbound message (no I/O). */
export interface NormalizedWahaMedia {
  contentType: "IMAGE" | "AUDIO" | "DOCUMENT" | "VIDEO";
  /** WAHA-hosted download URL when the payload reports one. */
  mediaUrl: string | null;
  declaredMime: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  caption: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toIso(timestamp: unknown): string {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  if (typeof timestamp === "string") {
    const date = new Date(timestamp);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return new Date().toISOString();
}

const MESSAGE_EVENTS = new Set([
  "message",
  "message.any",
  "message.text",
  "message.ack",
]);

/** Normalize one raw WAHA webhook body. Never throws on malformed input. */
export function normalizeWahaPayload(raw: unknown): NormalizedWaha {
  const root = asRecord(raw);
  if (root === null) {
    return { kind: "unknown", rawEvent: "malformed" };
  }
  const event = asString(root["event"]) ?? "unknown";
  if (event === "message.ack") {
    // Delivery receipt, not an inbound message: ack without mutation.
    return { kind: "unknown", rawEvent: event };
  }
  if (!MESSAGE_EVENTS.has(event)) {
    return { kind: "unknown", rawEvent: event };
  }
  const payload = asRecord(root["payload"]) ?? root;
  const fromMe = payload["fromMe"] === true;
  if (fromMe) {
    // Echo of our own outbound send: ack without creating inbound state.
    return { kind: "unknown", rawEvent: `${event}:fromMe` };
  }
  const externalId =
    asString(payload["id"]) ??
    asString((asRecord(payload["_data"]) ?? {})["id"]) ??
    null;
  const from =
    asString(payload["from"]) ??
    asString(payload["author"]) ??
    asString(payload["sender"]) ??
    asString(payload["chatId"]) ??
    null;
  const text =
    asString(payload["body"]) ??
    asString(payload["text"]) ??
    asString(payload["caption"]) ??
    "";
  if (externalId === null || from === null) {
    return { kind: "unknown", rawEvent: `${event}:unmatched` };
  }
  return {
    kind: "message",
    externalId,
    from,
    fromMe: false,
    text,
    occurredAt: toIso(payload["timestamp"] ?? root["timestamp"]),
    session: asString(root["session"]),
    rawEvent: event,
    media: identifyWahaMedia(payload),
  };
}

function asNonNegativeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

/**
 * Identify provider media on a message payload (pure, never throws).
 * Accepted WAHA shapes: an explicit `type` (`image`/`audio`/`ptt`/`voice`/
 * `document`/`video`), an explicit media signal (`hasMedia`/`has_media`/
 * `isMedia`) even without URL/MIME/`type` (unavailable → handled downstream
 * as `media_unavailable`, never silently downgraded to TEXT), or a
 * media-bearing field (`mediaUrl`/`url`/`media` object) alongside a
 * MIME/filename hint. Anything else → null (TEXT path).
 */
export function identifyWahaMedia(payload: Record<string, unknown>): NormalizedWahaMedia | null {
  const rawType = payload["type"];
  const type = typeof rawType === "string" ? rawType.trim().toLowerCase() : "";
  const media = asRecord(payload["media"]);
  const mediaUrl =
    asString(payload["mediaUrl"]) ??
    asString(payload["mediaURL"]) ??
    asString(payload["url"]) ??
    (media !== null
      ? (asString(media["url"]) ?? asString(media["mediaUrl"]) ?? asString(media["link"]))
      : null);
  const declaredMime =
    asString(payload["mimetype"]) ??
    asString(payload["mimeType"]) ??
    asString(payload["mime"]) ??
    (media !== null ? (asString(media["mimetype"]) ?? asString(media["mimeType"])) : null);
  const fileName =
    asString(payload["filename"]) ??
    asString(payload["fileName"]) ??
    (media !== null ? (asString(media["filename"]) ?? asString(media["fileName"])) : null);
  const sizeBytes =
    asNonNegativeInt(payload["fileSize"]) ??
    asNonNegativeInt(payload["size"]) ??
    (media !== null ? (asNonNegativeInt(media["fileSize"]) ?? asNonNegativeInt(media["size"])) : null);
  const durationSeconds =
    asNonNegativeInt(payload["duration"]) ??
    asNonNegativeInt(payload["durationSeconds"]) ??
    (media !== null ? (asNonNegativeInt(media["duration"]) ?? asNonNegativeInt(media["durationSeconds"])) : null);
  const caption = asString(payload["caption"]);
  const hasMediaSignal =
    payload["hasMedia"] === true || payload["has_media"] === true || payload["isMedia"] === true;

  let contentType: NormalizedWahaMedia["contentType"] | null = null;
  if (type === "image") {
    contentType = "IMAGE";
  } else if (type === "audio" || type === "ptt" || type === "voice" || type === "audio_message") {
    contentType = "AUDIO";
  } else if (type === "document") {
    contentType = "DOCUMENT";
  } else if (type === "video") {
    contentType = "VIDEO";
  } else if (type === "" || type === "chat" || type === "text") {
    // Text-shaped payload: only treat as media when a media URL is present
    // with a media MIME hint (WAHA variants that omit `type`), or when the
    // payload explicitly signals media without any artifact (WAHA `hasMedia`
    // with no URL/MIME/`type` → unavailable, never TEXT).
    if (mediaUrl !== null && declaredMime !== null) {
      const mime = declaredMime.split(";")[0]?.trim().toLowerCase() ?? "";
      if (mime.startsWith("image/")) {
        contentType = "IMAGE";
      } else if (mime.startsWith("audio/")) {
        contentType = "AUDIO";
      } else if (mime.startsWith("video/")) {
        contentType = "VIDEO";
      } else {
        contentType = "DOCUMENT";
      }
    } else if (hasMediaSignal) {
      const mime = declaredMime?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (mime.startsWith("image/")) {
        contentType = "IMAGE";
      } else if (mime.startsWith("audio/")) {
        contentType = "AUDIO";
      } else if (mime.startsWith("video/")) {
        contentType = "VIDEO";
      } else {
        contentType = "DOCUMENT";
      }
    } else {
      return null;
    }
  } else {
    return null;
  }
  // An explicit media type without any downloadable/declared artifact is
  // still media (unavailable → handled downstream as `media_unavailable`,
  // never silently downgraded to TEXT).
  return { contentType, mediaUrl, declaredMime, fileName, sizeBytes, durationSeconds, caption };
}

/** Normalize a sender address for identity matching (`@c.us`/`@s.whatsapp.net` stripped, digits kept). */
export function normalizeSender(from: string): string {
  const at = from.indexOf("@");
  const bare = (at >= 0 ? from.slice(0, at) : from).trim();
  const digits = bare.replace(/[^+\d]/g, "");
  return digits.length > 0 ? digits : bare;
}

export type NormalizedWahaStatus =
  | { kind: "status"; session: string | null; status: string }
  | { kind: "not-status" };

export function normalizeWahaStatus(raw: unknown): NormalizedWahaStatus {
  const root = asRecord(raw);
  if (root === null) {
    return { kind: "not-status" };
  }
  const event = asString(root["event"]) ?? "";
  if (event !== "session.status" && event !== "session_status" && event !== "status") {
    return { kind: "not-status" };
  }
  const payload = asRecord(root["payload"]) ?? {};
  const status =
    asString(payload["status"]) ??
    asString(payload["state"]) ??
    asString(root["status"]) ??
    asString(root["state"]);
  if (status === null) {
    return { kind: "not-status" };
  }
  return { kind: "status", session: asString(root["session"]), status };
}

export type WahaStatusRisk = "HEALTHY" | "DEGRADED" | "CAPPED" | null;

export function riskForSessionStatus(status: string): WahaStatusRisk {
  const upper = status.trim().toUpperCase();
  if (/(TIMELOCK|CAPPED|BLOCKED|BANNED|RATE_LIMIT|FLOOD)/.test(upper)) {
    return "CAPPED";
  }
  if (/(FAILED|STOPPED|DISCONNECTED|ERROR|EXPIRED|LOGOUT)/.test(upper)) {
    return "DEGRADED";
  }
  if (/(WORKING|CONNECTED|STARTING|SCAN_QR_CODE|READY|OPEN)/.test(upper)) {
    return "HEALTHY";
  }
  return null;
}
