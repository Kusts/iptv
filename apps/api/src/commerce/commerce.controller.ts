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
 * Wave 5 Commerce surface. Writes go through the `CommandBus` (owning
 * context for Order economics; SETTLED is reachable only via the billing
 * settlement service — there is no `order.settle` route). Reads are plain
 * tenant-scoped selects.
 */
@Controller("v1/orders")
export class CommerceController {
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
  @RequirePermission("commerce.order.write")
  async quote(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "offer.quote", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post(":id/submit")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("commerce.order.write")
  async submit(@Param("id") id: string, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "order.submit", { orderId: id }, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post(":id/cancel")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("commerce.order.write")
  async cancel(@Param("id") id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const payload = { orderId: id, ...((body ?? {}) as Record<string, unknown>) };
    const result = await this.bus.execute(actorFromRequest(req), "order.cancel", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("expire-due")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("commerce.order.write")
  async expireDue(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "order.expire_due", body ?? {}, {
      correlationId: req.id,
    });
    return send(result);
  }

  @Get(":id")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.read")
  async get(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const order = await this.requireDb()
      .selectFrom("commerce.orders")
      .select([
        "id",
        "person_id",
        "customer_id",
        "order_type",
        "status",
        "currency",
        "gross_amount_minor",
        "discount_amount_minor",
        "reward_amount_minor",
        "net_amount_minor",
        "settled_amount_minor",
        "created_at",
        "awaiting_payment_at",
        "settled_at",
        "cancelled_at",
        "expires_at",
      ])
      .where("tenant_id", "=", tenant.id)
      .where("id", "=", id)
      .executeTakeFirst();
    if (order === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "order not found" }, 404);
    }
    const items = await this.requireDb()
      .selectFrom("commerce.order_items")
      .select([
        "id",
        "item_type",
        "sellable_type",
        "sellable_id",
        "quantity",
        "unit_price_minor",
        "gross_minor",
        "net_minor",
      ])
      .where("tenant_id", "=", tenant.id)
      .where("order_id", "=", id)
      .execute();
    return { order, items };
  }

  @Get()
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.read")
  async list(@Query() query: { limit?: string; offset?: string; status?: string }, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const { limit, offset } = pagination(query);
    let select = this.requireDb()
      .selectFrom("commerce.orders")
      .select(["id", "person_id", "status", "currency", "net_amount_minor", "settled_amount_minor", "created_at"])
      .where("tenant_id", "=", tenant.id)
      .orderBy("created_at", "desc")
      .limit(limit)
      .offset(offset);
    if (typeof query.status === "string" && query.status.length > 0) {
      select = select.where("status", "=", query.status);
    }
    return { orders: await select.execute() };
  }
}
