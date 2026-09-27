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
 * Wave 4 Compatibility surface: device/app profiles plus network and
 * compatibility observations, with a read-only per-person summary.
 */
@Controller("v1/compatibility")
export class CompatibilityController {
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

  @Post("device-profiles")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.write")
  async recordDeviceProfile(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "compatibility.record_device_profile", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("app-profiles")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.write")
  async recordAppProfile(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "compatibility.record_app_profile", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("observations")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.write")
  async recordObservation(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "compatibility.record_observation", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Get("summary")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.read")
  async summary(@Req() req: FastifyRequest, @Query() query: { personId?: string }) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    if (query.personId === undefined || query.personId.length === 0) {
      throw new HttpException({ code: "VALIDATION_FAILED", message: "personId is required" }, 400);
    }
    const db = this.requireDb();
    const observations = await db
      .selectFrom("trial.compatibility_observations")
      .select([
        "id",
        "trial_id",
        "device_profile_id",
        "app_profile_id",
        "provider_server_key",
        "procedure_key",
        "outcome",
        "observed_at",
      ])
      .where("tenant_id", "=", tenant.id)
      .where("person_id", "=", query.personId)
      .orderBy("observed_at", "desc")
      .limit(50)
      .execute();
    const devices = await db
      .selectFrom("trial.device_profiles")
      .select(["id", "device_type", "manufacturer", "model", "os_name", "os_version", "last_seen_at"])
      .where("tenant_id", "=", tenant.id)
      .where("person_id", "=", query.personId)
      .orderBy("last_seen_at", "desc")
      .limit(20)
      .execute();
    const networks = await db
      .selectFrom("trial.network_observations")
      .select(["id", "trial_id", "isp_name", "network_type", "ipv6_state", "dns_profile", "observed_at"])
      .where("tenant_id", "=", tenant.id)
      .where("person_id", "=", query.personId)
      .orderBy("observed_at", "desc")
      .limit(20)
      .execute();
    const byOutcome: Record<string, number> = {};
    for (const obs of observations) {
      byOutcome[obs.outcome] = (byOutcome[obs.outcome] ?? 0) + 1;
    }
    return {
      personId: query.personId,
      observationCount: observations.length,
      byOutcome,
      latest: observations.slice(0, 5).map((o) => ({
        id: o.id,
        trialId: o.trial_id,
        deviceProfileId: o.device_profile_id,
        appProfileId: o.app_profile_id,
        providerServerKey: o.provider_server_key,
        procedureKey: o.procedure_key,
        outcome: o.outcome,
        observedAt: o.observed_at.toISOString(),
      })),
      devices: devices.map((d) => ({
        id: d.id,
        deviceType: d.device_type,
        manufacturer: d.manufacturer,
        model: d.model,
        osName: d.os_name,
        osVersion: d.os_version,
        lastSeenAt: d.last_seen_at.toISOString(),
      })),
      networks: networks.map((n) => ({
        id: n.id,
        trialId: n.trial_id,
        ispName: n.isp_name,
        networkType: n.network_type,
        ipv6State: n.ipv6_state,
        dnsProfile: n.dns_profile,
        observedAt: n.observed_at.toISOString(),
      })),
    };
  }

}
