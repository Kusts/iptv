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
import type { CommandResult, CommandActor } from "@iptv/domain";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import { CommandBus, commandActorFromRequestParts } from "../commands/command-bus.js";

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
 * Wave 9 recovery queue surface: human-worked winback tasks only — no
 * campaign automation exists on this path. Writes go through the
 * `CommandBus`; reads are plain tenant-scoped selects.
 */
@Controller("v1/recovery-tasks")
export class RecoveryController {
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

  @Post(":id/resolve")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.write")
  async resolveTask(@Param("id") id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), taskId: id }
        : { taskId: id };
    const result = await this.bus.execute(actorFromRequest(req), "recovery.resolve", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Get()
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.read")
  async list(
    @Query() query: { subscriptionId?: string; status?: string; limit?: string },
    @Req() req: FastifyRequest,
  ) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const db = this.requireDb();
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    let select = db
      .selectFrom("renewal.recovery_tasks")
      .select(["id", "subscription_id", "cycle_id", "renewal_order_id", "reason", "status", "outcome", "created_at"])
      .where("tenant_id", "=", tenant.id)
      .orderBy("created_at", "desc")
      .limit(limit);
    if (query.subscriptionId !== undefined) {
      select = select.where("subscription_id", "=", query.subscriptionId);
    }
    if (query.status !== undefined) {
      select = select.where("status", "=", query.status);
    }
    const rows = await select.execute();
    return {
      tasks: rows.map((row) => ({
        id: row.id,
        subscriptionId: row.subscription_id,
        cycleId: row.cycle_id,
        renewalOrderId: row.renewal_order_id,
        reason: row.reason,
        status: row.status,
        outcome: row.outcome,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }
}
