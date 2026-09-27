import { Body, Controller, Get, HttpException, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
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

/**
 * Wave 6 Fulfillment surface: request CINEVISION-shaped provider work for a
 * PENDING_ACTIVATION subscription. Resolution/reconcile of the resulting
 * operation stays on the Wave 4 provider surface
 * (`POST /v1/provider/operations/:id/resolve|reconcile`), whose resume
 * hooks continue the subscription flow.
 */
@Controller("v1/fulfillment")
export class FulfillmentController {
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

  @Post("subscriptions/:id/request")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.write")
  async request(@Param("id") id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), subscriptionId: id }
        : { subscriptionId: id };
    const result = await this.bus.execute(actorFromRequest(req), "fulfillment.request_for_subscription", payload, {
      correlationId: req.id,
    });
    return send(result);
  }

  @Get("subscriptions/:id")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("subscription.read")
  async status(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const db = this.requireDb();
    const row = await db
      .selectFrom("provider.provider_operations")
      .select(["id", "action", "status", "effect_certainty", "requested_at"])
      .where("tenant_id", "=", tenant.id)
      .where("entity_type", "=", "subscription")
      .where("entity_id", "=", id)
      .orderBy("requested_at", "desc")
      .executeTakeFirst();
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "no fulfillment operation for this subscription" }, 404);
    }
    return {
      operationId: row.id,
      action: row.action,
      status: row.status,
      effectCertainty: row.effect_certainty,
      requestedAt: row.requested_at.toISOString(),
    };
  }
}
