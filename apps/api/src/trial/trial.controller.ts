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
 * Wave 4 Trial surface. Writes go through the `CommandBus` (owning context
 * for ServiceTrial); reads are plain tenant-scoped selects.
 */
@Controller("v1/trials")
export class TrialController {
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

  @Post("request")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.write")
  async request(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "trial.request", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("retrials")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.write")
  async requestRetrial(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "trial.request_retrial", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("expire-due")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.write")
  async expireDue(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "trial.expire_due", body ?? {}, {
      correlationId: req.id,
    });
    return send(result);
  }

  @Post(":id/begin-provisioning")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.write")
  async beginProvisioning(@Param("id") id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), trialId: id }
        : { trialId: id };
    const result = await this.bus.execute(actorFromRequest(req), "trial.begin_provisioning", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post(":id/technical-result")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.write")
  async recordTechnicalResult(@Param("id") id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), trialId: id }
        : { trialId: id };
    const result = await this.bus.execute(actorFromRequest(req), "trial.record_technical_result", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post(":id/end")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.write")
  async end(@Param("id") id: string, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "trial.end", { trialId: id }, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post(":id/cancel")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.write")
  async cancel(@Param("id") id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), trialId: id }
        : { trialId: id };
    const result = await this.bus.execute(actorFromRequest(req), "trial.cancel", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post(":id/invalidate")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.write")
  async invalidate(@Param("id") id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), trialId: id }
        : { trialId: id };
    const result = await this.bus.execute(actorFromRequest(req), "trial.invalidate", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post(":id/trust-renewal")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.write")
  async trustRenewal(@Param("id") id: string, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "trial.apply_trust_renewal", { trialId: id }, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Get()
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.read")
  async list(
    @Req() req: FastifyRequest,
    @Query() query: { limit?: string; offset?: string; personId?: string; status?: string },
  ) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const { limit, offset } = pagination(query);
    let qb = this.requireDb()
      .selectFrom("trial.trials")
      .select([
        "id",
        "person_id",
        "trial_kind",
        "lifecycle_status",
        "technical_outcome",
        "requested_duration_minutes",
        "activated_at",
        "expires_at",
        "created_at",
      ])
      .where("tenant_id", "=", tenant.id)
      .orderBy("created_at", "desc")
      .limit(limit)
      .offset(offset);
    if (query.personId !== undefined) {
      qb = qb.where("person_id", "=", query.personId);
    }
    if (query.status !== undefined) {
      qb = qb.where("lifecycle_status", "=", query.status);
    }
    const rows = await qb.execute();
    return {
      trials: rows.map((r) => ({
        id: r.id,
        personId: r.person_id,
        trialKind: r.trial_kind,
        lifecycleStatus: r.lifecycle_status,
        technicalOutcome: r.technical_outcome,
        requestedDurationMinutes: Number(r.requested_duration_minutes),
        activatedAt: r.activated_at?.toISOString() ?? null,
        expiresAt: r.expires_at?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  @Get(":id")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.read")
  async get(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const db = this.requireDb();
    const row = await db
      .selectFrom("trial.trials")
      .select([
        "id",
        "person_id",
        "lead_id",
        "previous_trial_id",
        "trial_kind",
        "retrial_reason",
        "lifecycle_status",
        "technical_outcome",
        "requested_duration_minutes",
        "adult_content_enabled",
        "provider_account_id",
        "activated_at",
        "expires_at",
        "ended_at",
        "invalidated_reason",
        "created_at",
      ])
      .where("tenant_id", "=", tenant.id)
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "trial not found" }, 404);
    }
    const attempts = await db
      .selectFrom("trial.trial_attempts")
      .select(["id", "attempt_type", "outcome", "error_code", "started_at"])
      .where("tenant_id", "=", tenant.id)
      .where("trial_id", "=", id)
      .orderBy("started_at", "asc")
      .execute();
    const technical = await db
      .selectFrom("trial.trial_technical_results")
      .select([
        "id",
        "installation_success",
        "authentication_success",
        "playback_success",
        "buffering_observed",
        "summary_outcome",
        "assessed_at",
      ])
      .where("tenant_id", "=", tenant.id)
      .where("trial_id", "=", id)
      .executeTakeFirst();
    return {
      id: row.id,
      personId: row.person_id,
      leadId: row.lead_id,
      previousTrialId: row.previous_trial_id,
      trialKind: row.trial_kind,
      retrialReason: row.retrial_reason,
      lifecycleStatus: row.lifecycle_status,
      technicalOutcome: row.technical_outcome,
      requestedDurationMinutes: Number(row.requested_duration_minutes),
      adultContentEnabled: row.adult_content_enabled,
      providerAccountId: row.provider_account_id,
      activatedAt: row.activated_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null,
      endedAt: row.ended_at?.toISOString() ?? null,
      invalidatedReason: row.invalidated_reason,
      createdAt: row.created_at.toISOString(),
      attempts: attempts.map((a) => ({
        id: a.id,
        attemptType: a.attempt_type,
        outcome: a.outcome,
        errorCode: a.error_code,
        startedAt: a.started_at.toISOString(),
      })),
      technicalResult:
        technical === undefined
          ? null
          : {
              id: technical.id,
              installationSuccess: technical.installation_success,
              authenticationSuccess: technical.authentication_success,
              playbackSuccess: technical.playback_success,
              bufferingObserved: technical.buffering_observed,
              summaryOutcome: technical.summary_outcome,
              assessedAt: technical.assessed_at.toISOString(),
            },
    };
  }

  @Get(":id/technical-result")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.read")
  async getTechnicalResult(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const row = await this.requireDb()
      .selectFrom("trial.trial_technical_results")
      .select([
        "id",
        "trial_id",
        "installation_success",
        "authentication_success",
        "playback_success",
        "buffering_observed",
        "summary_outcome",
        "assessed_at",
      ])
      .where("tenant_id", "=", tenant.id)
      .where("trial_id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "technical result not found" }, 404);
    }
    return {
      id: row.id,
      trialId: row.trial_id,
      installationSuccess: row.installation_success,
      authenticationSuccess: row.authentication_success,
      playbackSuccess: row.playback_success,
      bufferingObserved: row.buffering_observed,
      summaryOutcome: row.summary_outcome,
      assessedAt: row.assessed_at.toISOString(),
    };
  }
}
