import { sql, type Transaction } from "kysely";
import { newId, now } from "@iptv/domain";
import type { Database } from "@iptv/database";
import type { CommandHandlerContext } from "../commands/command-bus.js";
import { kyselyTrxOf } from "../crm/wave2-store.js";

/**
 * Wave 8 Support store accessors (Kysely only).
 *
 * Like the Subscription/Renewal slices, these commands require a database
 * transaction — there is no in-memory path. Units run against the pure
 * `support-policy.ts` helpers; the full flow is covered by the
 * `TEST_DATABASE_URL` integration suite.
 *
 * Storage truth is migration 010 (+ the 021 `assignee_user_id` column):
 * every accessor below is tenant-scoped (`tenant_id = ctx.tenantId` on
 * every read and write — cross-tenant ids resolve to "not found", never
 * to another tenant's row).
 */

export function requireTrx(ctx: CommandHandlerContext): Transaction<Database> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("support commands require a database transaction");
  }
  return trx;
}

export async function advisoryLockTicket(trx: Transaction<Database>, ticketId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${"support-ticket:" + ticketId}))`.execute(trx);
}

export interface TicketRow {
  id: string;
  tenantId: string;
  personId: string;
  customerId: string | null;
  conversationId: string | null;
  status: string;
  priority: string;
  category: string | null;
  summary: string;
  assigneeUserId: string | null;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const TICKET_COLS = [
  "id",
  "person_id",
  "customer_id",
  "conversation_id",
  "status",
  "priority",
  "category",
  "summary",
  "assignee_user_id",
  "first_response_at",
  "resolved_at",
  "closed_at",
  "created_at",
  "updated_at",
] as const;

function toTicket(tenantId: string, row: {
  id: string;
  person_id: string;
  customer_id: string | null;
  conversation_id: string | null;
  status: string;
  priority: string;
  category: string | null;
  summary: string;
  assignee_user_id: string | null;
  first_response_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}): TicketRow {
  return {
    id: row.id,
    tenantId,
    personId: row.person_id,
    customerId: row.customer_id,
    conversationId: row.conversation_id,
    status: row.status,
    priority: row.priority,
    category: row.category,
    summary: row.summary,
    assigneeUserId: row.assignee_user_id,
    firstResponseAt: row.first_response_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getTicket(ctx: CommandHandlerContext, ticketId: string): Promise<TicketRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("support.support_tickets")
    .select(TICKET_COLS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", ticketId)
    .executeTakeFirst();
  return row === undefined ? null : toTicket(ctx.tenantId, row);
}

export async function insertTicket(
  ctx: CommandHandlerContext,
  input: {
    personId: string;
    conversationId?: string | null;
    priority: string;
    category?: string | null;
    summary: string;
  },
): Promise<TicketRow> {
  const trx = requireTrx(ctx);
  const at = now();
  const row = await trx
    .insertInto("support.support_tickets")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      person_id: input.personId,
      customer_id: null,
      conversation_id: input.conversationId ?? null,
      status: "NEW",
      priority: input.priority,
      category: input.category ?? null,
      summary: input.summary,
      assignee_user_id: null,
      first_response_at: null,
      resolved_at: null,
      closed_at: null,
      created_at: at,
      updated_at: at,
    })
    .returning(TICKET_COLS)
    .executeTakeFirstOrThrow();
  return toTicket(ctx.tenantId, row);
}

export async function updateTicket(
  ctx: CommandHandlerContext,
  ticketId: string,
  patch: {
    status?: string;
    assigneeUserId?: string | null;
    firstResponseAt?: Date | null;
    resolvedAt?: Date | null;
    closedAt?: Date | null;
  },
  expectedStatus?: string,
): Promise<TicketRow | null> {
  const trx = requireTrx(ctx);
  let query = trx
    .updateTable("support.support_tickets")
    .set({ ...patchToColumns(patch), updated_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", ticketId);
  if (expectedStatus !== undefined) {
    query = query.where("status", "=", expectedStatus);
  }
  const row = await query.returning(TICKET_COLS).executeTakeFirst();
  return row === undefined ? null : toTicket(ctx.tenantId, row);
}

function patchToColumns(patch: {
  status?: string;
  assigneeUserId?: string | null;
  firstResponseAt?: Date | null;
  resolvedAt?: Date | null;
  closedAt?: Date | null;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.status !== undefined) {
    out["status"] = patch.status;
  }
  if (patch.assigneeUserId !== undefined) {
    out["assignee_user_id"] = patch.assigneeUserId;
  }
  if (patch.firstResponseAt !== undefined) {
    out["first_response_at"] = patch.firstResponseAt;
  }
  if (patch.resolvedAt !== undefined) {
    out["resolved_at"] = patch.resolvedAt;
  }
  if (patch.closedAt !== undefined) {
    out["closed_at"] = patch.closedAt;
  }
  return out;
}

export interface AttemptRow {
  id: string;
  ticketId: string;
  solutionId: string | null;
  procedureKey: string | null;
  attemptNo: number;
  actorType: string;
  actorId: string | null;
  outcome: string | null;
  completedAt: Date | null;
}

export async function nextAttemptNo(ctx: CommandHandlerContext, ticketId: string): Promise<number> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("support.solution_attempts")
    .select((eb) => eb.fn.max("attempt_no").as("max_no"))
    .where("tenant_id", "=", ctx.tenantId)
    .where("support_ticket_id", "=", ticketId)
    .executeTakeFirst();
  const max = row?.max_no;
  return (typeof max === "number" ? max : Number(max ?? 0)) + 1;
}

export async function insertAttempt(
  ctx: CommandHandlerContext,
  input: {
    ticketId: string;
    solutionId?: string | null;
    procedureKey?: string | null;
    outcome?: string | null;
    contextJson?: Record<string, unknown>;
    evidenceJson?: Record<string, unknown>;
  },
): Promise<AttemptRow> {
  const trx = requireTrx(ctx);
  const attemptNo = await nextAttemptNo(ctx, input.ticketId);
  const completed = input.outcome !== undefined && input.outcome !== null;
  const row = await trx
    .insertInto("support.solution_attempts")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      support_ticket_id: input.ticketId,
      solution_id: input.solutionId ?? null,
      procedure_key: input.procedureKey ?? null,
      attempt_no: attemptNo,
      actor_type: ctx.actor.actorType,
      actor_id: ctx.actor.userId,
      outcome: input.outcome ?? null,
      context_json: input.contextJson ?? {},
      evidence_json: input.evidenceJson ?? {},
      started_at: now(),
      completed_at: completed ? now() : null,
    })
    .returning(["id", "solution_id", "procedure_key", "attempt_no", "actor_type", "actor_id", "outcome", "completed_at"])
    .executeTakeFirstOrThrow();
  return {
    id: row.id,
    ticketId: input.ticketId,
    solutionId: row.solution_id,
    procedureKey: row.procedure_key,
    attemptNo: Number(row.attempt_no),
    actorType: row.actor_type,
    actorId: row.actor_id,
    outcome: row.outcome,
    completedAt: row.completed_at,
  };
}

export async function hasUnlockingAttempt(ctx: CommandHandlerContext, ticketId: string): Promise<boolean> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("support.solution_attempts")
    .select("id")
    .where("tenant_id", "=", ctx.tenantId)
    .where("support_ticket_id", "=", ticketId)
    .where("outcome", "in", ["SUCCEEDED", "PARTIAL"])
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export async function listAttempts(
  ctx: CommandHandlerContext,
  ticketId: string,
): Promise<AttemptRow[]> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("support.solution_attempts")
    .select(["id", "solution_id", "procedure_key", "attempt_no", "actor_type", "actor_id", "outcome", "completed_at"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("support_ticket_id", "=", ticketId)
    .orderBy("attempt_no", "asc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    ticketId,
    solutionId: row.solution_id,
    procedureKey: row.procedure_key,
    attemptNo: Number(row.attempt_no),
    actorType: row.actor_type,
    actorId: row.actor_id,
    outcome: row.outcome,
    completedAt: row.completed_at,
  }));
}

export interface IncidentRow {
  id: string;
  status: string;
  severity: string;
  title: string;
  summary: string | null;
  detectedAt: Date;
  confirmedAt: Date | null;
  resolvedAt: Date | null;
}

const INCIDENT_COLS = [
  "id",
  "status",
  "severity",
  "title",
  "summary",
  "detected_at",
  "confirmed_at",
  "resolved_at",
] as const;

function toIncident(row: {
  id: string;
  status: string;
  severity: string;
  title: string;
  summary: string | null;
  detected_at: Date;
  confirmed_at: Date | null;
  resolved_at: Date | null;
}): IncidentRow {
  return {
    id: row.id,
    status: row.status,
    severity: row.severity,
    title: row.title,
    summary: row.summary,
    detectedAt: row.detected_at,
    confirmedAt: row.confirmed_at,
    resolvedAt: row.resolved_at,
  };
}

export async function getIncident(ctx: CommandHandlerContext, incidentId: string): Promise<IncidentRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("support.incidents")
    .select(INCIDENT_COLS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", incidentId)
    .executeTakeFirst();
  return row === undefined ? null : toIncident(row);
}

export async function insertIncident(
  ctx: CommandHandlerContext,
  input: { severity: string; title: string; summary?: string | null },
): Promise<IncidentRow> {
  const trx = requireTrx(ctx);
  const row = await trx
    .insertInto("support.incidents")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      status: "DETECTED",
      severity: input.severity,
      provider_account_id: null,
      server_key: null,
      service_key: null,
      title: input.title,
      summary: input.summary ?? null,
      detected_at: now(),
      confirmed_at: null,
      resolved_at: null,
      created_at: now(),
      updated_at: now(),
    })
    .returning(INCIDENT_COLS)
    .executeTakeFirstOrThrow();
  return toIncident(row);
}

export async function updateIncident(
  ctx: CommandHandlerContext,
  incidentId: string,
  patch: { status?: string; confirmedAt?: Date | null; resolvedAt?: Date | null },
  expectedStatus?: string,
): Promise<IncidentRow | null> {
  const trx = requireTrx(ctx);
  const set: Record<string, unknown> = { updated_at: now() };
  if (patch.status !== undefined) {
    set["status"] = patch.status;
  }
  if (patch.confirmedAt !== undefined) {
    set["confirmed_at"] = patch.confirmedAt;
  }
  if (patch.resolvedAt !== undefined) {
    set["resolved_at"] = patch.resolvedAt;
  }
  let query = trx
    .updateTable("support.incidents")
    .set(set)
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", incidentId);
  if (expectedStatus !== undefined) {
    query = query.where("status", "=", expectedStatus);
  }
  const row = await query.returning(INCIDENT_COLS).executeTakeFirst();
  return row === undefined ? null : toIncident(row);
}

export interface ProblemRow {
  id: string;
  status: string;
  title: string;
  rootCause: string | null;
  workaroundSummary: string | null;
  resolvedAt: Date | null;
}

export async function getProblem(ctx: CommandHandlerContext, problemId: string): Promise<ProblemRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("support.problems")
    .select(["id", "status", "title", "root_cause", "workaround_summary", "resolved_at"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", problemId)
    .executeTakeFirst();
  return row === undefined
    ? null
    : {
        id: row.id,
        status: row.status,
        title: row.title,
        rootCause: row.root_cause,
        workaroundSummary: row.workaround_summary,
        resolvedAt: row.resolved_at,
      };
}

export async function insertProblem(
  ctx: CommandHandlerContext,
  input: { title: string; rootCause?: string | null; workaroundSummary?: string | null },
): Promise<ProblemRow> {
  const trx = requireTrx(ctx);
  const row = await trx
    .insertInto("support.problems")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      status: "OPEN",
      title: input.title,
      root_cause: input.rootCause ?? null,
      workaround_summary: input.workaroundSummary ?? null,
      created_at: now(),
      updated_at: now(),
      resolved_at: null,
    })
    .returning(["id", "status", "title", "root_cause", "workaround_summary", "resolved_at"])
    .executeTakeFirstOrThrow();
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    rootCause: row.root_cause,
    workaroundSummary: row.workaround_summary,
    resolvedAt: row.resolved_at,
  };
}

export async function insertTicketIncidentLink(
  ctx: CommandHandlerContext,
  ticketId: string,
  incidentId: string,
): Promise<{ duplicate: boolean }> {
  const trx = requireTrx(ctx);
  // ON CONFLICT DO NOTHING (not try/catch): a failed statement would abort
  // the command transaction — Postgres has no statement-level recovery
  // without an explicit savepoint, and the bus audit must still land.
  const result = await trx
    .insertInto("support.ticket_incident_links")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      support_ticket_id: ticketId,
      incident_id: incidentId,
      linked_at: now(),
      linked_by_type: ctx.actor.actorType,
      linked_by_id: ctx.actor.userId,
    })
    .onConflict((oc) => oc.columns(["tenant_id", "support_ticket_id", "incident_id"]).doNothing())
    .executeTakeFirst();
  return { duplicate: Number(result.numInsertedOrUpdatedRows ?? 0) === 0 };
}

export async function insertTicketProblemLink(
  ctx: CommandHandlerContext,
  ticketId: string,
  problemId: string,
): Promise<{ duplicate: boolean }> {
  const trx = requireTrx(ctx);
  const result = await trx
    .insertInto("support.ticket_problem_links")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      support_ticket_id: ticketId,
      problem_id: problemId,
      linked_at: now(),
      linked_by_type: ctx.actor.actorType,
      linked_by_id: ctx.actor.userId,
    })
    .onConflict((oc) => oc.columns(["tenant_id", "support_ticket_id", "problem_id"]).doNothing())
    .executeTakeFirst();
  return { duplicate: Number(result.numInsertedOrUpdatedRows ?? 0) === 0 };
}

export async function membershipIsActive(ctx: CommandHandlerContext, userId: string): Promise<boolean> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("control.tenant_memberships")
    .select("id")
    .where("tenant_id", "=", ctx.tenantId)
    .where("user_id", "=", userId)
    .where("status", "=", "ACTIVE")
    .executeTakeFirst();
  return row !== undefined;
}

export async function personExists(ctx: CommandHandlerContext, personId: string): Promise<boolean> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("identity.persons")
    .select("id")
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", personId)
    .executeTakeFirst();
  return row !== undefined;
}

export async function conversationInTenant(
  ctx: CommandHandlerContext,
  conversationId: string,
): Promise<boolean> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("communication.conversations")
    .select("id")
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", conversationId)
    .executeTakeFirst();
  return row !== undefined;
}

export async function getSolution(ctx: CommandHandlerContext, solutionId: string): Promise<{ id: string } | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("knowledge.solutions")
    .select("id")
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", solutionId)
    .executeTakeFirst();
  return row === undefined ? null : { id: row.id };
}

export async function insertSolutionOutcome(
  ctx: CommandHandlerContext,
  input: { solutionId: string; ticketId: string; outcome: string; contextFingerprint: string },
): Promise<{ id: string }> {
  const trx = requireTrx(ctx);
  const row = await trx
    .insertInto("knowledge.solution_outcomes")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      solution_id: input.solutionId,
      support_ticket_id: input.ticketId,
      trial_id: null,
      context_fingerprint: input.contextFingerprint,
      outcome: input.outcome,
      evidence_json: { ticket_id: input.ticketId },
      observed_at: now(),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id };
}
