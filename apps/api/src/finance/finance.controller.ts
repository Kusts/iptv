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
import type { Kysely, Transaction } from "kysely";
import { withTenantTransaction, type Database } from "@iptv/database";
import { commandResultHttpStatus } from "@iptv/domain";
import type { CommandActor, CommandResult } from "@iptv/domain";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import { CommandBus, commandActorFromRequestParts } from "../commands/command-bus.js";
import {
  bpsToPercentString,
  cohortMonthKey,
  computeContribution,
  normalizeMrrMinor,
  toMinorStrict,
  COGS_COST_TYPES,
  VARIABLE_COST_TYPES,
} from "./finance-math.js";
import {
  COST_ACQUISITION_TOUCH,
  COST_REFERRAL_REWARD,
} from "./finance-ingest.js";

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
 * Wave 10 Finance/Unit-Economics surface.
 *
 * Permission reuse (no new migration): reads use `billing.read` — the
 * existing financial-read surface (owner/admin; operators intentionally
 * excluded from managerial finance analytics). The recompute write goes
 * through `finance.recompute_allocations` (`billing.charge.write`).
 *
 * F14 degradation: analytics NEVER sits on the sale/payment path — these
 * are pure read-models over settled facts plus derived allocations. A
 * read-model failure returns a `DEGRADED` payload (zeros + quality flag),
 * never a 500 that could cascade; sale/payment runtime holds no
 * dependency on this module.
 *
 * Money is exact minor-unit strings; ratios are integer basis points.
 * Slices without a money authority (AI cost, payment fees) report
 * `BASELINE_UNAVAILABLE` instead of estimates.
 *
 * Reads run inside `withTenantTransaction` (actor tenant): the tables below
 * are RLS-enrolled (migrations 052/055/057/058, fail-closed when
 * `app.tenant_id` is unset), so pool-level selects under `iptv_app` would
 * return empty silently after cutover. The explicit `tenant_id =`
 * predicates stay as defense-in-depth alongside the RLS policy.
 */
@Controller("v1")
export class FinanceController {
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

  @Post("finance/recompute")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.charge.write")
  async recompute(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "finance.recompute_allocations", body ?? {}, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  private async requireCustomer(tenantId: string, customerId: string, db: Kysely<Database> | Transaction<Database>) {
    const customer = await db
      .selectFrom("crm.customers")
      .select(["id", "person_id", "customer_since"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", customerId)
      .executeTakeFirst();
    if (customer === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "customer not found" }, 404);
    }
    return customer;
  }

  private async allocationSums(
    tenantId: string,
    costTypes: readonly string[],
    targetType: string,
    targetIds: string[],
    db: Kysely<Database> | Transaction<Database>,
  ): Promise<bigint> {
    if (targetIds.length === 0) {
      return 0n;
    }
    const rows = await db
      .selectFrom("finance.cost_allocations")
      .select(["amount_minor"])
      .where("tenant_id", "=", tenantId)
      .where("cost_type", "in", [...costTypes])
      .where("allocation_target_type", "=", targetType)
      .where("allocation_target_id", "in", targetIds)
      .execute();
    return rows.reduce((acc, r) => acc + toMinorStrict(r.amount_minor), 0n);
  }

  @Get("finance/contribution")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.read")
  async contribution(@Query("customerId") customerId: string | undefined, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    if (typeof customerId !== "string" || customerId.length === 0) {
      throw new HttpException({ code: "VALIDATION_FAILED", message: "customerId query param is required" }, 400);
    }
    try {
      return await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
        this.contributionInner(tenant.id, customerId, trx),
      );
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      return degradedContribution(customerId);
    }
  }

