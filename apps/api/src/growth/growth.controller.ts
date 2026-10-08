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
import { withTenantTransaction, type Database } from "@iptv/database";
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
 * Wave 11 Campaigns/Attribution surface. Writes go through the `CommandBus`
 * (owning context for campaign lifecycle, audiences, MessageIntent
 * scheduling and attribution); reads run inside `withTenantTransaction`
 * (actor tenant): the tables below are RLS-enrolled (growth.* in migration
 * 058, communication.message_intents in 042 — both fail-closed when
 * `app.tenant_id` is unset), so pool-level selects under `iptv_app` would
 * return empty silently after cutover. The explicit `tenant_id =`
 * predicates stay as defense-in-depth alongside the RLS policy.
 *
 * Campaign writes reuse the acquisition permission (`crm.lead.write`); reads
 * use `crm.person.read`. No new permission keys (no migration in slice).
 * Scheduling NEVER sends: intents sit behind the manual messaging gateway.
 */
@Controller("v1")
export class GrowthController {
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

  private async requireCampaign(tenantId: string, campaignId: string): Promise<void> {
    // P1.5-058 (P1.3 FIX1 mirror): tenant-scoped read inside the request
    // tenant's context — direct reads fail-closed under `iptv_app`.
    const row = await withTenantTransaction(this.requireDb(), tenantId, (trx) =>
      trx
        .selectFrom("growth.campaigns")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", campaignId)
        .executeTakeFirst(),
    );
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "campaign not found" }, 404);
    }
  }

  @Post("campaigns")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async createCampaign(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "growth.create_campaign", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Get("campaigns")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async listCampaigns(@Query() query: { limit?: string }, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    // P1.5-058 (P1.3 FIX1 mirror): see requireCampaign().
    const rows = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("growth.campaigns")
        .select(["id", "campaign_key", "name", "objective", "status", "current_version_id", "created_at", "updated_at"])
        .where("tenant_id", "=", tenant.id)
        .orderBy("created_at", "desc")
        .limit(limit)
        .execute(),
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        campaignKey: row.campaign_key,
        name: row.name,
        objective: row.objective,
        status: row.status,
        currentVersionId: row.current_version_id,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
    };
  }

  @Get("campaigns/:campaignId")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async getCampaign(@Param("campaignId") campaignId: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    // P1.5-058 (P1.3 FIX1 mirror): see requireCampaign().
    const row = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("growth.campaigns")
        .select(["id", "campaign_key", "name", "objective", "status", "current_version_id", "created_at", "updated_at"])
        .where("tenant_id", "=", tenant.id)
        .where("id", "=", campaignId)
        .executeTakeFirst(),
    );
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "campaign not found" }, 404);
    }
    return {
      id: row.id,
      campaignKey: row.campaign_key,
      name: row.name,
      objective: row.objective,
      status: row.status,
      currentVersionId: row.current_version_id,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private async transition(
    req: FastifyRequest,
    campaignId: string,
    command: "growth.activate_campaign" | "growth.pause_campaign" | "growth.complete_campaign",
  ) {
    const result = await this.bus.execute(actorFromRequest(req), command, { campaignId }, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("campaigns/:campaignId/versions")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async publishVersion(
    @Param("campaignId") campaignId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), campaignId }
        : { campaignId };
    const result = await this.bus.execute(actorFromRequest(req), "growth.publish_version", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("campaigns/:campaignId/creatives")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async addCreative(
    @Param("campaignId") campaignId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), campaignId }
        : { campaignId };
    const result = await this.bus.execute(actorFromRequest(req), "growth.add_creative", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("campaigns/:campaignId/activate")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async activateCampaign(@Param("campaignId") campaignId: string, @Req() req: FastifyRequest) {
    return this.transition(req, campaignId, "growth.activate_campaign");
  }

  @Post("campaigns/:campaignId/pause")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async pauseCampaign(@Param("campaignId") campaignId: string, @Req() req: FastifyRequest) {
    return this.transition(req, campaignId, "growth.pause_campaign");
  }

  @Post("campaigns/:campaignId/complete")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async completeCampaign(@Param("campaignId") campaignId: string, @Req() req: FastifyRequest) {
    return this.transition(req, campaignId, "growth.complete_campaign");
  }

  @Post("campaigns/:campaignId/schedule")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async scheduleIntent(
    @Param("campaignId") campaignId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const base =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>) }
        : {};
    const key = idempotencyKeyOf(req);
    const payload = { ...base, campaignId, ...(key !== undefined ? { intentKey: key } : {}) };
    const result = await this.bus.execute(actorFromRequest(req), "growth.schedule_intent", payload, {
      correlationId: req.id,
      idempotencyKey: key,
    });
    return send(result);
  }

  @Post("audiences")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async defineAudience(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "growth.define_audience", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Get("audiences")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async listAudiences(@Query() query: { limit?: string }, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    // P1.5-058 (P1.3 FIX1 mirror): see requireCampaign().
    const rows = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("growth.audience_definitions")
        .select(["id", "campaign_id", "name", "membership_type", "criteria_json", "created_at"])
        .where("tenant_id", "=", tenant.id)
        .orderBy("created_at", "desc")
        .limit(limit)
        .execute(),
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        campaignId: row.campaign_id,
        name: row.name,
        membershipType: row.membership_type,
        criteria: (row.criteria_json ?? {}) as Record<string, unknown>,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  @Post("attribution/touches")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async recordTouch(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "growth.record_touch", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("attribution/conversions")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async recordConversion(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "growth.record_conversion", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Get("attribution")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async getAttribution(@Query("personId") personId: string | undefined, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    if (typeof personId !== "string" || personId.length === 0) {
      throw new HttpException({ code: "VALIDATION_FAILED", message: "personId query param is required" }, 400);
    }
    // P1.5-058 (P1.3 FIX1 mirror): see requireCampaign() — both attribution
    // tables are RLS-enrolled (058), so the pair reads in one tenant context.
    const { touches, conversions } = await withTenantTransaction(this.requireDb(), tenant.id, async (trx) => {
      const touches = await trx
        .selectFrom("growth.attribution_touches")
        .select(["id", "person_id", "campaign_id", "campaign_version_id", "touch_type", "occurred_at", "created_at"])
        .where("tenant_id", "=", tenant.id)
        .where("person_id", "=", personId)
        .orderBy("occurred_at", "asc")
        .execute();
      const conversions = await trx
        .selectFrom("growth.conversion_events")
        .select([
          "id",
          "person_id",
          "campaign_id",
          "campaign_version_id",
          "conversion_type",
          "order_id",
          "amount_minor",
          "currency",
          "occurred_at",
          "created_at",
        ])
        .where("tenant_id", "=", tenant.id)
        .where("person_id", "=", personId)
        .orderBy("occurred_at", "asc")
        .execute();
      return { touches, conversions };
    });
    return {
      personId,
      touches: touches.map((row) => ({
        id: row.id,
        personId: row.person_id,
        campaignId: row.campaign_id,
        campaignVersionId: row.campaign_version_id,
        touchType: row.touch_type,
        occurredAt: row.occurred_at.toISOString(),
        createdAt: row.created_at.toISOString(),
      })),
      conversions: conversions.map((row) => ({
        id: row.id,
        personId: row.person_id,
        campaignId: row.campaign_id,
        campaignVersionId: row.campaign_version_id,
        conversionType: row.conversion_type,
        orderId: row.order_id,
        amountMinor: row.amount_minor === null ? null : String(row.amount_minor),
        currency: row.currency,
        occurredAt: row.occurred_at.toISOString(),
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  @Get("campaigns/:campaignId/intents")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async listIntents(@Param("campaignId") campaignId: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    await this.requireCampaign(tenant.id, campaignId);
    // P1.5-058 (P1.3 FIX1 mirror): see requireCampaign()
    // (message_intents enrolled in 042, same fail-closed shape).
    const rows = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("communication.message_intents")
        .select(["id", "campaign_id", "campaign_version_id", "channel", "purpose_key", "status", "scheduled_for", "created_at"])
        .where("tenant_id", "=", tenant.id)
        .where("campaign_id", "=", campaignId)
        .orderBy("created_at", "desc")
        .limit(200)
        .execute(),
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        campaignId: row.campaign_id,
        campaignVersionId: row.campaign_version_id,
        channel: row.channel,
        purposeKey: row.purpose_key,
        status: row.status,
        scheduledFor: row.scheduled_for.toISOString(),
        createdAt: row.created_at.toISOString(),
      })),
    };
  }
}
