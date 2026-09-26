import { Body, Controller, HttpException, Inject, Post, Req, UseGuards } from "@nestjs/common";
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

/**
 * Tenant-scoped policy publish endpoint. Writes go through the `CommandBus`
 * (`policy.publish`, permission-gated, validated, audited). PLATFORM/PARTNER
 * documents additionally require a platform admin (enforced in the handler).
 */
@Controller("v1/policies")
export class PolicyController {
  constructor(@Inject(CommandBus) private readonly bus: CommandBus) {}

  @Post("publish")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("settings.manage")
  async publish(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<{ id: string; version: number }> {
    const actor = actorFromRequest(req);
    const result = await this.bus.execute<{ id: string; version: number }>(
      actor,
      "policy.publish",
      body,
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
