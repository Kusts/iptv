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
 * Wave 12 Referral + Rewards surface. Writes go through the `CommandBus`
 * (owning context for attribution/qualification/issue/redeem/gift-pass);
 * reads run inside `withTenantTransaction` (actor tenant): the tables below
 * are RLS-enrolled (migration 058, fail-closed when `app.tenant_id` is
 * unset), so pool-level selects under `iptv_app` would return empty
 * silently after cutover. The explicit `tenant_id =` predicates stay as
 * defense-in-depth alongside the RLS policy.
 * Referral writes reuse the acquisition permission (`crm.lead.write`);
 * reward redemption creates an order, so it requires
 * `commerce.order.write`. No new permission keys (no migration in slice).
 */
@Controller("v1")
export class ReferralController {
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

  private async requireCustomer(tenantId: string, customerId: string): Promise<void> {
    // P1.5-058 (P1.3 FIX1 mirror): tenant-scoped read inside the request
    // tenant's context — direct reads fail-closed under `iptv_app`.
    const row = await withTenantTransaction(this.requireDb(), tenantId, (trx) =>
      trx
        .selectFrom("crm.customers")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", customerId)
        .executeTakeFirst(),
    );
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "customer not found" }, 404);
    }
  }

  @Post("customers/:customerId/referrals")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async createReferral(
    @Param("customerId") customerId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), customerId }
        : { customerId };
    const result = await this.bus.execute(actorFromRequest(req), "referral.create", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Get("customers/:customerId/referrals")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async listCustomerReferrals(
    @Param("customerId") customerId: string,
    @Query() query: { limit?: string },
    @Req() req: FastifyRequest,
  ) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    await this.requireCustomer(tenant.id, customerId);
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    // P1.5-058 (P1.3 FIX1 mirror): see requireCustomer().
    const rows = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("referral.referrals")
        .select([
          "id",
          "program_id",
          "advocate_customer_id",
          "referred_person_id",
          "referral_code",
          "status",
          "created_at",
          "confirmed_at",
        ])
        .where("tenant_id", "=", tenant.id)
        .where("advocate_customer_id", "=", customerId)
        .orderBy("created_at", "desc")
        .limit(limit)
        .execute(),
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        advocateCustomerId: row.advocate_customer_id,
        code: row.referral_code,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        referredPersonId: row.referred_person_id,
        programId: row.program_id,
        confirmedAt: row.confirmed_at?.toISOString() ?? null,
      })),
    };
  }

  @Get("referrals/:referralId")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async getReferral(@Param("referralId") referralId: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    // P1.5-058 (P1.3 FIX1 mirror): see requireCustomer().
    const row = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("referral.referrals")
        .select([
          "id",
          "program_id",
          "advocate_customer_id",
          "referred_person_id",
          "referral_code",
          "status",
          "created_at",
          "confirmed_at",
        ])
        .where("tenant_id", "=", tenant.id)
        .where("id", "=", referralId)
        .executeTakeFirst(),
    );
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "referral not found" }, 404);
    }
    return {
      id: row.id,
      advocateCustomerId: row.advocate_customer_id,
      code: row.referral_code,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      referredPersonId: row.referred_person_id,
      programId: row.program_id,
      confirmedAt: row.confirmed_at?.toISOString() ?? null,
    };
  }

  @Post("referrals/:referralId/qualification")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async qualifyReferral(
    @Param("referralId") referralId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), referralId }
        : { referralId };
    const result = await this.bus.execute(actorFromRequest(req), "referral.qualify", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Get("customers/:customerId/rewards")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async listCustomerRewards(@Param("customerId") customerId: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    await this.requireCustomer(tenant.id, customerId);
    // P1.5-058 (P1.3 FIX1 mirror): see requireCustomer().
    const rows = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("loyalty.rewards")
        .select([
          "id",
          "customer_id",
          "reward_definition_id",
          "status",
          "economic_value_minor",
          "estimated_cost_minor",
          "currency",
          "available_at",
          "redeemed_at",
          "expires_at",
          "created_at",
        ])
        .where("tenant_id", "=", tenant.id)
        .where("customer_id", "=", customerId)
        .orderBy("created_at", "desc")
        .limit(200)
        .execute(),
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        customerId: row.customer_id,
        rewardDefinitionId: row.reward_definition_id,
        status: row.status,
        economicValueMinor:
          row.economic_value_minor === null ? null : String(row.economic_value_minor),
        estimatedCostMinor:
          row.estimated_cost_minor === null ? null : String(row.estimated_cost_minor),
        currency: row.currency,
        availableAt: row.available_at?.toISOString() ?? null,
        redeemedAt: row.redeemed_at?.toISOString() ?? null,
        expiresAt: row.expires_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  @Get("rewards/:rewardId")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async getReward(@Param("rewardId") rewardId: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    // P1.5-058 (P1.3 FIX1 mirror): see requireCustomer().
    const row = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("loyalty.rewards")
        .select([
          "id",
          "customer_id",
          "reward_definition_id",
          "status",
          "economic_value_minor",
          "estimated_cost_minor",
          "currency",
          "available_at",
          "redeemed_at",
          "expires_at",
          "created_at",
        ])
        .where("tenant_id", "=", tenant.id)
        .where("id", "=", rewardId)
        .executeTakeFirst(),
    );
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "reward not found" }, 404);
    }
    return {
      id: row.id,
      customerId: row.customer_id,
      rewardDefinitionId: row.reward_definition_id,
      status: row.status,
      economicValueMinor: row.economic_value_minor === null ? null : String(row.economic_value_minor),
      estimatedCostMinor:
        row.estimated_cost_minor === null ? null : String(row.estimated_cost_minor),
      currency: row.currency,
      availableAt: row.available_at?.toISOString() ?? null,
      redeemedAt: row.redeemed_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
    };
  }

  @Post("rewards/:rewardId/redeem")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("commerce.order.write")
  async redeemReward(
    @Param("rewardId") rewardId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), rewardId }
        : { rewardId };
    const result = await this.bus.execute<{ rewardId: string; orderId: string | null }>(
      actorFromRequest(req),
      "reward.redeem",
      payload,
      {
        correlationId: req.id,
        idempotencyKey: idempotencyKeyOf(req),
      },
    );
    if (!result.ok) {
      throw new HttpException(
        { code: result.code.toUpperCase(), message: result.message },
        commandResultHttpStatus(result),
      );
    }
    // Shape the success body to the OpenAPI `Reward` contract.
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    // P1.5-058 (P1.3 FIX1 mirror): see requireCustomer().
    const row = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("loyalty.rewards")
        .select([
          "id",
          "customer_id",
          "reward_definition_id",
          "status",
          "economic_value_minor",
          "estimated_cost_minor",
          "currency",
          "available_at",
          "redeemed_at",
          "expires_at",
          "created_at",
        ])
        .where("tenant_id", "=", tenant.id)
        .where("id", "=", result.data.rewardId)
        .executeTakeFirstOrThrow(),
    );
    return {
      id: row.id,
      customerId: row.customer_id,
      rewardDefinitionId: row.reward_definition_id,
      status: row.status,
      economicValueMinor: row.economic_value_minor === null ? null : String(row.economic_value_minor),
      estimatedCostMinor:
        row.estimated_cost_minor === null ? null : String(row.estimated_cost_minor),
      currency: row.currency,
      availableAt: row.available_at?.toISOString() ?? null,
      redeemedAt: row.redeemed_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      orderId: result.data.orderId,
    };
  }

  @Post("gift-passes/redeem")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async redeemGiftPass(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute<{ giftPassId: string }>(
      actorFromRequest(req),
      "giftpass.redeem",
      body,
      {
        correlationId: req.id,
        idempotencyKey: idempotencyKeyOf(req),
      },
    );
    if (!result.ok) {
      throw new HttpException(
        { code: result.code.toUpperCase(), message: result.message },
        commandResultHttpStatus(result),
      );
    }
    // Shape the success body to the OpenAPI `GiftPass` contract.
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    // P1.5-058 (P1.3 FIX1 mirror): see requireCustomer().
    const row = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("loyalty.gift_passes")
        .select([
          "id",
          "issued_to_customer_id",
          "code",
          "status",
          "benefit_json",
          "expires_at",
          "redeemed_by_person_id",
          "redeemed_at",
          "created_at",
        ])
        .where("tenant_id", "=", tenant.id)
        .where("id", "=", result.data.giftPassId)
        .executeTakeFirstOrThrow(),
    );
    return {
      id: row.id,
      code: row.code,
      status: row.status,
      issuedToCustomerId: row.issued_to_customer_id,
      redeemedByPersonId: row.redeemed_by_person_id,
      benefit: (row.benefit_json ?? {}) as Record<string, unknown>,
      expiresAt: row.expires_at.toISOString(),
      redeemedAt: row.redeemed_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
    };
  }
}
