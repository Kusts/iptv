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
import type { Database } from "@iptv/database";
import { commandResultHttpStatus } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import { CommandBus, commandActorFromRequestParts } from "../commands/command-bus.js";
import type { CommandActor } from "@iptv/domain";

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

function pagination(query: { limit?: string; offset?: string }): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 100);
  const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
  return { limit, offset };
}

function idempotencyKeyOf(req: FastifyRequest): string | undefined {
  const header = req.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

/**
 * Wave 2 CRM surface. Writes go through the `CommandBus` (permission-gated,
 * validated, audited, event + outbox in-tx). Reads are plain tenant-scoped
 * selects — no command needed for reads.
 */
@Controller("v1/crm")
export class CrmController {
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

  @Post("persons")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async registerPerson(@Body() body: unknown, @Req() req: FastifyRequest): Promise<{ id: string }> {
    const result = await this.bus.execute<{ id: string }>(actorFromRequest(req), "person.register", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Get("persons")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async listPersons(@Req() req: FastifyRequest, @Query() query: { limit?: string; offset?: string }) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const { limit, offset } = pagination(query);
    const rows = await this.requireDb()
      .selectFrom("identity.persons")
      .select(["id", "status", "canonical_name", "locale", "timezone", "created_at"])
      .where("tenant_id", "=", tenant.id)
      .orderBy("created_at", "desc")
      .limit(limit)
      .offset(offset)
      .execute();
    return {
      persons: rows.map((r) => ({
        id: r.id,
        status: r.status,
        canonicalName: r.canonical_name,
        locale: r.locale,
        timezone: r.timezone,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  @Get("persons/:id")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async getPerson(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const db = this.requireDb();
    const row = await db
      .selectFrom("identity.persons")
      .select(["id", "status", "canonical_name", "locale", "timezone", "created_at"])
      .where("tenant_id", "=", tenant.id)
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "person not found" }, 404);
    }
    const identities = await db
      .selectFrom("identity.identities")
      .select(["id", "identity_type", "normalized_value", "verification_status"])
      .where("tenant_id", "=", tenant.id)
      .where("person_id", "=", id)
      .where("detached_at", "is", null)
      .execute();
    return {
      id: row.id,
      status: row.status,
      canonicalName: row.canonical_name,
      locale: row.locale,
      timezone: row.timezone,
      createdAt: row.created_at.toISOString(),
      identities: identities.map((i) => ({
        id: i.id,
        identityType: i.identity_type,
        normalizedValue: i.normalized_value,
        verificationStatus: i.verification_status,
      })),
    };
  }

  @Post("leads")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async captureLead(@Body() body: unknown, @Req() req: FastifyRequest): Promise<{ id: string }> {
    const result = await this.bus.execute<{ id: string }>(actorFromRequest(req), "lead.capture", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Get("leads")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async listLeads(@Req() req: FastifyRequest, @Query() query: { limit?: string; offset?: string; status?: string }) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const { limit, offset } = pagination(query);
    let qb = this.requireDb()
      .selectFrom("crm.leads")
      .select(["id", "person_id", "status", "stage", "created_at"])
      .where("tenant_id", "=", tenant.id)
      .orderBy("created_at", "desc")
      .limit(limit)
      .offset(offset);
    if (query.status !== undefined) {
      qb = qb.where("status", "=", query.status);
    }
    const rows = await qb.execute();
    return {
      leads: rows.map((r) => ({
        id: r.id,
        personId: r.person_id,
        status: r.status,
        stage: r.stage,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  @Get("leads/:id")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async getLead(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const row = await this.requireDb()
      .selectFrom("crm.leads")
      .select(["id", "person_id", "status", "stage", "created_at", "qualified_at", "lost_at", "closed_reason"])
      .where("tenant_id", "=", tenant.id)
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "lead not found" }, 404);
    }
    return {
      id: row.id,
      personId: row.person_id,
      status: row.status,
      stage: row.stage,
      createdAt: row.created_at.toISOString(),
      qualifiedAt: row.qualified_at?.toISOString() ?? null,
      lostAt: row.lost_at?.toISOString() ?? null,
      closedReason: row.closed_reason,
    };
  }

  @Post("leads/:id/transition")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async transitionLead(
    @Param("id") id: string,
    @Body() body: { toStatus?: unknown; reason?: unknown },
    @Req() req: FastifyRequest,
  ): Promise<{ id: string; status: string }> {
    const result = await this.bus.execute<{ id: string; status: string }>(
      actorFromRequest(req),
      "lead.transition",
      { leadId: id, toStatus: body.toStatus, reason: body.reason },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }
}
