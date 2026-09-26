/**
 * UTC instant helpers. Internally everything is UTC (`timestamptz`-compatible
 * ISO-8601 strings / epoch millis); tenant timezone only affects display.
 */

/** Current instant as a `Date` (always UTC-based epoch). */
export function now(): Date {
  return new Date();
}

/** Current instant as ISO-8601 UTC string (`timestamptz`-compatible). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Parse an ISO-8601 instant; throws on invalid input. */
export function parseInstant(iso: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid instant: ${JSON.stringify(iso)}`);
  }
  return d;
}

/** Serialize a `Date` to ISO-8601 UTC string. */
export function toIso(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid Date");
  }
  return date.toISOString();
}

/** True when `a` is strictly before `b` (accepts Date or ISO string). */
export function isBefore(a: Date | string, b: Date | string): boolean {
  const da = typeof a === "string" ? parseInstant(a) : a;
  const db = typeof b === "string" ? parseInstant(b) : b;
  return da.getTime() < db.getTime();
}
