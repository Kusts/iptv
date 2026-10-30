import {
  Controller,
  Get,
  HttpException,
  Inject,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { withTenantTransaction, type Database } from "@iptv/database";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";

export interface CatalogPlanItem {
  id: string;
  planKey: string;
  name: string;
  billingIntervalUnit: string;
  billingIntervalCount: number;
  priceMinor: string;
  currency: string;
}

@Controller("v1/catalog")
export class CatalogController {
  constructor(@Inject("DB") private readonly db: Kysely<Database> | null) {}

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new HttpException({ code: "UNAVAILABLE", message: "database is not configured" }, 503);
    }
    return this.db;
  }

  @Get("plans")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.read")
  async listPlans(@Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    return withTenantTransaction(this.requireDb(), tenant.id, async (trx) => {
      const plans = await trx
        .selectFrom("catalog.plans as pl")
        .leftJoin("catalog.prices as pr", (join) =>
          join
            .onRef("pr.sellable_id", "=", "pl.id")
            .on("pr.sellable_type", "=", "PLAN")
            .on("pr.status", "=", "ACTIVE")
            .onRef("pr.tenant_id", "=", "pl.tenant_id"),
        )
        .select([
          "pl.id",
          "pl.plan_key as planKey",
          "pl.name",
          "pl.billing_interval_unit as billingIntervalUnit",
          "pl.billing_interval_count as billingIntervalCount",
          "pr.amount_minor as priceMinor",
          "pr.currency",
        ])
        .where("pl.tenant_id", "=", tenant.id)
        .where("pl.status", "=", "ACTIVE")
        .orderBy("pl.name", "asc")
        .execute();

      const resultPlans = plans
        .filter((p) => p.priceMinor !== null)
        .map((p) => ({
          id: p.id,
          planKey: p.planKey,
          name: p.name,
          billingIntervalUnit: p.billingIntervalUnit,
          billingIntervalCount: p.billingIntervalCount,
          priceMinor: p.priceMinor!.toString(),
          currency: p.currency ?? "BRL",
        }));

      return {
        plans: resultPlans,
      };
    });
  }
}