  private async contributionInner(tenantId: string, customerId: string, db: Kysely<Database> | Transaction<Database>) {
    const customer = await this.requireCustomer(tenantId, customerId, db);

    // Revenue link is the order's person (orders predate the customer row:
    // `customer.created.v1` fires at settlement, and nothing backfills
    // `orders.customer_id`). Person↔customer is 1:1 per tenant.
    const orders = await db
      .selectFrom("commerce.orders")
      .select(["id", "settled_amount_minor"])
      .where("tenant_id", "=", tenantId)
      .where("person_id", "=", customer.person_id)
      .where("status", "=", "SETTLED")
      .execute();
    const revenueMinor = orders.reduce((acc, o) => acc + toMinorStrict(o.settled_amount_minor), 0n);
    const orderIds = orders.map((o) => o.id);

    const subscriptions = await db
      .selectFrom("subscription.subscriptions")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("customer_id", "=", customerId)
      .execute();
    const subscriptionIds = subscriptions.map((s) => s.id);
    let cycleIds: string[] = [];
    let cycles: Array<{ id: string; status: string; baseRevenueMinor: string; baseProviderCostMinor: string | null }> = [];
    if (subscriptionIds.length > 0) {
      const cycleRows = await db
        .selectFrom("subscription.subscription_cycles")
        .select(["id", "subscription_id", "status", "base_revenue_minor", "base_provider_cost_minor"])
        .where("tenant_id", "=", tenantId)
        .where("subscription_id", "in", subscriptionIds)
        .orderBy("cycle_no", "asc")
        .execute();
      cycleIds = cycleRows.map((c) => c.id);
      cycles = cycleRows.map((c) => ({
        id: c.id,
        status: c.status,
        baseRevenueMinor: String(c.base_revenue_minor),
        baseProviderCostMinor: c.base_provider_cost_minor === null ? null : String(c.base_provider_cost_minor),
      }));
    }

    const cogsMinor =
      (await this.allocationSums(tenantId, COGS_COST_TYPES, "ORDER", orderIds, db)) +
      (await this.allocationSums(tenantId, COGS_COST_TYPES, "SUBSCRIPTION_CYCLE", cycleIds, db));

    // MESSAGING_COST allocates per successful OUTBOUND delivery (the real
    // send fact — no runtime ever transitions scheduled_contacts to SENT),
    // so contribution sums MESSAGE_DELIVERY allocations for this person's
    // outbound messages. Legacy SCHEDULED_CONTACT rows (if any) still count.
    const deliveryRows = await db
      .selectFrom("communication.message_deliveries as d")
      .innerJoin("communication.messages as m", (join) =>
        join
          .onRef("m.tenant_id", "=", "d.tenant_id")
          .onRef("m.id", "=", "d.message_id"),
      )
      .select(["d.id as delivery_id"])
      .where("d.tenant_id", "=", tenantId)
      .where("m.person_id", "=", customer.person_id)
      .where("m.direction", "=", "OUTBOUND")
      .where("d.status", "in", ["SENT", "DELIVERED", "READ"])
      .execute();
    const contacts = await db
      .selectFrom("communication.scheduled_contacts")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("person_id", "=", customer.person_id)
      .where("status", "=", "SENT")
      .execute();
    const touches = await db
      .selectFrom("growth.attribution_touches")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("person_id", "=", customer.person_id)
      .execute();
    const rewards = await db
      .selectFrom("loyalty.rewards")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("customer_id", "=", customerId)
      .execute();
    const variableMinor =
      (await this.allocationSums(tenantId, VARIABLE_COST_TYPES, "MESSAGE_DELIVERY", deliveryRows.map((d) => d.delivery_id), db)) +
      (await this.allocationSums(tenantId, VARIABLE_COST_TYPES, "SCHEDULED_CONTACT", contacts.map((c) => c.id), db)) +
      (await this.allocationSums(tenantId, VARIABLE_COST_TYPES, "ATTRIBUTION_TOUCH", touches.map((t) => t.id), db)) +
      (await this.allocationSums(tenantId, VARIABLE_COST_TYPES, "REWARD", rewards.map((r) => r.id), db));

    let refundsMinor = 0n;
    let chargebacksMinor = 0n;
    if (orderIds.length > 0) {
      const refundRows = await db
        .selectFrom("billing.refunds")
        .innerJoin("billing.payments", (join) =>
          join
            .onRef("billing.payments.tenant_id", "=", "billing.refunds.tenant_id")
            .onRef("billing.payments.id", "=", "billing.refunds.payment_id"),
        )
        .select(["billing.refunds.amount_minor"])
        .where("billing.refunds.tenant_id", "=", tenantId)
        .where("billing.payments.order_id", "in", orderIds)
        .where("billing.refunds.status", "=", "SUCCEEDED")
        .execute();
      refundsMinor = refundRows.reduce((acc, r) => acc + toMinorStrict(r.amount_minor), 0n);

      const chargebackRows = await db
        .selectFrom("billing.payments")
        .select(["amount_minor"])
        .where("tenant_id", "=", tenantId)
        .where("order_id", "in", orderIds)
        .where("status", "=", "CHARGEBACK")
        .execute();
      chargebacksMinor = chargebackRows.reduce((acc, r) => acc + toMinorStrict(r.amount_minor), 0n);
    }

    const { contributionMinor, marginBps } = computeContribution({
      revenueMinor,
      cogsMinor,
      variableMinor,
      refundsMinor,
      chargebacksMinor,
    });

    const cycleViews = [];
    for (const cycle of cycles) {
      const cost = await this.allocationSums(tenantId, COGS_COST_TYPES, "SUBSCRIPTION_CYCLE", [cycle.id], db);
      cycleViews.push({
        cycleId: cycle.id,
        status: cycle.status,
        revenueMinor: cycle.baseRevenueMinor,
        costMinor: cost.toString(),
      });
    }

    return {
      customerId,
      revenueMinor: revenueMinor.toString(),
      cogsMinor: cogsMinor.toString(),
      variableMinor: variableMinor.toString(),
      refundsMinor: refundsMinor.toString(),
      chargebacksMinor: chargebacksMinor.toString(),
      contributionMinor: contributionMinor.toString(),
      contributionMarginBps: marginBps === null ? null : marginBps.toString(),
      contributionMarginPercent: marginBps === null ? null : bpsToPercentString(marginBps),
      cycles: cycleViews,
      aiCostStatus: "BASELINE_UNAVAILABLE" as const,
      paymentFeeStatus: "BASELINE_UNAVAILABLE" as const,
      dataQuality: orders.length === 0 ? ("EMPTY" as const) : cogsMinor === 0n && revenueMinor > 0n ? ("PARTIAL" as const) : ("COMPLETE" as const),
    };
  }

