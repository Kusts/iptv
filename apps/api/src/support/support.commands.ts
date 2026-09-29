import { z } from "zod";
import { now } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { emitAndEnqueue, kyselyTrxOf } from "../crm/wave2-store.js";
import {
  INCIDENT_STATUSES,
  SOLUTION_ATTEMPT_OUTCOMES,
  TECHNICAL_ACCESS_DEFAULT_DURATION_MINUTES,
  TECHNICAL_ACCESS_MAX_DURATION_MINUTES,
  TECHNICAL_ACCESS_MIN_DURATION_MINUTES,
  TICKET_STATUSES,
  incidentEntryEvent,
  isIncidentTransition,
  isTicketTransition,
  ticketEntryEvent,
} from "./support-policy.js";
import {
  advisoryLockTicket,
  conversationInTenant,
  getIncident,
  getProblem,
  getSolution,
  getTicket,
  hasUnlockingAttempt,
  insertAttempt,
  insertIncident,
  insertProblem,
  insertSolutionOutcome,
  insertTechnicalAccessGrant,
  insertTicket,
  insertTicketIncidentLink,
  insertTicketProblemLink,
  membershipIsActive,
  personExists,
  updateIncident,
  updateTicket,
} from "./support-store.js";

/**
 * Wave 8 Support commands (owning context for Ticket/Incident/Problem).
 *
 * Canonical rules enforced here:
 * - Only this context transitions tickets/incidents/problems (02); the
 *   transition maps in `support-policy.ts` mirror the 010 CHECK sets, and
 *   every entry transition emits its registry-listed public v1 (audit-only
 *   where the registry is silent — assignment, attempts, problem links).
 * - `ticket.resolve` requires solution evidence: at least one attempt with
 *   `SUCCEEDED`/`PARTIAL` (SPEC 07 §7: solved → RESOLVED). With an explicit
 *   `solutionId` the resolution also persists a `solution_outcomes` row +
 *   registry-listed `knowledge.solution_outcome_recorded.v1`.
 * - Tenant isolation: person/conversation/incident/problem/solution ids
 *   resolve inside the command tenant only — foreign ids are "not found".
 * - Assignee must hold an ACTIVE membership in the same tenant (021 FK).
 */

export const ticketOpenInput = z.object({
  personId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
  category: z.string().trim().min(1).max(120).optional(),
  summary: z.string().trim().min(1).max(2000),
});
export type TicketOpenInput = z.infer<typeof ticketOpenInput>;

export const ticketAssignInput = z.object({
  ticketId: z.string().uuid(),
  assigneeUserId: z.string().uuid(),
});
export type TicketAssignInput = z.infer<typeof ticketAssignInput>;

export const ticketTransitionInput = z.object({
  ticketId: z.string().uuid(),
  toStatus: z.enum(TICKET_STATUSES),
  expectedStatus: z.enum(TICKET_STATUSES).optional(),
});
export type TicketTransitionInput = z.infer<typeof ticketTransitionInput>;

export const attemptInput = z.object({
  ticketId: z.string().uuid(),
  solutionId: z.string().uuid().optional(),
  procedureKey: z.string().trim().min(1).max(200).optional(),
  outcome: z.enum(SOLUTION_ATTEMPT_OUTCOMES).optional(),
  contextJson: z.record(z.string(), z.unknown()).default({}),
  evidenceJson: z.record(z.string(), z.unknown()).default({}),
});
export type AttemptInput = z.infer<typeof attemptInput>;

export const ticketResolveInput = z.object({
  ticketId: z.string().uuid(),
  expectedStatus: z.enum(TICKET_STATUSES).optional(),
  solutionId: z.string().uuid().optional(),
  outcome: z.enum(SOLUTION_ATTEMPT_OUTCOMES).optional(),
  contextFingerprint: z.string().trim().min(1).max(200).optional(),
});
export type TicketResolveInput = z.infer<typeof ticketResolveInput>;

export const ticketIdInput = z.object({ ticketId: z.string().uuid() });
export type TicketIdInput = z.infer<typeof ticketIdInput>;

