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
    }
  | { kind: "unknown"; rawEvent: string };

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
  };
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