  @Get("metrics/cac")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.read")
  async cac(@Query("customerId") customerId: string | undefined, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    if (typeof customerId !== "string" || customerId.length === 0) {
      throw new HttpException({ code: "VALIDATION_FAILED", message: "customerId query param is required" }, 400);
    }
    try {
      return await withTenantTransaction(this.requireDb(), tenant.id, async (trx) => {
      const db = trx;
      const customer = await this.requireCustomer(tenant.id, customerId, db);

      const touches = await db
        .selectFrom("growth.attribution_touches")
        .select(["id"])
        .where("tenant_id", "=", tenant.id)
        .where("person_id", "=", customer.person_id)
        .where("touch_type", "!=", "REFERRAL_ASSIST")
        .execute();
      const paidAcquisitionMinor = await this.allocationSums(
        tenant.id,
        [COST_ACQUISITION_TOUCH],
        "ATTRIBUTION_TOUCH",
        touches.map((t) => t.id),
        db,
      );

      const rewards = await db
        .selectFrom("loyalty.rewards")
        .innerJoin("referral.referral_reward_links", (join) =>
          join
            .onRef("referral.referral_reward_links.tenant_id", "=", "loyalty.rewards.tenant_id")
            .onRef("referral.referral_reward_links.reward_id", "=", "loyalty.rewards.id"),
        )
        .select(["loyalty.rewards.id as reward_id"])
        .where("loyalty.rewards.tenant_id", "=", tenant.id)
        .where("loyalty.rewards.customer_id", "=", customerId)
        .execute();
      const referralCostMinor = await this.allocationSums(
        tenant.id,
        [COST_REFERRAL_REWARD],
        "REWARD",
        rewards.map((r) => r.reward_id),
        db,
      );

      // ACQ-04: referral reward belongs to Referral CAC, never Paid CAC.
      const blendedMinor = paidAcquisitionMinor + referralCostMinor;
      if (touches.length === 0 && rewards.length === 0) {
        return {
          customerId,
          status: "BASELINE_UNAVAILABLE" as const,
          reason: "no attributed acquisition touches or referral rewards for this customer",
          paidAcquisitionMinor: "0",
          referralCostMinor: "0",
          blendedAcquisitionMinor: "0",
          newPayingCustomers: 0,
        };
      }
      return {
        customerId,
        status: "AVAILABLE" as const,
        paidAcquisitionMinor: paidAcquisitionMinor.toString(),
        referralCostMinor: referralCostMinor.toString(),
        blendedAcquisitionMinor: blendedMinor.toString(),
        newPayingCustomers: 1,
      };
      });
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      return {
        customerId,
        status: "DEGRADED" as const,
        reason: "acquisition read-model failed; sale/payment runtime unaffected",
        paidAcquisitionMinor: "0",
        referralCostMinor: "0",
        blendedAcquisitionMinor: "0",
        newPayingCustomers: 0,
      };
    }
  }