export const incidentOpenInput = z.object({
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  title: z.string().trim().min(1).max(500),
  summary: z.string().trim().max(4000).optional(),
});
export type IncidentOpenInput = z.infer<typeof incidentOpenInput>;

export const incidentStatusInput = z.object({
  incidentId: z.string().uuid(),
  toStatus: z.enum(INCIDENT_STATUSES),
  expectedStatus: z.enum(INCIDENT_STATUSES).optional(),
});
export type IncidentStatusInput = z.infer<typeof incidentStatusInput>;

export const incidentIdInput = z.object({ incidentId: z.string().uuid() });
export type IncidentIdInput = z.infer<typeof incidentIdInput>;

export const ticketLinkIncidentInput = z.object({
  ticketId: z.string().uuid(),
  incidentId: z.string().uuid(),
});
export type TicketLinkIncidentInput = z.infer<typeof ticketLinkIncidentInput>;

export const problemOpenInput = z.object({
  title: z.string().trim().min(1).max(500),
  rootCause: z.string().trim().max(4000).optional(),
  workaroundSummary: z.string().trim().max(4000).optional(),
});
export type ProblemOpenInput = z.infer<typeof problemOpenInput>;

export const ticketLinkProblemInput = z.object({
  ticketId: z.string().uuid(),
  problemId: z.string().uuid(),
});
export type TicketLinkProblemInput = z.infer<typeof ticketLinkProblemInput>;

export const technicalAccessGrantInput = z.object({
  personId: z.string().uuid(),
  ticketId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
  durationMinutes: z
    .number()
    .int()
    .min(TECHNICAL_ACCESS_MIN_DURATION_MINUTES)
    .max(TECHNICAL_ACCESS_MAX_DURATION_MINUTES)
    .default(TECHNICAL_ACCESS_DEFAULT_DURATION_MINUTES),
});
export type TechnicalAccessGrantInput = z.infer<typeof technicalAccessGrantInput>;

async function handleTicketOpen(
  ctx: CommandHandlerContext,
  input: TicketOpenInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  if (!(await personExists(ctx, input.personId))) {
    return { ok: false, code: "not_found", message: "person not found in this tenant" };
  }
  if (input.conversationId !== undefined && !(await conversationInTenant(ctx, input.conversationId))) {
    return { ok: false, code: "not_found", message: "conversation not found in this tenant" };
  }
  const ticket = await insertTicket(ctx, {
    personId: input.personId,
    conversationId: input.conversationId,
    priority: input.priority,
    category: input.category,
    summary: input.summary,
  });
  await emitAndEnqueue(ctx, {
    eventType: "support.ticket_created.v1",
    aggregateType: "support_ticket",
    aggregateId: ticket.id,
    data: { ticket_id: ticket.id, person_id: ticket.personId, priority: ticket.priority },
  });
  return { ok: true, data: { id: ticket.id, status: ticket.status } };
}

async function handleTicketAssignInner(
  ctx: CommandHandlerContext,
  input: TicketAssignInput,
): Promise<CommandResult<{ id: string; assigneeUserId: string }>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    return { ok: false, code: "precondition_failed", message: "support commands require a database transaction" };
  }
  await advisoryLockTicket(trx, input.ticketId);
  const ticket = await getTicket(ctx, input.ticketId);
  if (ticket === null) {
    return { ok: false, code: "not_found", message: "ticket not found in this tenant" };
  }
  if (ticket.status === "CLOSED" || ticket.status === "CANCELLED") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `ticket is ${ticket.status}; closed tickets cannot be reassigned`,
    };
  }
  if (!(await membershipIsActive(ctx, input.assigneeUserId))) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "assignee has no active membership in this tenant",
    };
  }
  const patch: { assigneeUserId: string; firstResponseAt?: Date } =
    ticket.firstResponseAt === null
      ? { assigneeUserId: input.assigneeUserId, firstResponseAt: now() }
      : { assigneeUserId: input.assigneeUserId };
  const updated = await updateTicket(ctx, ticket.id, patch, ticket.status);
  if (updated === null) {
    return { ok: false, code: "precondition_failed", message: "ticket changed concurrently" };
  }
  // Audit-only by design: assignment has no registry-listed public v1.
  return { ok: true, data: { id: updated.id, assigneeUserId: input.assigneeUserId } };
}

