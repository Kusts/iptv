/**
 * Wave 8 Support + Incident/Problem policy helpers (pure, unit-tested).
 *
 * Canonical rules (docs/15-implementation-baseline/02 + 03, SPEC 07):
 * - Ticket lifecycle (owning context: Support & Reliability):
 *   `NEW | TRIAGING | IN_PROGRESS | WAITING_CUSTOMER | WAITING_INTERNAL |
 *   WAITING_PROVIDER | RESOLVED | CLOSED | CANCELLED` — the set mirrors the
 *   010 `support_tickets_status_check`; the map below defines the valid
 *   transitions (a state set never implies every pair is valid).
 * - SPEC flow: `NEW → TRIAGING → IN_PROGRESS → (attempt solution) →
 *   RESOLVED → confirmation window → CLOSED`, with WAITING_* detours for
 *   customer/provider/internal (HITL) waits. RESOLVED/CLOSED may resume to
 *   IN_PROGRESS (reopen); CANCELLED is terminal.
 * - Incident lifecycle: `DETECTED | CONFIRMED | MONITORING | RESOLVED |
 *   CANCELLED` (mirrors the 010 CHECK). Problem lifecycle:
 *   `OPEN | INVESTIGATING | KNOWN_ERROR | RESOLVED | CLOSED`.
 * - Resolve requires solution evidence: at least one solution attempt with
 *   a successful terminal outcome (`SUCCEEDED` or `PARTIAL`) — the 010
 *   `solution_attempts_outcome_check` enum is the vocabulary; the gate
 *   itself lives here because no CHECK can express "at least one row".
 * - Events are registry-listed ONLY (docs/02-domain/event-model.md); every
 *   entry transition below maps to its public v1, anything else is
 *   audit-only.
 */

export const TICKET_STATUSES = [
  "NEW",
  "TRIAGING",
  "IN_PROGRESS",
  "WAITING_CUSTOMER",
  "WAITING_INTERNAL",
  "WAITING_PROVIDER",
  "RESOLVED",
  "CLOSED",
  "CANCELLED",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

const TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  NEW: ["TRIAGING", "CANCELLED"],
  TRIAGING: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["WAITING_CUSTOMER", "WAITING_INTERNAL", "WAITING_PROVIDER", "RESOLVED", "CANCELLED"],
  WAITING_CUSTOMER: ["IN_PROGRESS", "RESOLVED", "CANCELLED"],
  WAITING_INTERNAL: ["IN_PROGRESS", "RESOLVED", "CANCELLED"],
  WAITING_PROVIDER: ["IN_PROGRESS", "RESOLVED", "CANCELLED"],
  RESOLVED: ["CLOSED", "IN_PROGRESS"],
  CLOSED: ["IN_PROGRESS"],
  CANCELLED: [],
};

export function isTicketTransition(from: string, to: string): boolean {
  const allowed = (TICKET_TRANSITIONS as Record<string, readonly string[]>)[from];
  return allowed !== undefined && allowed.includes(to);
}

export function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value);
}

/**
 * Registry-listed event for ENTERING a ticket status. `from` disambiguates
 * the IN_PROGRESS entry: fresh work (`work_started`) vs resumed work
 * (`work_resumed`) vs explicit reopen (`reopened`). Returns null only for
 * unknown statuses (callers validate first); every canonical status maps.
 */
export function ticketEntryEvent(to: TicketStatus, from: TicketStatus): string {
  switch (to) {
    case "TRIAGING":
      return "support.triage_started.v1";
    case "IN_PROGRESS":
      if (from === "RESOLVED" || from === "CLOSED") {
        return "support.reopened.v1";
      }
      if (from.startsWith("WAITING_")) {
        return "support.work_resumed.v1";
      }
      return "support.work_started.v1";
    case "WAITING_CUSTOMER":
      return "support.waiting_customer.v1";
    case "WAITING_INTERNAL":
      return "support.waiting_internal.v1";
    case "WAITING_PROVIDER":
      return "support.waiting_provider.v1";
    case "RESOLVED":
      return "support.resolved.v1";
    case "CLOSED":
      return "support.closed.v1";
    case "CANCELLED":
      return "support.cancelled.v1";
    case "NEW":
      return "support.ticket_created.v1";
  }
}

