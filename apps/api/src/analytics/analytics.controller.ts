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
import type { Kysely, Transaction } from "kysely";
import { withTenantTransaction, type Database } from "@iptv/database";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import { METRIC_DEFINITIONS, METRIC_KEYS } from "./analytics-catalog.js";
import { bucketDayUTC, stalenessHours } from "./analytics-math.js";
import { recomputeAnalytics } from "./analytics-projections.js";
import {
  bpsToPercentString,
  computeContribution,
  normalizeMrrMinor,
  toMinorStrict,
} from "../finance/finance-math.js";
import { normalizeCenterItem, resolveSlaPolicy, type CenterItemInput } from "../human-review/center-policy.js";
import { HITL_SLA_POLICY_FAMILY } from "../support/support-policy.js";
import { PolicyResolver } from "../policy/policy-resolver.js";

const OPEN_TICKET_STATUSES = [
  "NEW",
  "TRIAGING",
  "IN_PROGRESS",
  "WAITING_CUSTOMER",
  "WAITING_INTERNAL",
  "WAITING_PROVIDER",
];

const OPEN_REVIEW_STATUSES = ["REQUESTED", "QUEUED", "ACKNOWLEDGED", "IN_REVIEW"];

function idempotencyKeyOf(req: FastifyRequest): string | undefined {
  const header = req.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function parseWindow(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new HttpException({ code: "VALIDATION_FAILED", message: `invalid date: ${value}` }, 400);
  }
  return at;
}

/**
 * Wave 14 Analytics + Control Center surface (read-only).
 *
 * Canonical domain §87-89: analytics is NEVER a source of truth — every
 * number below is computed from settled domain facts (or the replaceable
 * `analytics.*` read-model) and degrades instead of failing the operation
 * path (F14). No write here touches a domain table.
 *
 * Reads run inside `withTenantTransaction` (actor tenant): the fact tables
 * below are RLS-enrolled (052/055/057 plus growth/communication in 058/042,
 * fail-closed when `app.tenant_id` is unset), so pool-level selects under
 * `iptv_app` would return empty silently after cutover. The explicit
 * `tenant_id =` predicates stay as defense-in-depth alongside the RLS
 * policy. Each Control Center section opens its OWN tenant transaction so a
 * failing section still degrades in isolation (F14) instead of poisoning
 * the shared summary transaction.
 *
 * Permission reuse (no new migration): metric reads use `crm.person.read`
 * (all roles — dashboards are operator-facing); the Control Center summary
 * uses `support.ticket.read` (all roles — operation-facing); the recompute
 * write reuses `billing.charge.write` (same key as the finance recompute).
 */