async function handleTicketTransition(
  ctx: CommandHandlerContext,
  input: TicketTransitionInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    return { ok: false, code: "precondition_failed", message: "support commands require a database transaction" };
  }
  await advisoryLockTicket(trx, input.ticketId);
  const ticket = await getTicket(ctx, input.ticketId);
  if (ticket === null) {
    return { ok: false, code: "not_found", message: "ticket not found in this tenant" };
  }
  if (input.expectedStatus !== undefined && ticket.status !== input.expectedStatus) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `stale transition rejected: expected ${input.expectedStatus}, current ${ticket.status}`,
    };
  }
  if (!isTicketTransition(ticket.status, input.toStatus)) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `invalid ticket transition: ${ticket.status} → ${input.toStatus}`,
    };
  }
  if (input.toStatus === "RESOLVED") {
    return {
      ok: false,
      code: "precondition_failed",
      message: "use support.ticket.resolve so solution evidence is enforced",
    };
  }
  const from = ticket.status as (typeof TICKET_STATUSES)[number];
  const to = input.toStatus as (typeof TICKET_STATUSES)[number];
  const updated = await updateTicket(ctx, ticket.id, { status: to }, ticket.status);
  if (updated === null) {
    return { ok: false, code: "precondition_failed", message: "ticket changed concurrently" };
  }
  await emitAndEnqueue(ctx, {
    eventType: ticketEntryEvent(to, from),
    aggregateType: "support_ticket",
    aggregateId: ticket.id,
    data: { ticket_id: ticket.id, from_status: from, to_status: to },
  });
  return { ok: true, data: { id: updated.id, status: updated.status } };
}

async function handleAddAttempt(
  ctx: CommandHandlerContext,
  input: AttemptInput,
): Promise<CommandResult<{ id: string; attemptNo: number; outcome: string | null }>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    return { ok: false, code: "precondition_failed", message: "support commands require a database transaction" };
  }
  if (input.solutionId === undefined && input.procedureKey === undefined) {
    return {
      ok: false,
      code: "validation_failed",
      message: "attempt requires solutionId or procedureKey (010 shape CHECK)",
    };
  }
  if (input.solutionId !== undefined && (await getSolution(ctx, input.solutionId)) === null) {
    return { ok: false, code: "not_found", message: "solution not found in this tenant" };
  }
  await advisoryLockTicket(trx, input.ticketId);
  const ticket = await getTicket(ctx, input.ticketId);
  if (ticket === null) {
    return { ok: false, code: "not_found", message: "ticket not found in this tenant" };
  }
  if (!["TRIAGING", "IN_PROGRESS", "WAITING_CUSTOMER", "WAITING_INTERNAL", "WAITING_PROVIDER"].includes(ticket.status)) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `ticket is ${ticket.status}; attempts belong to active work, not ${ticket.status}`,
    };
  }
  const attempt = await insertAttempt(ctx, {
    ticketId: ticket.id,
    solutionId: input.solutionId,
    procedureKey: input.procedureKey,
    outcome: input.outcome,
    contextJson: input.contextJson,
    evidenceJson: input.evidenceJson,
  });
  // Audit-only by design: `support.solution_attempt.recorded` is a semantic
  // family with no public v1 (known gap, like `commerce.order.awaiting_payment`).
  return { ok: true, data: { id: attempt.id, attemptNo: attempt.attemptNo, outcome: attempt.outcome } };
}