export const INCIDENT_STATUSES = ["DETECTED", "CONFIRMED", "MONITORING", "RESOLVED", "CANCELLED"] as const;

export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  DETECTED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["MONITORING", "RESOLVED", "CANCELLED"],
  MONITORING: ["CONFIRMED", "RESOLVED", "CANCELLED"],
  RESOLVED: [],
  CANCELLED: [],
};

export function isIncidentTransition(from: string, to: string): boolean {
  const allowed = (INCIDENT_TRANSITIONS as Record<string, readonly string[]>)[from];
  return allowed !== undefined && allowed.includes(to);
}

/** Registry-listed event for ENTERING an incident status. */
export function incidentEntryEvent(to: IncidentStatus): string {
  switch (to) {
    case "DETECTED":
      return "incident.detected.v1";
    case "CONFIRMED":
      return "incident.confirmed.v1";
    case "MONITORING":
    case "CANCELLED":
      return "incident.updated.v1";
    case "RESOLVED":
      return "incident.resolved.v1";
  }
}

export const PROBLEM_STATUSES = ["OPEN", "INVESTIGATING", "KNOWN_ERROR", "RESOLVED", "CLOSED"] as const;

/** Successful terminal attempt outcomes that unlock `ticket.resolve`. */
export const RESOLVE_UNLOCKING_OUTCOMES = ["SUCCEEDED", "PARTIAL"] as const;

export function unlocksResolve(outcome: string | null): boolean {
  return outcome !== null && (RESOLVE_UNLOCKING_OUTCOMES as readonly string[]).includes(outcome);
}

export const SOLUTION_ATTEMPT_OUTCOMES = [
  "SUCCEEDED",
  "FAILED",
  "PARTIAL",
  "INCONCLUSIVE",
  "NOT_APPLICABLE",
] as const;

/** `hitl.sla` policy family: warn/breach age thresholds for open HITL work. */
export const HITL_SLA_POLICY_FAMILY = "hitl.sla";

export interface HitlSlaPolicy {
  warnAfterHours: number;
  breachAfterHours: number;
}

export const DEFAULT_HITL_SLA_POLICY: HitlSlaPolicy = {
  warnAfterHours: 4,
  breachAfterHours: 24,
};

function asPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Parse a merged `hitl.sla` document; unknown shapes fall back safely. */
export function parseHitlSlaPolicy(doc: Record<string, unknown> | null): HitlSlaPolicy {
  if (doc === null) {
    return { ...DEFAULT_HITL_SLA_POLICY };
  }
  const warn = asPositiveNumber(doc["warn_after_hours"], DEFAULT_HITL_SLA_POLICY.warnAfterHours);
  const breach = asPositiveNumber(doc["breach_after_hours"], DEFAULT_HITL_SLA_POLICY.breachAfterHours);
  // A breach threshold below warn is incoherent — clamp to warn so the
  // ordering invariant (ok < warn <= breach) always holds.
  return { warnAfterHours: warn, breachAfterHours: Math.max(breach, warn) };
}

export type SlaBand = "OK" | "WARN" | "BREACH";

/** Boundary-exact SLA band: `>= warn` warns, `>= breach` breaches. */
export function classifySlaBand(
  policy: HitlSlaPolicy,
  input: { createdAt: Date; at: Date },
): SlaBand {
  const ageHours = (input.at.getTime() - input.createdAt.getTime()) / 3_600_000;
  if (ageHours >= policy.breachAfterHours) {
    return "BREACH";
  }
  if (ageHours >= policy.warnAfterHours) {
    return "WARN";
  }
  return "OK";
}
