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
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import { CommandBus, commandActorFromRequestParts } from "../commands/command-bus.js";
import type { CommandActor, CommandResult } from "@iptv/domain";
import { OPEN_REVIEW_STATUSES } from "./human-review.commands.js";

const ALL_STATUSES = [
  "REQUESTED",
  "QUEUED",
  "ACKNOWLEDGED",
  "IN_REVIEW",
  "GUIDANCE_PROVIDED",
  "ACTION_TAKEN",
  "RESOLVED",
  "EXPIRED",
  "CANCELLED",
] as const;

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

/**
 * Tenant-scoped HumanReview queue + decision endpoints. Every write goes
 * through the `CommandBus` (permission-gated, validated, audited, with
 * domain event + outbox in the same transaction). Queue reads are plain
 * tenant-scoped selects — no command needed for reads.
 */
@Controller("v1/human-reviews")
export class HumanReviewController {
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

  /**
   * Tenant-scoped queue. `status` accepts any lifecycle state; the `PENDING`
   * alias (and omission) selects the open queue
   * (`REQUESTED|QUEUED|ACKNOWLEDGED|IN_REVIEW`).
   */
  @Get()
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("agent.review.request")
  async queue(@Req() req: FastifyRequest, @Query("status") status?: string): Promise<{
    reviews: Array<{
      id: string;
      status: string;
      reviewMode: string;
      reason: string;
      priority: string;
      resourceType: string;
      resourceId: string;
      summary: string;
      createdAt: string;
      resolvedAt: string | null;
    }>;
  }> {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    let wanted: string[];
    if (status === undefined || status === "PENDING") {
      wanted = [...OPEN_REVIEW_STATUSES];
    } else if ((ALL_STATUSES as readonly string[]).includes(status)) {
      wanted = [status];
    } else {
      throw new HttpException({ code: "INVALID_STATUS", message: `unknown status: ${status}` }, 400);
    }
    const rows = await this.requireDb()
      .selectFrom("agent.human_review_requests")
      .select([
        "id",
        "status",
        "review_mode",
        "reason",
        "priority",
        "resource_type",
        "resource_id",
        "summary",
        "created_at",
        "resolved_at",
      ])
      .where("tenant_id", "=", tenant.id)
      .where("status", "in", wanted)
      .orderBy("created_at", "asc")
      .execute();
    return {
      reviews: rows.map((r) => ({
        id: r.id,
        status: r.status,
        reviewMode: r.review_mode,
        reason: r.reason,
        priority: r.priority,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        summary: r.summary,
        createdAt: r.created_at.toISOString(),
        resolvedAt: r.resolved_at?.toISOString() ?? null,
      })),
    };
  }

  @Post()
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("agent.review.request")
  async request(@Body() body: unknown, @Req() req: FastifyRequest): Promise<{ id: string }> {
    const actor = actorFromRequest(req);
    const result = await this.bus.execute<{ id: string }>(actor, "human_review.request", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post(":id/approve")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("agent.review.decide")
  async approve(
    @Param("id") id: string,
    @Body() body: { expectedStatus?: unknown; note?: unknown },
    @Req() req: FastifyRequest,
  ): Promise<{ id: string; resolution: string }> {
    const actor = actorFromRequest(req);
    const result = await this.bus.execute<{ id: string; resolution: string }>(
      actor,
      "human_review.approve",
      { requestId: id, expectedStatus: body.expectedStatus, note: body.note },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  @Post(":id/reject")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("agent.review.decide")
  async reject(
    @Param("id") id: string,
    @Body() body: { expectedStatus?: unknown; note?: unknown },
    @Req() req: FastifyRequest,
  ): Promise<{ id: string; resolution: string }> {
    const actor = actorFromRequest(req);
    const result = await this.bus.execute<{ id: string; resolution: string }>(
      actor,
      "human_review.reject",
      { requestId: id, expectedStatus: body.expectedStatus, note: body.note },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }
}

function idempotencyKeyOf(req: FastifyRequest): string | undefined {
  const header = req.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}