async function handleTicketResolve(
  ctx: CommandHandlerContext,
  input: TicketResolveInput,
): Promise<CommandResult<{ id: string; status: string; outcomeId: string | null }>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    return { ok: false, code: "precondition_failed", message: "support commands require a database transaction" };
  }
  await advisoryLockTicket(trx, input.ticketId);
  const ticket = await getTicket(ctx, input.ticketId);
  if (ticket === null) {
    return { ok: false, code: "not_found", message: "ticket not found in this tenant" };
  }
  if (input.expectedStatus !== undefined && ticket.status !== input.expectedStatus) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `stale resolve rejected: expected ${input.expectedStatus}, current ${ticket.status}`,
    };
  }
  if (!isTicketTransition(ticket.status, "RESOLVED")) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `ticket is ${ticket.status}; only active work resolves (never NEW or terminal)`,
    };
  }
  if (!(await hasUnlockingAttempt(ctx, ticket.id))) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "resolve requires a solution attempt with SUCCEEDED or PARTIAL outcome",
    };
  }
  let outcomeId: string | null = null;
  if (input.solutionId !== undefined) {
    if ((await getSolution(ctx, input.solutionId)) === null) {
      return { ok: false, code: "not_found", message: "solution not found in this tenant" };
    }
    const recorded = await insertSolutionOutcome(ctx, {
      solutionId: input.solutionId,
      ticketId: ticket.id,
      outcome: input.outcome ?? "SUCCEEDED",
      contextFingerprint: input.contextFingerprint ?? `ticket:${ticket.id}`,
    });
    outcomeId = recorded.id;
    await emitAndEnqueue(ctx, {
      eventType: "knowledge.solution_outcome_recorded.v1",
      aggregateType: "solution",
      aggregateId: input.solutionId,
      data: {
        solution_id: input.solutionId,
        ticket_id: ticket.id,
        outcome: input.outcome ?? "SUCCEEDED",
      },
    });
  }
  const from = ticket.status as (typeof TICKET_STATUSES)[number];
  const updated = await updateTicket(ctx, ticket.id, { status: "RESOLVED", resolvedAt: now() }, ticket.status);
  if (updated === null) {
    return { ok: false, code: "precondition_failed", message: "ticket changed concurrently" };
  }
  await emitAndEnqueue(ctx, {
    eventType: ticketEntryEvent("RESOLVED", from),
    aggregateType: "support_ticket",
    aggregateId: ticket.id,
    data: { ticket_id: ticket.id, from_status: from, to_status: "RESOLVED", outcome_id: outcomeId },
  });
  return { ok: true, data: { id: updated.id, status: updated.status, outcomeId } };
}

async function handleTicketClose(
  ctx: CommandHandlerContext,
  input: TicketIdInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    return { ok: false, code: "precondition_failed", message: "support commands require a database transaction" };
  }
  await advisoryLockTicket(trx, input.ticketId);
  const ticket = await getTicket(ctx, input.ticketId);
  if (ticket === null) {
    return { ok: false, code: "not_found", message: "ticket not found in this tenant" };
  }
  if (!isTicketTransition(ticket.status, "CLOSED")) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `ticket is ${ticket.status}; only RESOLVED tickets close`,
    };
  }
  const updated = await updateTicket(ctx, ticket.id, { status: "CLOSED", closedAt: now() }, ticket.status);
  if (updated === null) {
    return { ok: false, code: "precondition_failed", message: "ticket changed concurrently" };
  }
  await emitAndEnqueue(ctx, {
    eventType: "support.closed.v1",
    aggregateType: "support_ticket",
    aggregateId: ticket.id,
    data: { ticket_id: ticket.id, from_status: ticket.status, to_status: "CLOSED" },
  });
  return { ok: true, data: { id: updated.id, status: updated.status } };
}

