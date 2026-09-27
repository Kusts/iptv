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
import { computeProjectedState } from "./subscription-policy.js";

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
 * Wave 6 Subscription surface. Writes go through the `CommandBus` (owning
 * context for CustomerSubscription/Cycle/Entitlements); reads are plain
 * tenant-scoped selects with the billing projection (`RENEWAL_DUE`/`GRACE`/
 * `OVERDUE`) computed at read time — never stored.
 */
@Controller("v1/subscriptions")
export class SubscriptionController {
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

  @Post("from-order")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.write")
  async fromOrder(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "subscription.activate_from_order", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post(":id/activate")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.write")
  async activate(@Param("id") id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), subscriptionId: id }
        : { subscriptionId: id };
    const result = await this.bus.execute(actorFromRequest(req), "subscription.activate", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post(":id/cancel-at-period-end")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.write")
  async cancelAtPeriodEnd(@Param("id") id: string, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(
      actorFromRequest(req),
      "subscription.cancel_at_period_end",
      { subscriptionId: id },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  @Post(":id/resume")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.write")
  async resume(@Param("id") id: string, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(
      actorFromRequest(req),
      "subscription.resume",
      { subscriptionId: id },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  @Post(":id/suspend")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.write")
  async suspend(@Param("id") id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), subscriptionId: id }
        : { subscriptionId: id };
    const result = await this.bus.execute(actorFromRequest(req), "subscription.suspend", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post(":id/reinstate")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.write")
  async reinstate(@Param("id") id: string, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(
      actorFromRequest(req),
      "subscription.reinstate",
      { subscriptionId: id },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  @Post("expire-due")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.write")
  async expireDue(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "subscription.expire_cycles_due", body ?? {}, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Get(":id")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.read")
  async get(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const db = this.requireDb();
    const row = await db
      .selectFrom("subscription.subscriptions")
      .select([
        "id",
        "customer_id",
        "plan_id",
        "originating_order_id",
        "status",
        "started_at",
        "current_period_start",
        "current_period_end",
        "cancel_at_period_end",
        "cancelled_at",
      ])
      .where("tenant_id", "=", tenant.id)
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "subscription not found" }, 404);
    }
    const cycles = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["id", "cycle_no", "starts_at", "ends_at", "status"])
      .where("tenant_id", "=", tenant.id)
      .where("subscription_id", "=", id)
      .orderBy("cycle_no", "asc")
      .execute();
    const entitlements = await db
      .selectFrom("entitlement.entitlements")
      .select(["id", "feature_key", "status", "starts_at", "ends_at"])
      .where("tenant_id", "=", tenant.id)
      .where("source_type", "=", "subscription")
      .where("source_id", "=", id)
      .execute();
    return {
      id: row.id,
      customerId: row.customer_id,
      planId: row.plan_id,
      originatingOrderId: row.originating_order_id,
      status: row.status,
      projectedState: computeProjectedState({ status: row.status, currentPeriodEnd: row.current_period_end }),
      startedAt: row.started_at?.toISOString() ?? null,
      currentPeriodStart: row.current_period_start?.toISOString() ?? null,
      currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
      cancelAtPeriodEnd: row.cancel_at_period_end,
      cancelledAt: row.cancelled_at?.toISOString() ?? null,
      cycles: cycles.map((c) => ({
        id: c.id,
        cycleNo: Number(c.cycle_no),
        startsAt: c.starts_at.toISOString(),
        endsAt: c.ends_at.toISOString(),
        status: c.status,
      })),
      entitlements: entitlements.map((e) => ({
        id: e.id,
        featureKey: e.feature_key,
        status: e.status,
        startsAt: e.starts_at.toISOString(),
        endsAt: e.ends_at?.toISOString() ?? null,
      })),
    };
  }

  @Get()
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.read")
  async list(@Query() query: { status?: string; limit?: string }, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const db = this.requireDb();
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    let select = db
      .selectFrom("subscription.subscriptions")
      .select(["id", "customer_id", "plan_id", "status", "current_period_start", "current_period_end", "cancel_at_period_end"])
      .where("tenant_id", "=", tenant.id)
      .orderBy("created_at", "desc")
      .limit(limit);
    if (query.status !== undefined) {
      select = select.where("status", "=", query.status);
    }
    const rows = await select.execute();
    return {
      subscriptions: rows.map((row) => ({
        id: row.id,
        customerId: row.customer_id,
        planId: row.plan_id,
        status: row.status,
        projectedState: computeProjectedState({ status: row.status, currentPeriodEnd: row.current_period_end }),
        currentPeriodStart: row.current_period_start?.toISOString() ?? null,
        currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
        cancelAtPeriodEnd: row.cancel_at_period_end,
      })),
    };
  }
}