  @Get("metrics/cohorts")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.read")
  async cohorts(@Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    try {
      return await withTenantTransaction(this.requireDb(), tenant.id, async (trx) => {
      const db = trx;
      const customers = await db
        .selectFrom("crm.customers")
        .select(["id", "person_id", "customer_since"])
        .where("tenant_id", "=", tenant.id)
        .orderBy("customer_since", "asc")
        .limit(5000)
        .execute();
      const cohorts = new Map<string, { members: string[]; persons: string[] }>();
      for (const customer of customers) {
        const key = cohortMonthKey(customer.customer_since);
        const slot = cohorts.get(key) ?? { members: [], persons: [] };
        slot.members.push(customer.id);
        slot.persons.push(customer.person_id);
        cohorts.set(key, slot);
      }
      const items = [];
      for (const [cohortMonth, slot] of [...cohorts.entries()].sort()) {
        let revenueMinor = 0n;
        let activeSubscriptions = 0;
        if (slot.members.length > 0) {
          // Same person-link rule as contribution: settled orders carry the
          // person, not the backfilled customer.
          const settled = await db
            .selectFrom("commerce.orders")
            .select(["settled_amount_minor"])
            .where("tenant_id", "=", tenant.id)
            .where("person_id", "in", slot.persons)
            .where("status", "=", "SETTLED")
            .execute();
          revenueMinor = settled.reduce((acc, o) => acc + toMinorStrict(o.settled_amount_minor), 0n);
          const active = await db
            .selectFrom("subscription.subscriptions")
            .select((eb) => eb.fn.countAll().as("n"))
            .where("tenant_id", "=", tenant.id)
            .where("customer_id", "in", slot.members)
            .where("status", "=", "ACTIVE")
            .executeTakeFirstOrThrow();
          activeSubscriptions = Number(active.n);
        }
        items.push({
          cohortMonth,
          members: slot.members.length,
          revenueAccumulatedMinor: revenueMinor.toString(),
          activeSubscriptions,
          dataQuality: slot.members.length === 0 ? ("EMPTY" as const) : revenueMinor === 0n ? ("PARTIAL" as const) : ("COMPLETE" as const),
        });
      }
      return { cohorts: items, dataQuality: items.length === 0 ? ("EMPTY" as const) : ("OK" as const) };
      });
    } catch {
      return { cohorts: [], dataQuality: "DEGRADED" as const };
    }
  }