async function handleTicketReopen(
  ctx: CommandHandlerContext,
  input: TicketIdInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    return { ok: false, code: "precondition_failed", message: "support commands require a database transaction" };
  }
  await advisoryLockTicket(trx, input.ticketId);
  const ticket = await getTicket(ctx, input.ticketId);
  if (ticket === null) {
    return { ok: false, code: "not_found", message: "ticket not found in this tenant" };
  }
  if (ticket.status !== "RESOLVED" && ticket.status !== "CLOSED") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `ticket is ${ticket.status}; only RESOLVED or CLOSED tickets reopen`,
    };
  }
  const from = ticket.status;
  const updated = await updateTicket(
    ctx,
    ticket.id,
    { status: "IN_PROGRESS", resolvedAt: null, closedAt: null },
    ticket.status,
  );
  if (updated === null) {
    return { ok: false, code: "precondition_failed", message: "ticket changed concurrently" };
  }
  await emitAndEnqueue(ctx, {
    eventType: "support.reopened.v1",
    aggregateType: "support_ticket",
    aggregateId: ticket.id,
    data: { ticket_id: ticket.id, from_status: from, to_status: "IN_PROGRESS" },
  });
  return { ok: true, data: { id: updated.id, status: updated.status } };
}

async function handleIncidentOpen(
  ctx: CommandHandlerContext,
  input: IncidentOpenInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const incident = await insertIncident(ctx, {
    severity: input.severity,
    title: input.title,
    summary: input.summary,
  });
  await emitAndEnqueue(ctx, {
    eventType: "incident.detected.v1",
    aggregateType: "incident",
    aggregateId: incident.id,
    data: { incident_id: incident.id, severity: incident.severity },
  });
  return { ok: true, data: { id: incident.id, status: incident.status } };
}

async function handleIncidentStatus(
  ctx: CommandHandlerContext,
  input: IncidentStatusInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const incident = await getIncident(ctx, input.incidentId);
  if (incident === null) {
    return { ok: false, code: "not_found", message: "incident not found in this tenant" };
  }
  if (input.expectedStatus !== undefined && incident.status !== input.expectedStatus) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `stale transition rejected: expected ${input.expectedStatus}, current ${incident.status}`,
    };
  }
  if (input.toStatus === "RESOLVED" || input.toStatus === "DETECTED") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `use support.incident.${input.toStatus === "RESOLVED" ? "resolve" : "open"} for ${input.toStatus}`,
    };
  }
  if (!isIncidentTransition(incident.status, input.toStatus)) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `invalid incident transition: ${incident.status} → ${input.toStatus}`,
    };
  }
  const to = input.toStatus as (typeof INCIDENT_STATUSES)[number];
  const updated = await updateIncident(
    ctx,
    incident.id,
    { status: to, confirmedAt: to === "CONFIRMED" ? now() : undefined },
    incident.status,
  );
  if (updated === null) {
    return { ok: false, code: "precondition_failed", message: "incident changed concurrently" };
  }
  await emitAndEnqueue(ctx, {
    eventType: incidentEntryEvent(to),
    aggregateType: "incident",
    aggregateId: incident.id,
    data: { incident_id: incident.id, from_status: incident.status, to_status: to },
  });
  return { ok: true, data: { id: updated.id, status: updated.status } };
}

async function handleIncidentResolve(
  ctx: CommandHandlerContext,
  input: IncidentIdInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const incident = await getIncident(ctx, input.incidentId);
  if (incident === null) {
    return { ok: false, code: "not_found", message: "incident not found in this tenant" };
  }
  if (!isIncidentTransition(incident.status, "RESOLVED")) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `incident is ${incident.status}; only CONFIRMED or MONITORING incidents resolve`,
    };
  }
  const updated = await updateIncident(
    ctx,
    incident.id,
    { status: "RESOLVED", resolvedAt: now() },
    incident.status,
  );
  if (updated === null) {
    return { ok: false, code: "precondition_failed", message: "incident changed concurrently" };
  }
  await emitAndEnqueue(ctx, {
    eventType: "incident.resolved.v1",
    aggregateType: "incident",
    aggregateId: incident.id,
    data: { incident_id: incident.id, from_status: incident.status, to_status: "RESOLVED" },
  });
  return { ok: true, data: { id: updated.id, status: updated.status } };
}

