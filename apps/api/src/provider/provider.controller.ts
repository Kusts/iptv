import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
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

function idempotencyKeyOf(req: FastifyRequest): string | undefined {
  const header = req.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

/**
 * Wave 4 Provider surface. The provider operator resolves or reconciles
 * operations here; trial-linked outcomes resume the trial flow inside the
 * same command transaction.
 */
@Controller("v1/provider")
export class ProviderController {
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

  @Post("operations")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("provider.operation.write")
  async request(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "provider.request_operation", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("operations/:id/resolve")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("provider.operation.write")
  async resolve(@Param("id") id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), operationId: id }
        : { operationId: id };
    const result = await this.bus.execute(actorFromRequest(req), "provider.resolve_operation", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("operations/:id/reconcile")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("provider.operation.write")
  async reconcile(@Param("id") id: string, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(
      actorFromRequest(req),
      "provider.reconcile",
      { operationId: id },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  @Get("operations/:id")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("provider.operation.read")
  async get(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const db = this.requireDb();
    const row = await db
      .selectFrom("provider.provider_operations")
      .select([
        "id",
        "provider_account_id",
        "action",
        "entity_type",
        "entity_id",
        "status",
        "effect_certainty",
        "execution_channel",
        "adapter_version",
        "requested_at",
        "started_at",
        "completed_at",
      ])
      .where("tenant_id", "=", tenant.id)
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "provider operation not found" }, 404);
    }
    const attempts = await db
      .selectFrom("provider.provider_operation_attempts")
      .select(["attempt_no", "status", "error_code", "started_at"])
      .where("tenant_id", "=", tenant.id)
      .where("provider_operation_id", "=", id)
      .orderBy("attempt_no", "asc")
      .execute();
    return {
      id: row.id,
      providerAccountId: row.provider_account_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      status: row.status,
      effectCertainty: row.effect_certainty,
      executionChannel: row.execution_channel,
      adapterVersion: row.adapter_version,
      requestedAt: row.requested_at.toISOString(),
      startedAt: row.started_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? null,
      attempts: attempts.map((a) => ({
        attemptNo: Number(a.attempt_no),
        status: a.status,
        errorCode: a.error_code,
        startedAt: a.started_at.toISOString(),
      })),
    };
  }
}