@Controller("v1")
export class AnalyticsController {
  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject(PolicyResolver) private readonly policies: PolicyResolver,
  ) {}

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new HttpException({ code: "UNAVAILABLE", message: "database is not configured" }, 503);
    }
    return this.db;
  }

  @Post("analytics/recompute")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.charge.write")
  async recompute(@Body() body: { from?: unknown; to?: unknown; failFamily?: unknown; failFamilySql?: unknown }, @Req() req: FastifyRequest) {
    void idempotencyKeyOf(req);
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const from = body.from === undefined ? undefined : parseWindow(body.from);
    const to = body.to === undefined ? undefined : parseWindow(body.to);
    const failFamily = typeof body.failFamily === "string" && body.failFamily.length > 0 ? body.failFamily : undefined;
    const failFamilySql =
      typeof body.failFamilySql === "string" && body.failFamilySql.length > 0 ? body.failFamilySql : undefined;
    try {
      // P1.5-058 (P1.3 FIX1 mirror): fact reads are RLS-enrolled (058/042),
      // so the recompute runs inside the request tenant's context. The
      // `analytics.*` read-model writes ride along (no RLS there by design).
      // P15-FIX1: families are isolated by SAVEPOINT inside this shared
      // transaction (see recomputeAnalytics) — a SQL failure in one family
      // degrades it (F14) instead of aborting the whole recompute.
      return await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
        recomputeAnalytics(trx, tenant.id, { from, to, failFamily, failFamilySql }),
      );
    } catch (err) {
      throw new HttpException(
        { code: "VALIDATION_FAILED", message: err instanceof Error ? err.message : "recompute failed" },
        400,
      );
    }
  }

  @Get("metrics")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async catalog(@Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    // P1.5-058 (P1.3 FIX1 mirror): tenant-scoped read inside the request
    // tenant's context — direct reads fail-closed under `iptv_app`.
    const rows = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("analytics.metric_definitions")
        .select(["metric_key", "family", "formula_ref", "formula_version", "unit", "granularity"])
        .where("tenant_id", "=", tenant.id)
        .orderBy("metric_key", "asc")
        .execute(),
    );
    const items =
      rows.length > 0
        ? rows.map((r) => ({
          key: r.metric_key,
          family: r.family,
          formulaRef: r.formula_ref,
          formulaVersion: r.formula_version,
          unit: r.unit,
          granularity: r.granularity,
        }))
        : METRIC_DEFINITIONS.map((d) => ({
          key: d.key,
          family: d.family,
          formulaRef: d.formulaRef,
          formulaVersion: d.formulaVersion,
          unit: d.unit,
          granularity: d.granularity,
        }));
    return { items, seeded: rows.length > 0 };
  }

  @Get("metrics/:key")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async series(
    @Param("key") key: string,
    @Query("from") fromRaw: string | undefined,
    @Query("to") toRaw: string | undefined,
    @Req() req: FastifyRequest,
  ) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    if (!METRIC_KEYS.has(key)) {
      throw new HttpException({ code: "NOT_FOUND", message: `unknown metric: ${key}` }, 404);
    }
    const now = new Date();
    const from = fromRaw === undefined ? new Date(bucketDayUTC(now).getTime() - 29 * 86_400_000) : parseWindow(fromRaw);
    const to = toRaw === undefined ? new Date(bucketDayUTC(now).getTime() + 86_400_000) : parseWindow(toRaw);
    // P1.5-058 (P1.3 FIX1 mirror): see catalog().
    const rows = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("analytics.metric_snapshots")
        .select(["bucket_start", "value_json", "value_minor", "computed_at", "data_quality"])
        .where("tenant_id", "=", tenant.id)
        .where("metric_key", "=", key)
        .where("bucket_start", ">=", from as Date)
        .where("bucket_start", "<", to as Date)
        .orderBy("bucket_start", "asc")
        .execute(),
    );
    return {
      key,
      from: (from as Date).toISOString(),
      to: (to as Date).toISOString(),
      points: rows.map((r) => ({
        bucket: r.bucket_start.toISOString(),
        value: (r.value_json ?? {}) as Record<string, unknown>,
        valueMinor: r.value_minor === null ? null : String(r.value_minor),
        computedAt: r.computed_at.toISOString(),
        dataQuality: r.data_quality,
      })),
    };
  }

  @Get("analytics/overview")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async overview(@Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    // P1.5-058 (P1.3 FIX1 mirror): see catalog() — the per-metric latest
    // reads share one tenant context.
    return withTenantTransaction(this.requireDb(), tenant.id, async (trx) => {
      const metrics: Record<string, {
        bucket: string;
        value: Record<string, unknown>;
        valueMinor: string | null;
        computedAt: string;
        dataQuality: string;
      } | null> = {};
      let latest: Date | null = null;
      let degraded = 0;
      for (const def of METRIC_DEFINITIONS) {
        const row = await trx
          .selectFrom("analytics.metric_snapshots")
          .select(["bucket_start", "value_json", "value_minor", "computed_at", "data_quality"])
          .where("tenant_id", "=", tenant.id)
          .where("metric_key", "=", def.key)
          .orderBy("bucket_start", "desc")
          .limit(1)
          .executeTakeFirst();
        if (row === undefined) {
          metrics[def.key] = null;
          continue;
        }
        metrics[def.key] = {
          bucket: row.bucket_start.toISOString(),
          value: (row.value_json ?? {}) as Record<string, unknown>,
          valueMinor: row.value_minor === null ? null : String(row.value_minor),
          computedAt: row.computed_at.toISOString(),
          dataQuality: row.data_quality,
        };
        if (latest === null || row.computed_at.getTime() > latest.getTime()) {
          latest = row.computed_at;
        }
        if (row.data_quality === "DEGRADED") {
          degraded += 1;
        }
      }
      const tracked = Object.values(metrics).filter((m) => m !== null).length;
      return {
        metrics,
        trackedMetrics: tracked,
        totalMetrics: METRIC_DEFINITIONS.length,
        latestComputedAt: latest?.toISOString() ?? null,
        dataQuality: tracked === 0 ? ("EMPTY" as const) : degraded > 0 ? ("DEGRADED" as const) : ("OK" as const),
        degradedMetrics: degraded,
      };
    });
  }

  /**
   * Control Center summary (baseline 12-product-ux-ai-experience §19-22):
   * current operation, business summary, alerts/opportunities,
   * integration health, scheduled work, AI activity. Every section is
   * isolated — a failing section degrades (listed in `degradedSections`)
   * instead of failing the whole summary (F14).
   */
  @Get("control-center/summary")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.read")
  async controlCenterSummary(@Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const degradedSections: string[] = [];
    // P1.5-058 (P1.3 FIX1 mirror): each section reads RLS-enrolled fact
    // tables, so each opens its own tenant transaction — a failing section
    // degrades in isolation (F14) instead of aborting a shared transaction.
    const db = this.requireDb();
    const operation = await withTenantTransaction(db, tenant.id, (trx) =>
      this.operationSection(trx, tenant.id, degradedSections),
    );
    const business = await withTenantTransaction(db, tenant.id, (trx) =>
      this.businessSection(trx, tenant.id, degradedSections),
    );
    const aiActivity = await withTenantTransaction(db, tenant.id, (trx) =>
      this.aiActivitySection(trx, tenant.id, degradedSections),
    );
    const scheduledWork = await withTenantTransaction(db, tenant.id, (trx) =>
      this.scheduledWorkSection(trx, tenant.id, degradedSections),
    );
    const dataQuality = await withTenantTransaction(db, tenant.id, (trx) =>
      this.dataQualitySection(trx, tenant.id, degradedSections),
    );
    return {
      operation,
      business,
      aiActivity,
      scheduledWork,
      dataQuality,
      degradedSections,
      dataQualityOverall:
        dataQuality.status === "EMPTY"
          ? ("EMPTY" as const)
          : degradedSections.length > 0
            ? ("DEGRADED" as const)
            : ("OK" as const),
    };
  }

  private async operationSection(db: Transaction<Database>, tenantId: string, degradedSections: string[]) {
    try {
      const at = new Date();
      const decision = await this.policies.resolve(HITL_SLA_POLICY_FAMILY, { tenantId });
      const policy = resolveSlaPolicy(decision.configured ? (decision.value as Record<string, unknown>) : null);
      const collected: CenterItemInput[] = [];

      const reviews = await db
        .selectFrom("agent.human_review_requests")
        .select(["id", "review_mode", "reason", "priority", "summary", "created_at", "sla_due_at"])
        .where("tenant_id", "=", tenantId)
        .where("status", "in", OPEN_REVIEW_STATUSES)
        .execute();
      for (const r of reviews) {
        collected.push({
          source: "human_review",
          id: r.id,
          kind: `${r.review_mode}/${r.reason}`,
          summary: r.summary,
          priority: r.priority,
          createdAt: r.created_at,
          slaDueAt: r.sla_due_at,
          deepLink: `/v1/human-reviews/${r.id}`,
        });
      }
      const commExceptions = await db
        .selectFrom("communication.exceptions")
        .select(["id", "created_at"])
        .where("tenant_id", "=", tenantId)
        .where("status", "=", "OPEN")
        .execute();
      for (const r of commExceptions) {
        collected.push({
          source: "comm_exception",
          id: r.id,
          kind: "exception",
          summary: "open communication exception",
          createdAt: r.created_at,
          deepLink: `/v1/communications/exceptions/${r.id}`,
        });
      }
      const billingExceptions = await db
        .selectFrom("billing.exceptions")
        .select(["id", "created_at"])
        .where("tenant_id", "=", tenantId)
        .where("status", "=", "OPEN")
        .execute();
      for (const r of billingExceptions) {
        collected.push({
          source: "billing_exception",
          id: r.id,
          kind: "exception",
          summary: "open billing exception",
          createdAt: r.created_at,
          deepLink: `/v1/billing/exceptions/${r.id}`,
        });
      }
      const recovery = await db
        .selectFrom("renewal.recovery_tasks")
        .select(["id", "created_at"])
        .where("tenant_id", "=", tenantId)
        .where("status", "=", "OPEN")
        .execute();
      for (const r of recovery) {
        collected.push({
          source: "recovery_task",
          id: r.id,
          kind: "recovery",
          summary: "open recovery task",
          createdAt: r.created_at,
          deepLink: `/v1/recovery-tasks/${r.id}`,
        });
      }
      const bands = collected.map((item) => normalizeCenterItem(policy, item, at).sla);
      const rank = (band: string): number => (band === "BREACH" ? 2 : band === "WARN" ? 1 : 0);
      const worstSla = bands.reduce((acc, band) => (rank(band) > rank(acc) ? band : acc), "OK");
      const bySource: Record<string, number> = {
        human_review: 0,
        comm_exception: 0,
        billing_exception: 0,
        recovery_task: 0,
      };
      for (const item of collected) {
        bySource[item.source] = (bySource[item.source] as number) + 1;
      }
      const openTickets = await db
        .selectFrom("support.support_tickets")
        .select((eb) => eb.fn.countAll().as("n"))
        .where("tenant_id", "=", tenantId)
        .where("status", "in", OPEN_TICKET_STATUSES)
        .executeTakeFirstOrThrow();
      return {
        status: "OK" as const,
        openItems: collected.length,
        bySource,
        openTickets: Number(openTickets.n),
        worstSla,
      };
    } catch {
      degradedSections.push("operation");
      return { status: "DEGRADED" as const, openItems: 0, bySource: {}, openTickets: 0, worstSla: "UNKNOWN" as const };
    }
  }

  private async businessSection(db: Transaction<Database>, tenantId: string, degradedSections: string[]) {
    try {
      // FIN-01/FIN-04 via finance-math (same formulas as the finance
      // overview — reused, not duplicated).
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const activeSubs = await db
        .selectFrom("subscription.subscriptions")
        .select(["id", "plan_id"])
        .where("tenant_id", "=", tenantId)
        .where("status", "=", "ACTIVE")
        .limit(5000)
        .execute();
      let mrrMinor = 0n;
      for (const sub of activeSubs) {
        const cycle = await db
          .selectFrom("subscription.subscription_cycles")
          .select(["base_revenue_minor"])
          .where("tenant_id", "=", tenantId)
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
          .where("tenant_id", "=", tenantId)
          .where("id", "=", sub.plan_id)
          .executeTakeFirst();
        if (plan === undefined) {
          continue;
        }
        const normalized = normalizeMrrMinor(
          toMinorStrict(cycle.base_revenue_minor),
          plan.billing_interval_unit,
          plan.billing_interval_count,
        );
        if (normalized !== null) {
          mrrMinor += normalized;
        }
      }
      const monthOrders = await db
        .selectFrom("commerce.orders")
        .select(["settled_amount_minor"])
        .where("tenant_id", "=", tenantId)
        .where("status", "=", "SETTLED")
        .where("settled_at", ">=", monthStart)
        .execute();
      const monthRevenueMinor = monthOrders.reduce((acc, o) => acc + toMinorStrict(o.settled_amount_minor), 0n);
      const monthCosts = await db
        .selectFrom("finance.cost_allocations")
        .select(["amount_minor"])
        .where("tenant_id", "=", tenantId)
        .where("occurred_at", ">=", monthStart)
        .execute();
      const monthCostMinor = monthCosts.reduce((acc, r) => acc + toMinorStrict(r.amount_minor), 0n);
      const { contributionMinor, marginBps } = computeContribution({
        revenueMinor: monthRevenueMinor,
        cogsMinor: monthCostMinor,
        variableMinor: 0n,
        refundsMinor: 0n,
        chargebacksMinor: 0n,
      });
      return {
        status: "OK" as const,
        mrrMinor: mrrMinor.toString(),
        activeSubscriptions: activeSubs.length,
        monthRevenueMinor: monthRevenueMinor.toString(),
        monthCostMinor: monthCostMinor.toString(),
        monthContributionMinor: contributionMinor.toString(),
        contributionMarginBps: marginBps === null ? null : marginBps.toString(),
        contributionMarginPercent: marginBps === null ? null : bpsToPercentString(marginBps),
      };
    } catch {
      degradedSections.push("business");
      return {
        status: "DEGRADED" as const,
        mrrMinor: "0",
        activeSubscriptions: 0,
        monthRevenueMinor: "0",
        monthCostMinor: "0",
        monthContributionMinor: "0",
        contributionMarginBps: null,
        contributionMarginPercent: null,
      };
    }
  }

  private async aiActivitySection(db: Transaction<Database>, tenantId: string, degradedSections: string[]) {
    try {
      const since = new Date(Date.now() - 7 * 86_400_000);
      const runs = await db
        .selectFrom("agent.agent_runs")
        .select(["status"])
        .where("tenant_id", "=", tenantId)
        .where("created_at", ">=", since)
        .execute();
      const byStatus: Record<string, number> = {};
      for (const run of runs) {
        byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
      }
      return { status: "OK" as const, runs7d: runs.length, byStatus };
    } catch {
      degradedSections.push("aiActivity");
      return { status: "DEGRADED" as const, runs7d: 0, byStatus: {} };
    }
  }

  private async scheduledWorkSection(db: Transaction<Database>, tenantId: string, degradedSections: string[]) {
    try {
      const intents = await db
        .selectFrom("communication.message_intents")
        .select(["id", "scheduled_for"])
        .where("tenant_id", "=", tenantId)
        .where("status", "=", "SCHEDULED")
        .orderBy("scheduled_for", "asc")
        .limit(500)
        .execute();
      const contacts = await db
        .selectFrom("communication.scheduled_contacts")
        .select(["status"])
        .where("tenant_id", "=", tenantId)
        .execute();
      const contactsByStatus: Record<string, number> = {};
      for (const contact of contacts) {
        contactsByStatus[contact.status] = (contactsByStatus[contact.status] ?? 0) + 1;
      }
      return {
        status: "OK" as const,
        scheduledIntents: intents.length,
        nextScheduledFor: intents.length > 0 ? (intents[0] as { scheduled_for: Date }).scheduled_for.toISOString() : null,
        contactsByStatus,
      };
    } catch {
      degradedSections.push("scheduledWork");
      return { status: "DEGRADED" as const, scheduledIntents: 0, nextScheduledFor: null, contactsByStatus: {} };
    }
  }

  private async dataQualitySection(db: Transaction<Database>, tenantId: string, degradedSections: string[]) {
    try {
      // dashboards.md §14 surface: metric freshness, unknown acquisition,
      // reconciliation gaps — never silent when telemetry is broken.
      const now = new Date();
      const snapshots = await db
        .selectFrom("analytics.metric_snapshots")
        .select(["metric_key", "computed_at", "data_quality"])
        .where("tenant_id", "=", tenantId)
        .execute();
      if (snapshots.length === 0) {
        return {
          status: "EMPTY" as const,
          snapshotCount: 0,
          maxStalenessHours: null,
          degradedMetrics: [] as string[],
          openReconciliationFindings: 0,
          unattributedConversionRateBps: null,
        };
      }
      const degradedMetrics = [...new Set(
        snapshots.filter((s) => s.data_quality === "DEGRADED").map((s) => s.metric_key),
      )];
      const oldest = snapshots.reduce((acc, s) => Math.min(acc, s.computed_at.getTime()), now.getTime());
      const maxStaleness = stalenessHours(now, new Date(oldest));
      const findings = await db
        .selectFrom("inventory.reconciliation_findings")
        .select((eb) => eb.fn.countAll().as("n"))
        .where("tenant_id", "=", tenantId)
        .where("status", "in", ["OPEN", "INVESTIGATING"])
        .executeTakeFirstOrThrow();
      const conversions = await db
        .selectFrom("growth.conversion_events")
        .select(["campaign_id"])
        .where("tenant_id", "=", tenantId)
        .execute();
      const unattributed = conversions.filter((c) => c.campaign_id === null).length;
      const unattributedRate =
        conversions.length === 0 ? null : ((BigInt(unattributed) * 10_000n) / BigInt(conversions.length)).toString();
      const status = degradedMetrics.length > 0 ? ("DEGRADED" as const) : ("OK" as const);
      if (status === "DEGRADED") {
        degradedSections.push("dataQuality");
      }
      return {
        status,
        snapshotCount: snapshots.length,
        maxStalenessHours: maxStaleness,
        degradedMetrics,
        openReconciliationFindings: Number(findings.n),
        unattributedConversionRateBps: unattributedRate,
      };
    } catch {
      degradedSections.push("dataQuality");
      return {
        status: "DEGRADED" as const,
        snapshotCount: 0,
        maxStalenessHours: null,
        degradedMetrics: [] as string[],
        openReconciliationFindings: 0,
        unattributedConversionRateBps: null,
      };
    }
  }
}