async function handleLinkIncident(
  ctx: CommandHandlerContext,
  input: TicketLinkIncidentInput,
): Promise<CommandResult<{ ticketId: string; incidentId: string; already: boolean }>> {
  const ticket = await getTicket(ctx, input.ticketId);
  if (ticket === null) {
    return { ok: false, code: "not_found", message: "ticket not found in this tenant" };
  }
  if ((await getIncident(ctx, input.incidentId)) === null) {
    return { ok: false, code: "not_found", message: "incident not found in this tenant" };
  }
  const { duplicate } = await insertTicketIncidentLink(ctx, ticket.id, input.incidentId);
  if (!duplicate) {
    await emitAndEnqueue(ctx, {
      eventType: "support.ticket_linked_to_incident.v1",
      aggregateType: "support_ticket",
      aggregateId: ticket.id,
      data: { ticket_id: ticket.id, incident_id: input.incidentId },
    });
  }
  return { ok: true, data: { ticketId: ticket.id, incidentId: input.incidentId, already: duplicate } };
}

async function handleProblemOpen(
  ctx: CommandHandlerContext,
  input: ProblemOpenInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const problem = await insertProblem(ctx, {
    title: input.title,
    rootCause: input.rootCause,
    workaroundSummary: input.workaroundSummary,
  });
  await emitAndEnqueue(ctx, {
    eventType: "problem.created.v1",
    aggregateType: "problem",
    aggregateId: problem.id,
    data: { problem_id: problem.id },
  });
  return { ok: true, data: { id: problem.id, status: problem.status } };
}

async function handleLinkProblem(
  ctx: CommandHandlerContext,
  input: TicketLinkProblemInput,
): Promise<CommandResult<{ ticketId: string; problemId: string; already: boolean }>> {
  const ticket = await getTicket(ctx, input.ticketId);
  if (ticket === null) {
    return { ok: false, code: "not_found", message: "ticket not found in this tenant" };
  }
  if ((await getProblem(ctx, input.problemId)) === null) {
    return { ok: false, code: "not_found", message: "problem not found in this tenant" };
  }
  const { duplicate } = await insertTicketProblemLink(ctx, ticket.id, input.problemId);
  // Audit-only by design: ticket↔problem linkage has no registry-listed v1.
  return { ok: true, data: { ticketId: ticket.id, problemId: input.problemId, already: duplicate } };
}

async function handleTechnicalAccessGrant(
  ctx: CommandHandlerContext,
  input: TechnicalAccessGrantInput,
): Promise<
  CommandResult<{ id: string; status: string; personId: string; ticketId: string; expiresAt: string }>
> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    return { ok: false, code: "precondition_failed", message: "support commands require a database transaction" };
  }
  if (!(await personExists(ctx, input.personId))) {
    return { ok: false, code: "not_found", message: "person not found in this tenant" };
  }
  const ticket = await getTicket(ctx, input.ticketId);
  if (ticket === null) {
    return { ok: false, code: "not_found", message: "ticket not found in this tenant" };
  }
  if (ticket.personId !== input.personId) {
    return { ok: false, code: "precondition_failed", message: "ticket does not belong to this person" };
  }
  const grantedAt = now();
  const expiresAt = new Date(grantedAt.getTime() + input.durationMinutes * 60_000);
  const grant = await insertTechnicalAccessGrant(ctx, {
    personId: input.personId,
    ticketId: ticket.id,
    reason: input.reason,
    expiresAt,
  });
  return {
    ok: true,
    data: {
      id: grant.id,
      status: grant.status,
      personId: grant.personId,
      ticketId: grant.ticketId,
      expiresAt: grant.expiresAt.toISOString(),
    },
  };
}

