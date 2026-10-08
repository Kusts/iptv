import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import { withTenantTransaction, type Database } from "@iptv/database";
import { commandResultHttpStatus } from "@iptv/domain";
import type { CommandActor, CommandResult } from "@iptv/domain";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import { CommandBus, commandActorFromRequestParts } from "../commands/command-bus.js";
import { TICKET_STATUSES } from "./support-policy.js";

function actorFromRequest(req: FastifyRequest): CommandActor {
  const auth = req.auth as NonNullable<FastifyRequest["auth"]>;
  const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
  return commandActorFromRequestParts({
    userId: auth.userId,
    isPlatformAdmin: auth.isPlatformAdmin,
    tenantId: tenant.id,
    roleKeys: tenant.roleKeys,
    permissions: tenant.permissions,
    actorType: "human",
  });
}

function send<T>(result: CommandResult<T>): T {
  if (result.ok) {
    return result.data;
  }
  throw new HttpException(
    { code: result.code.toUpperCase(), message: result.message },
    commandResultHttpStatus(result),
  );
}

function idempotencyKeyOf(req: FastifyRequest): string | undefined {
  const header = req.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

const OPEN_TICKET_STATUSES = [
  "NEW",
  "TRIAGING",
  "IN_PROGRESS",
  "WAITING_CUSTOMER",
  "WAITING_INTERNAL",
  "WAITING_PROVIDER",
];

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * Wave 8 Support surface: tickets + incidents + problems.
 *
 * Writes go through the `CommandBus` (permission-gated, validated,
 * audited, registry-listed events in the same transaction). Reads run inside
 * `withTenantTransaction` (actor tenant): the tables below are RLS-enrolled
 * (migration 057, fail-closed when `app.tenant_id` is unset), so pool-level
 * selects under `iptv_app` would return empty silently after cutover. The
 * explicit `tenant_id =` predicates stay as defense-in-depth alongside the
 * RLS policy. This covers the read-only diagnostics joins too (conversation
 * context, linked incidents/problems, attempts, observed solution outcomes
 * with trial refs) that never mutate another context.
 */
@Controller("v1")
export class SupportController {
  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject(CommandBus) private readonly bus: CommandBus,
  ) {}

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new HttpException({ code: "UNAVAILABLE", message: "database is not configured" }, 503);
    }
    return this.db;
  }

  private async run<T>(req: FastifyRequest, command: string, payload: unknown): Promise<T> {
    const result = await this.bus.execute<T>(actorFromRequest(req), command, payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("tickets")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.write")
  async openTicket(@Body() body: unknown, @Req() req: FastifyRequest) {
    return this.run(req, "support.ticket.open", body);
  }

  @Post("tickets/:id/assign")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.write")
  async assignTicket(@Param("id") id: string, @Body() body: Record<string, unknown>, @Req() req: FastifyRequest) {
    return this.run(req, "support.ticket.assign", { ...body, ticketId: id });
  }

  @Post("tickets/:id/transition")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.write")
  async transitionTicket(@Param("id") id: string, @Body() body: Record<string, unknown>, @Req() req: FastifyRequest) {
    return this.run(req, "support.ticket.transition", { ...body, ticketId: id });
  }

  @Post("tickets/:id/attempts")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.write")
  async addAttempt(@Param("id") id: string, @Body() body: Record<string, unknown>, @Req() req: FastifyRequest) {
    return this.run(req, "support.ticket.add_solution_attempt", { ...body, ticketId: id });
  }

  @Post("tickets/:id/resolve")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.write")
  async resolveTicket(@Param("id") id: string, @Body() body: Record<string, unknown>, @Req() req: FastifyRequest) {
    return this.run(req, "support.ticket.resolve", { ...body, ticketId: id });
  }

  @Post("tickets/:id/close")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.write")
  async closeTicket(@Param("id") id: string, @Req() req: FastifyRequest) {
    return this.run(req, "support.ticket.close", { ticketId: id });
  }

  @Post("tickets/:id/reopen")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.write")
  async reopenTicket(@Param("id") id: string, @Req() req: FastifyRequest) {
    return this.run(req, "support.ticket.reopen", { ticketId: id });
  }

  @Post("tickets/:id/link-incident")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.write")
  async linkIncident(@Param("id") id: string, @Body() body: Record<string, unknown>, @Req() req: FastifyRequest) {
    return this.run(req, "support.ticket.link_incident", { ...body, ticketId: id });
  }

  @Post("tickets/:id/link-problem")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.write")
  async linkProblem(@Param("id") id: string, @Body() body: Record<string, unknown>, @Req() req: FastifyRequest) {
    return this.run(req, "support.ticket.link_problem", { ...body, ticketId: id });
  }

  @Post("tickets/:id/technical-access")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.write")
  async grantTechnicalAccess(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ) {
    return this.run(req, "support.technical_access.grant", { ...body, ticketId: id });
  }

  @Get("technical-access/:id")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.read")
  async getTechnicalAccess(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    // P1.5-057 (P1.3 FIX1 mirror): tenant-scoped read inside the request
    // tenant's context — direct reads fail-closed under `iptv_app`.
    const row = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("support.technical_access_grants")
      .select([
        "id",
        "person_id",
        "support_ticket_id",
        "reason",
        "status",
        "granted_at",
        "expires_at",
        "revoked_at",
        "revoked_reason",
        "created_at",
      ])
      .where("tenant_id", "=", tenant.id)
      .where("id", "=", id)
      .executeTakeFirst(),
    );
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "technical access grant not found" }, 404);
    }
    return {
      id: row.id,
      personId: row.person_id,
      ticketId: row.support_ticket_id,
      reason: row.reason,
      status: row.status,
      grantedAt: row.granted_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      revokedAt: toIso(row.revoked_at),
      revokedReason: row.revoked_reason,
      createdAt: row.created_at.toISOString(),
    };
  }

  @Get("technical-access")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.read")
  async listTechnicalAccess(
    @Query() query: { personId?: string; ticketId?: string; limit?: string },
    @Req() req: FastifyRequest,
  ) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    // P1.5-057 (P1.3 FIX1 mirror): see getTechnicalAccess().
    const rows = await withTenantTransaction(this.requireDb(), tenant.id, (trx) => {
      let select = trx
        .selectFrom("support.technical_access_grants")
        .select(["id", "person_id", "support_ticket_id", "reason", "status", "granted_at", "expires_at"])
        .where("tenant_id", "=", tenant.id)
        .orderBy("created_at", "desc")
        .limit(limit);
      if (query.personId !== undefined) {
        select = select.where("person_id", "=", query.personId);
      }
      if (query.ticketId !== undefined) {
        select = select.where("support_ticket_id", "=", query.ticketId);
      }
      return select.execute();
    });
    return {
      grants: rows.map((r) => ({
        id: r.id,
        personId: r.person_id,
        ticketId: r.support_ticket_id,
        reason: r.reason,
        status: r.status,
        grantedAt: r.granted_at.toISOString(),
        expiresAt: r.expires_at.toISOString(),
      })),
    };
  }

  @Get("tickets/my-work")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.read")
  async myWork(@Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const auth = req.auth as NonNullable<FastifyRequest["auth"]>;
    // P1.5-057 (P1.3 FIX1 mirror): see getTechnicalAccess().
    const rows = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("support.support_tickets")
        .select(["id", "status", "priority", "summary", "person_id", "created_at", "updated_at"])
        .where("tenant_id", "=", tenant.id)
        .where("assignee_user_id", "=", auth.userId)
        .where("status", "in", OPEN_TICKET_STATUSES)
        .orderBy("created_at", "asc")
        .execute(),
    );
    return {
      tickets: rows.map((r) => ({
        id: r.id,
        status: r.status,
        priority: r.priority,
        summary: r.summary,
        personId: r.person_id,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
    };
  }

  @Get("tickets")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.read")
  async listTickets(
    @Query() query: { status?: string; assignee?: string; personId?: string; limit?: string },
    @Req() req: FastifyRequest,
  ) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    if (query.status !== undefined && !(TICKET_STATUSES as readonly string[]).includes(query.status)) {
      throw new HttpException({ code: "INVALID_STATUS", message: `unknown status: ${query.status}` }, 400);
    }
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    // P1.5-057 (P1.3 FIX1 mirror): see getTechnicalAccess().
    const rows = await withTenantTransaction(this.requireDb(), tenant.id, (trx) => {
      let select = trx
        .selectFrom("support.support_tickets")
        .select(["id", "status", "priority", "summary", "person_id", "assignee_user_id", "created_at", "resolved_at"])
        .where("tenant_id", "=", tenant.id)
        .orderBy("created_at", "desc")
        .limit(limit);
      if (query.status !== undefined) {
        select = select.where("status", "=", query.status);
      }
      if (query.assignee !== undefined) {
        select = select.where("assignee_user_id", "=", query.assignee);
      }
      if (query.personId !== undefined) {
        select = select.where("person_id", "=", query.personId);
      }
      return select.execute();
    });
    return {
      tickets: rows.map((r) => ({
        id: r.id,
        status: r.status,
        priority: r.priority,
        summary: r.summary,
        personId: r.person_id,
        assigneeUserId: r.assignee_user_id,
        createdAt: r.created_at.toISOString(),
        resolvedAt: toIso(r.resolved_at),
      })),
    };
  }

  @Get("tickets/:id")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.read")
  async getTicket(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    // P1.5-057 (P1.3 FIX1 mirror): one tenant transaction for the ticket +
    // all diagnostics reads (trial.controller.ts bundled pattern) — direct
    // reads fail-closed under `iptv_app`.
    const bundled = await withTenantTransaction(this.requireDb(), tenant.id, async (trx) => {
      const ticket = await trx
        .selectFrom("support.support_tickets")
      .select([
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
      ])
      .where("tenant_id", "=", tenant.id)
      .where("id", "=", id)
      .executeTakeFirst();
    if (ticket === undefined) {
      return null;
    }
    // Diagnostics context: read-only joins, never mutations.
    const incidents = await trx
      .selectFrom("support.ticket_incident_links")
      .innerJoin("support.incidents", (join) =>
        join
          .onRef("support.incidents.id", "=", "support.ticket_incident_links.incident_id")
          .on("support.incidents.tenant_id", "=", tenant.id),
      )
      .select(["support.incidents.id", "support.incidents.status", "support.incidents.severity", "support.incidents.title"])
      .where("support.ticket_incident_links.tenant_id", "=", tenant.id)
      .where("support.ticket_incident_links.support_ticket_id", "=", id)
      .execute();
    const problems = await trx
      .selectFrom("support.ticket_problem_links")
      .innerJoin("support.problems", (join) =>
        join
          .onRef("support.problems.id", "=", "support.ticket_problem_links.problem_id")
          .on("support.problems.tenant_id", "=", tenant.id),
      )
      .select(["support.problems.id", "support.problems.status", "support.problems.title"])
      .where("support.ticket_problem_links.tenant_id", "=", tenant.id)
      .where("support.ticket_problem_links.support_ticket_id", "=", id)
      .execute();
    const attempts = await trx
      .selectFrom("support.solution_attempts")
      .select(["id", "solution_id", "procedure_key", "attempt_no", "actor_type", "outcome", "completed_at"])
      .where("tenant_id", "=", tenant.id)
      .where("support_ticket_id", "=", id)
      .orderBy("attempt_no", "asc")
      .execute();
    const outcomes = await trx
      .selectFrom("knowledge.solution_outcomes")
      .select(["id", "solution_id", "trial_id", "outcome", "context_fingerprint", "observed_at"])
      .where("tenant_id", "=", tenant.id)
      .where("support_ticket_id", "=", id)
      .orderBy("observed_at", "desc")
      .execute();
    const conversation =
      ticket.conversation_id === null
        ? undefined
        : await trx
          .selectFrom("communication.conversations")
          .select(["id", "status", "channel", "control_mode"])
          .where("tenant_id", "=", tenant.id)
          .where("id", "=", ticket.conversation_id)
          .executeTakeFirst();
    return { ticket, incidents, problems, attempts, outcomes, conversation };
  });
  if (bundled === null) {
    throw new HttpException({ code: "NOT_FOUND", message: "ticket not found in this tenant" }, 404);
  }
  const { ticket, incidents, problems, attempts, outcomes, conversation } = bundled;
    return {
      ticket: {
        id: ticket.id,
        personId: ticket.person_id,
        customerId: ticket.customer_id,
        conversationId: ticket.conversation_id,
        status: ticket.status,
        priority: ticket.priority,
        category: ticket.category,
        summary: ticket.summary,
        assigneeUserId: ticket.assignee_user_id,
        firstResponseAt: toIso(ticket.first_response_at),
        resolvedAt: toIso(ticket.resolved_at),
        closedAt: toIso(ticket.closed_at),
        createdAt: ticket.created_at.toISOString(),
        updatedAt: ticket.updated_at.toISOString(),
      },
      incidents: incidents.map((r) => ({ id: r.id, status: r.status, severity: r.severity, title: r.title })),
      problems: problems.map((r) => ({ id: r.id, status: r.status, title: r.title })),
      attempts: attempts.map((r) => ({
        id: r.id,
        solutionId: r.solution_id,
        procedureKey: r.procedure_key,
        attemptNo: Number(r.attempt_no),
        actorType: r.actor_type,
        outcome: r.outcome,
        completedAt: toIso(r.completed_at),
      })),
      solutionOutcomes: outcomes.map((r) => ({
        id: r.id,
        solutionId: r.solution_id,
        trialId: r.trial_id,
        outcome: r.outcome,
        contextFingerprint: r.context_fingerprint,
        observedAt: r.observed_at.toISOString(),
      })),
      conversation:
        conversation === undefined
          ? null
          : { id: conversation.id, status: conversation.status, channel: conversation.channel, controlMode: conversation.control_mode },
    };
  }

  @Post("incidents")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.incident.write")
  async openIncident(@Body() body: unknown, @Req() req: FastifyRequest) {
    return this.run(req, "support.incident.open", body);
  }

  @Post("incidents/:id/status")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.incident.write")
  async incidentStatus(@Param("id") id: string, @Body() body: Record<string, unknown>, @Req() req: FastifyRequest) {
    return this.run(req, "support.incident.update_status", { ...body, incidentId: id });
  }

  @Post("incidents/:id/resolve")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.incident.write")
  async resolveIncident(@Param("id") id: string, @Req() req: FastifyRequest) {
    return this.run(req, "support.incident.resolve", { incidentId: id });
  }

  @Get("incidents")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.read")
  async listIncidents(@Query() query: { status?: string; limit?: string }, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    // P1.5-057 (P1.3 FIX1 mirror): see getTechnicalAccess().
    const rows = await withTenantTransaction(this.requireDb(), tenant.id, (trx) => {
      let select = trx
        .selectFrom("support.incidents")
        .select(["id", "status", "severity", "title", "detected_at", "resolved_at"])
        .where("tenant_id", "=", tenant.id)
        .orderBy("detected_at", "desc")
        .limit(limit);
      if (query.status !== undefined) {
        select = select.where("status", "=", query.status);
      }
      return select.execute();
    });
    return {
      incidents: rows.map((r) => ({
        id: r.id,
        status: r.status,
        severity: r.severity,
        title: r.title,
        detectedAt: r.detected_at.toISOString(),
        resolvedAt: toIso(r.resolved_at),
      })),
    };
  }

  @Post("problems")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.incident.write")
  async openProblem(@Body() body: unknown, @Req() req: FastifyRequest) {
    return this.run(req, "support.problem.open", body);
  }

  @Get("problems")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.read")
  async listProblems(@Query() query: { status?: string; limit?: string }, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    // P1.5-057 (P1.3 FIX1 mirror): see getTechnicalAccess().
    const rows = await withTenantTransaction(this.requireDb(), tenant.id, (trx) => {
      let select = trx
        .selectFrom("support.problems")
        .select(["id", "status", "title", "resolved_at"])
        .where("tenant_id", "=", tenant.id)
        .orderBy("created_at", "desc")
        .limit(limit);
      if (query.status !== undefined) {
        select = select.where("status", "=", query.status);
      }
      return select.execute();
    });
    return {
      problems: rows.map((r) => ({
        id: r.id,
        status: r.status,
        title: r.title,
        resolvedAt: toIso(r.resolved_at),
      })),
    };
  }
}
