/**
 * Wave 11 Growth policy helpers (pure, unit-testable).
 *
 * Canonical rules:
 * - No direct blast: every campaign outreach is a `message_intent` scheduled
 *   BEHIND the manual messaging gateway. Intents never send by themselves.
 * - Quiet hours (tenant timezone, default America/Sao_Paulo): contacts
 *   scheduled inside 21:00–08:00 are DEFERRED, never dropped. Inbound
 *   traffic is unaffected (intents only gate outbound scheduling).
 * - Suppression / DENIED preference beats scheduling: BLOCKED.
 * - Budget is enforced per campaign VERSION (minor units, exact strings):
 *   contacts that would push committed spend over the cap are BLOCKED with
 *   `BUDGET_EXCEEDED`; already-committed contacts keep their status.
 * - Attribution is first-touch wins per (person, campaign); REFERRAL_ASSIST
 *   touches are recorded separately and never overwrite the first touch.
 *   Conversions resolve the campaign version of the first touch, so history
 *   stays reproducible after later versions are published.
 */

/** Quiet window: 21:00 (inclusive) to 08:00 (exclusive), tenant-local time. */
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 8;

export const DEFAULT_TENANT_TIMEZONE = "America/Sao_Paulo";

/** Whole hour (0–23) of `at` in the given IANA timezone. */
export function hourInZone(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(at);
  const hour = parts.find((p) => p.type === "hour")?.value;
  const parsed = hour === undefined ? NaN : Number(hour) % 24;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) {
    throw new Error(`cannot resolve hour in timezone ${timeZone}`);
  }
  return parsed;
}

/** True when `at` falls inside the quiet window for `timeZone`. */
export function isQuietHour(at: Date, timeZone: string): boolean {
  const hour = hourInZone(at, timeZone);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/**
 * First schedulable instant at or after `at` in `timeZone`.
 *
 * DEFERRED contacts persist this release instant (per-contact
 * `scheduled_for`) instead of the requested time still inside the quiet
 * window, so a deferred row is never itself quiet-blocked. Steps forward
 * in 15-minute increments (bounded at 24h); returns `at` unchanged when
 * it is already outside the window.
 */
export function nextAllowedSlot(at: Date, timeZone: string): Date {
  if (!isQuietHour(at, timeZone)) {
    return new Date(at.getTime());
  }
  const stepMs = 15 * 60 * 1000;
  let candidate = at.getTime() + stepMs;
  const deadline = at.getTime() + 24 * 60 * 60 * 1000;
  while (candidate <= deadline) {
    const date = new Date(candidate);
    if (!isQuietHour(date, timeZone)) {
      return date;
    }
    candidate += stepMs;
  }
  return new Date(deadline);
}

export type ContactGate =
  | { verdict: "SCHEDULED" }
  | { verdict: "DEFERRED" }
  | { verdict: "BLOCKED"; reason: "SUPPRESSED" | "OPTED_OUT" | "BUDGET_EXCEEDED" };

/**
 * Pure per-contact scheduling gate. Suppression/opt-out short-circuit
 * before budget; quiet hours defer (never drop) otherwise-schedulable
 * contacts. `overBudget` is evaluated by the caller under a row lock on
 * the campaign version so concurrent schedulers serialize.
 */
export function gateContact(input: {
  suppressed: boolean;
  optedOut: boolean;
  overBudget: boolean;
  quiet: boolean;
}): ContactGate {
  if (input.suppressed) {
    return { verdict: "BLOCKED", reason: "SUPPRESSED" };
  }
  if (input.optedOut) {
    return { verdict: "BLOCKED", reason: "OPTED_OUT" };
  }
  if (input.overBudget) {
    return { verdict: "BLOCKED", reason: "BUDGET_EXCEEDED" };
  }
  if (input.quiet) {
    return { verdict: "DEFERRED" };
  }
  return { verdict: "SCHEDULED" };
}

/** Parse an exact minor-units money string (canonical decimal, no floats). */
export function parseMinor(value: string, field: string): bigint {
  if (!/^\d{1,19}$/.test(value)) {
    throw new Error(`${field} must be an exact non-negative minor-units string`);
  }
  return BigInt(value);
}