export function registerSupportCommands(bus: CommandBus): void {
  bus.register<TicketOpenInput, { id: string; status: string }>({
    name: "support.ticket.open",
    permission: "support.ticket.write",
    auditAction: "support.ticket.open",
    auditResource: "support_ticket",
    input: ticketOpenInput,
    handler: handleTicketOpen,
  });
  bus.register<TicketAssignInput, { id: string; assigneeUserId: string }>({
    name: "support.ticket.assign",
    permission: "support.ticket.write",
    auditAction: "support.ticket.assign",
    auditResource: "support_ticket",
    input: ticketAssignInput,
    handler: (ctx, input) => handleTicketAssignInner(ctx, input),
  });
  bus.register<TicketTransitionInput, { id: string; status: string }>({
    name: "support.ticket.transition",
    permission: "support.ticket.write",
    auditAction: "support.ticket.transition",
    auditResource: "support_ticket",
    input: ticketTransitionInput,
    handler: handleTicketTransition,
  });
  bus.register<AttemptInput, { id: string; attemptNo: number; outcome: string | null }>({
    name: "support.ticket.add_solution_attempt",
    permission: "support.ticket.write",
    auditAction: "support.ticket.add_solution_attempt",
    auditResource: "support_ticket",
    input: attemptInput,
    handler: handleAddAttempt,
  });
  bus.register<TicketResolveInput, { id: string; status: string; outcomeId: string | null }>({
    name: "support.ticket.resolve",
    permission: "support.ticket.write",
    auditAction: "support.ticket.resolve",
    auditResource: "support_ticket",
    input: ticketResolveInput,
    handler: handleTicketResolve,
  });
  bus.register<TicketIdInput, { id: string; status: string }>({
    name: "support.ticket.close",
    permission: "support.ticket.write",
    auditAction: "support.ticket.close",
    auditResource: "support_ticket",
    input: ticketIdInput,
    handler: handleTicketClose,
  });
  bus.register<TicketIdInput, { id: string; status: string }>({
    name: "support.ticket.reopen",
    permission: "support.ticket.write",
    auditAction: "support.ticket.reopen",
    auditResource: "support_ticket",
    input: ticketIdInput,
    handler: handleTicketReopen,
  });
  bus.register<IncidentOpenInput, { id: string; status: string }>({
    name: "support.incident.open",
    permission: "support.incident.write",
    auditAction: "support.incident.open",
    auditResource: "incident",
    input: incidentOpenInput,
    handler: handleIncidentOpen,
  });
  bus.register<IncidentStatusInput, { id: string; status: string }>({
    name: "support.incident.update_status",
    permission: "support.incident.write",
    auditAction: "support.incident.update_status",
    auditResource: "incident",
    input: incidentStatusInput,
    handler: handleIncidentStatus,
  });
  bus.register<IncidentIdInput, { id: string; status: string }>({
    name: "support.incident.resolve",
    permission: "support.incident.write",
    auditAction: "support.incident.resolve",
    auditResource: "incident",
    input: incidentIdInput,
    handler: handleIncidentResolve,
  });
  bus.register<TicketLinkIncidentInput, { ticketId: string; incidentId: string; already: boolean }>({
    name: "support.ticket.link_incident",
    permission: "support.ticket.write",
    auditAction: "support.ticket.link_incident",
    auditResource: "support_ticket",
    input: ticketLinkIncidentInput,
    handler: handleLinkIncident,
  });
  bus.register<ProblemOpenInput, { id: string; status: string }>({
    name: "support.problem.open",
    permission: "support.incident.write",
    auditAction: "support.problem.open",
    auditResource: "problem",
    input: problemOpenInput,
    handler: handleProblemOpen,
  });
  bus.register<TicketLinkProblemInput, { ticketId: string; problemId: string; already: boolean }>({
    name: "support.ticket.link_problem",
    permission: "support.ticket.write",
    auditAction: "support.ticket.link_problem",
    auditResource: "support_ticket",
    input: ticketLinkProblemInput,
    handler: handleLinkProblem,
  });
  bus.register<
    TechnicalAccessGrantInput,
    { id: string; status: string; personId: string; ticketId: string; expiresAt: string }
  >({
    name: "support.technical_access.grant",
    permission: "support.ticket.write",
    auditAction: "support.technical_access.grant",
    auditResource: "technical_access_grant",
    input: technicalAccessGrantInput,
    handler: handleTechnicalAccessGrant,
  });
}

