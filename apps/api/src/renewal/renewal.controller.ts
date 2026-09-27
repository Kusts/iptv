import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
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
 * Wave 9 Renewal + Retention surface. Writes go through the `CommandBus`
 * (owning context for renewal quoting/activation, trust extensions and the
 * recovery queue); reads are plain tenant-scoped selects. No new stored
 * projection states — `projectedState` stays computed at read time.
 */
@Controller("v1/renewals")
export class RenewalController {
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

  @Post("quote")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.write")
  async quote(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "renewal.quote", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("renew")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.write")
  async renew(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "subscription.renew", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("reminders-due")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.write")
  async remindersDue(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "renewal.reminders_due", body ?? {}, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("trust-renew")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.write")
  async trustRenew(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "subscription.trust_renew", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("expire-overdue-due")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.write")
  async expireOverdueDue(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "renewal.expire_overdue_due", body ?? {}, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  /** Renewal orders for one subscription (linked cycles + customer RENEWAL orders). */
  @Get()
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.read")
  async list(
    @Query() query: { subscriptionId?: string; limit?: string },
    @Req() req: FastifyRequest,
  ) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    if (query.subscriptionId === undefined) {
      throw new HttpException({ code: "VALIDATION_FAILED", message: "subscriptionId is required" }, 400);
    }
    const db = this.requireDb();
    const subscription = await db
      .selectFrom("subscription.subscriptions")
      .select(["id", "customer_id"])
      .where("tenant_id", "=", tenant.id)
      .where("id", "=", query.subscriptionId)
      .executeTakeFirst();
    if (subscription === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "subscription not found" }, 404);
    }
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    const orders = await db
      .selectFrom("commerce.orders")
      .select(["id", "order_type", "status", "currency", "net_amount_minor", "created_at", "settled_at"])
      .where("tenant_id", "=", tenant.id)
      .where("customer_id", "=", subscription.customer_id)
      .where("order_type", "=", "RENEWAL")
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
    const cycles = await db
      .selectFrom("subscription.subscription_cycles")
      .select(["id", "cycle_no", "renewal_order_id"])
      .where("tenant_id", "=", tenant.id)
      .where("subscription_id", "=", subscription.id)
      .execute();
    const cycleByOrder = new Map<string, { id: string; cycleNo: number }>();
    for (const cycle of cycles) {
      if (cycle.renewal_order_id !== null) {
        cycleByOrder.set(cycle.renewal_order_id, { id: cycle.id, cycleNo: Number(cycle.cycle_no) });
      }
    }
    return {
      orders: orders.map((order) => ({
        id: order.id,
        orderType: order.order_type,
        status: order.status,
        currency: order.currency,
        netAmountMinor: String(order.net_amount_minor),
        cycle: cycleByOrder.get(order.id) ?? null,
        createdAt: order.created_at.toISOString(),
        settledAt: order.settled_at?.toISOString() ?? null,
      })),
    };
  }
}