  @Get("metrics/overview")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.read")
  async overview(@Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    try {
      return await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
        this.overviewInner(tenant, trx),
      );
    } catch {
      return degradedOverview();
    }
  }

  private async overviewInner(tenant: NonNullable<FastifyRequest["tenant"]>, db: Kysely<Database> | Transaction<Database>) {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const activeSubs = await db
      .selectFrom("subscription.subscriptions")
      .select(["id", "plan_id"])
      .where("tenant_id", "=", tenant.id)
      .where("status", "=", "ACTIVE")
      .limit(5000)
      .execute();
    let mrrMinor = 0n;
    let mrrUnnormalized = 0;
    for (const sub of activeSubs) {
      const cycle = await db
        .selectFrom("subscription.subscription_cycles")
        .select(["base_revenue_minor"])
        .where("tenant_id", "=", tenant.id)
        .where("subscription_id", "=", sub.id)
        .orderBy("cycle_no", "desc")
        .limit(1)
        .executeTakeFirst();
      if (cycle === undefined) {
        continue;
      }
      const plan = await db
        .selectFrom("catalog.plans")
        .select(["billing_interval_unit", "billing_interval_count"])
        .where("tenant_id", "=", tenant.id)
        .where("id", "=", sub.plan_id)
        .executeTakeFirst();
      if (plan === undefined) {
        mrrUnnormalized += 1;
        continue;
      }
      const normalized = normalizeMrrMinor(
        toMinorStrict(cycle.base_revenue_minor),
        plan.billing_interval_unit,
        plan.billing_interval_count,
      );
      if (normalized === null) {
        mrrUnnormalized += 1;
        continue;
      }
      mrrMinor += normalized;
    }

    const monthOrders = await db
      .selectFrom("commerce.orders")
      .select(["settled_amount_minor"])
      .where("tenant_id", "=", tenant.id)
      .where("status", "=", "SETTLED")
      .where("settled_at", ">=", monthStart)
      .execute();
    const monthRevenueMinor = monthOrders.reduce((acc, o) => acc + toMinorStrict(o.settled_amount_minor), 0n);

    const monthCosts = await db
      .selectFrom("finance.cost_allocations")
      .select(["amount_minor"])
      .where("tenant_id", "=", tenant.id)
      .where("occurred_at", ">=", monthStart)
      .execute();
    const monthCostMinor = monthCosts.reduce((acc, r) => acc + toMinorStrict(r.amount_minor), 0n);

    const monthRefunds = await db
      .selectFrom("billing.refunds")
      .select(["billing.refunds.amount_minor"])
      .where("billing.refunds.tenant_id", "=", tenant.id)
      .where("billing.refunds.status", "=", "SUCCEEDED")
      .where("billing.refunds.completed_at", ">=", monthStart)
      .execute();
    const monthRefundsMinor = monthRefunds.reduce((acc, r) => acc + toMinorStrict(r.amount_minor), 0n);

    const { contributionMinor, marginBps } = computeContribution({
      revenueMinor: monthRevenueMinor,
      cogsMinor: monthCostMinor,
      variableMinor: 0n,
      refundsMinor: monthRefundsMinor,
      chargebacksMinor: 0n,
    });

    return {
      mrrMinor: mrrMinor.toString(),
      mrrActiveSubscriptions: activeSubs.length,
      mrrCoverage: mrrUnnormalized === 0 ? ("COMPLETE" as const) : ("PARTIAL" as const),
      monthRevenueMinor: monthRevenueMinor.toString(),
      monthCostMinor: monthCostMinor.toString(),
      monthRefundsMinor: monthRefundsMinor.toString(),
      monthContributionMinor: contributionMinor.toString(),
      contributionMarginBps: marginBps === null ? null : marginBps.toString(),
      contributionMarginPercent: marginBps === null ? null : bpsToPercentString(marginBps),
      aiCostStatus: "BASELINE_UNAVAILABLE" as const,
      paymentFeeStatus: "BASELINE_UNAVAILABLE" as const,
      dataQuality: "OK" as const,
    };
  }
}

function degradedContribution(customerId: string) {
  return {
    customerId,
    revenueMinor: "0",
    cogsMinor: "0",
    variableMinor: "0",
    refundsMinor: "0",
    chargebacksMinor: "0",
    contributionMinor: "0",
    contributionMarginBps: null,
    contributionMarginPercent: null,
    cycles: [],
    aiCostStatus: "BASELINE_UNAVAILABLE" as const,
    paymentFeeStatus: "BASELINE_UNAVAILABLE" as const,
    dataQuality: "DEGRADED" as const,
  };
}

function degradedOverview() {
  return {
    mrrMinor: "0",
    mrrActiveSubscriptions: 0,
    mrrCoverage: "PARTIAL" as const,
    monthRevenueMinor: "0",
    monthCostMinor: "0",
    monthRefundsMinor: "0",
    monthContributionMinor: "0",
    contributionMarginBps: null,
    contributionMarginPercent: null,
    aiCostStatus: "BASELINE_UNAVAILABLE" as const,
    paymentFeeStatus: "BASELINE_UNAVAILABLE" as const,
    dataQuality: "DEGRADED" as const,
  };
}

// Re-exported so unit tests exercise the degraded-shape contract without HTTP.
export const __test__ = { degradedContribution, degradedOverview };
