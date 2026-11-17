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
import type { Database } from "@iptv/database";
import { listActiveSellablePlans } from "./catalog-queries.js";
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
    const plans = await listActiveSellablePlans(this.requireDb(), tenant.id);
    return {
      plans: plans.filter((plan) => plan.price !== null).map((plan) => ({
        id: plan.planId,
        planKey: plan.planKey,
        name: plan.name,
        billingIntervalUnit: plan.billingIntervalUnit,
        billingIntervalCount: plan.billingIntervalCount,
        priceMinor: plan.price!.amountMinor.toString(),
        currency: plan.price!.currency,
      })),
    };
  }
}
