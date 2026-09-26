import {
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { AutonomyLevel, ResolutionStep } from "@iptv/domain";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import type { CommandActor } from "@iptv/domain";
import {
  ActionGate,
  type CapabilityStore,
  type GateActor,
} from "./capability-registry.js";

function gateActorFromRequest(req: FastifyRequest): GateActor {
  const auth = req.auth as NonNullable<FastifyRequest["auth"]>;
  const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
  const actor: CommandActor = {
    userId: auth.userId,
    isPlatformAdmin: auth.isPlatformAdmin,
    tenantId: tenant.id,
    roleKeys: tenant.roleKeys,
    permissions: tenant.permissions,
    actorType: "human",
  };
  return {
    userId: actor.userId,
    isPlatformAdmin: actor.isPlatformAdmin,
    tenantId: actor.tenantId,
    permissions: actor.permissions,
  };
}

interface CapabilityOverview {
  key: string;
  ownerContext: string;
  availability: string;
  riskLevel: string;
  policyFamily: string;
  action: AutonomyLevel;
  degraded: boolean;
  reason: string;
}

/**
 * Tenant-scoped capability reads. The catalog is global; every row is
 * resolved for the current actor (availability + permissions + policy), so
 * the overview shows the actions THIS actor may actually take.
 */
@Controller("v1/capabilities")
export class CapabilitiesController {
  constructor(
    @Inject("CAPABILITY_STORE") private readonly store: CapabilityStore,
    @Inject(ActionGate) private readonly gate: ActionGate,
  ) {}

  @Get()
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async list(@Req() req: FastifyRequest): Promise<{ capabilities: CapabilityOverview[] }> {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const actor = gateActorFromRequest(req);
    const rows = await this.store.list();
    const capabilities: CapabilityOverview[] = [];
    for (const row of rows) {
      const resolved = await this.gate.resolve(row, actor, { tenantId: tenant.id });
      capabilities.push({
        key: row.key,
        ownerContext: row.ownerContext,
        availability: row.availability,
        riskLevel: row.riskLevel,
        policyFamily: row.policyFamily,
        action: resolved.action,
        degraded: resolved.degraded,
        reason: resolved.reason,
      });
    }
    return { capabilities };
  }

  @Get(":key/resolve")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async resolve(
    @Param("key") key: string,
    @Req() req: FastifyRequest,
    @Query("partnerId") partnerId?: string,
  ): Promise<{
    key: string;
    action: AutonomyLevel;
    degraded: boolean;
    reason: string;
    provenance: ResolutionStep[];
  }> {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const actor = gateActorFromRequest(req);
    const row = await this.store.get(key);
    if (row === null) {
      throw new HttpException({ code: "NOT_FOUND", message: `capability not found: ${key}` }, 404);
    }
    const resolved = await this.gate.resolve(row, actor, {
      tenantId: tenant.id,
      partnerId,
    });
    return {
      key: row.key,
      action: resolved.action,
      degraded: resolved.degraded,
      reason: resolved.reason,
      provenance: resolved.provenance,
    };
  }
}
