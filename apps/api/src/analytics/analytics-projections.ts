import type { Kysely } from "kysely";
import type { Database } from "@iptv/database";
import { newId } from "@iptv/domain";
import { METRIC_DEFINITIONS, isMetricFamily } from "./analytics-catalog.js";
import { bucketDayUTC, bucketKeyUTC, eachDayUTC, rateBps } from "./analytics-math.js";
import { normalizeMrrMinor, toMinorStrict } from "../finance/finance-math.js";

/**
 * Wave 14 projections: daily `analytics.metric_snapshots` computed from
 * canonical domain facts (canonical domain §87-89 — analytics only READS
 * facts and writes its OWN tables; it never touches ledger/domain rows).
 *
 * - Counter/RATIO metrics bucket facts by day over the recompute window.
 * - Gauge metrics snapshot current state at the recompute instant (bucket =
 *   today UTC).
 * - Idempotent: replay deletes + re-inserts the window's own rows (the
 *   snapshots are a replaceable read-model, deliberately NOT append-only).
 * - F14: every family runs inside its own try/catch — one failing family
 *   is recorded in `degradedFamilies` (plus a DEGRADED marker snapshot for
 *   its primary metric) and never aborts the other families.
 *
 * Finance formulas are REUSED from `../finance/finance-math.js`
 * (`normalizeMrrMinor`, `toMinorStrict`) — never re-derived here.
 */

export interface RecomputeWindow {
  from?: Date;
  to?: Date;
  /**
   * Diagnostic fault-injection (tests + manual drills): when set to a
   * family name, that family throws before reading — exercising the F14
   * degraded path end-to-end. Never affects other families' snapshots.
   */
  failFamily?: string;
}

export interface RecomputeResult {
  snapshotsWritten: number;
  degradedFamilies: string[];
  computedAt: string;
  window: { from: string; to: string };
}

interface Point {
  key: string;
  bucket: Date;
  valueJson: Record<string, unknown>;
  valueMinor: string | null;
}

type Db = Kysely<Database>;

const OPEN_TICKET_STATUSES = [
  "NEW",
  "TRIAGING",
  "IN_PROGRESS",
  "WAITING_CUSTOMER",
  "WAITING_INTERNAL",
  "WAITING_PROVIDER",
];

const TERMINAL_OPERATION_STATUSES = ["SUCCEEDED", "FAILED", "CANCELLED"];

function defaultWindow(window: RecomputeWindow): { from: Date; to: Date } {
  const now = new Date();
  const to = window.to ?? new Date(bucketDayUTC(now).getTime() + 86_400_000);
  const from = window.from ?? new Date(bucketDayUTC(now).getTime() - 29 * 86_400_000);
  return { from, to };
}

function newDayCounts(days: Date[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const day of days) {
    counts.set(bucketKeyUTC(day), 0);
  }
  return counts;
}

function tallyByDay(rows: Array<{ at: Date }>, days: Date[]): Map<string, number> {
  const counts = newDayCounts(days);
  for (const row of rows) {
    const key = bucketKeyUTC(row.at);
    if (counts.has(key)) {
      counts.set(key, (counts.get(key) as number) + 1);
    }
  }
  return counts;
}

function failIfInjected(window: RecomputeWindow, family: string): void {
  if (window.failFamily === family) {
    throw new Error(`injected failure for family ${family}`);
  }
}

async function ensureDefinitions(db: Db, tenantId: string): Promise<void> {
  const now = new Date();
  for (const def of METRIC_DEFINITIONS) {
    await db
      .insertInto("analytics.metric_definitions")
      .values({
        id: newId(),
        tenant_id: tenantId,
        metric_key: def.key,
        family: def.family,
        formula_ref: def.formulaRef,
        formula_version: def.formulaVersion,
        unit: def.unit,
        granularity: def.granularity,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.columns(["tenant_id", "metric_key"]).doNothing())
      .execute();
  }
}

async function projectAcq(db: Db, tenantId: string, days: Date[], points: Point[], window: RecomputeWindow): Promise<void> {
  failIfInjected(window, "ACQ");
  const touches = await db
    .selectFrom("growth.attribution_touches")
    .select(["occurred_at as at"])
    .where("tenant_id", "=", tenantId)
    .execute();
  const conversions = await db
    .selectFrom("growth.conversion_events")
    .select(["occurred_at as at"])
    .where("tenant_id", "=", tenantId)
    .execute();
  for (const [key, rows] of [["acq.touches", touches], ["acq.conversions", conversions]] as const) {
    const counts = tallyByDay(rows, days);
    for (const day of days) {
      const count = counts.get(bucketKeyUTC(day)) as number;
      points.push({ key, bucket: day, valueJson: { count }, valueMinor: null });
    }
  }
  // growth.scheduled_intents gauge lives on the ACQ outreach queue.
  failIfInjected(window, "ACQ");
  const scheduled = await db
    .selectFrom("communication.message_intents")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("tenant_id", "=", tenantId)
    .where("status", "=", "SCHEDULED")
    .executeTakeFirstOrThrow();
  points.push({
    key: "growth.scheduled_intents",
    bucket: days[days.length - 1] as Date,
    valueJson: { count: Number(scheduled.n) },
    valueMinor: null,
  });
}

async function projectTrial(db: Db, tenantId: string, days: Date[], points: Point[], window: RecomputeWindow): Promise<void> {
  failIfInjected(window, "TRIAL");
  const trials = await db
    .selectFrom("trial.trials")
    .select(["id", "created_at as at", "activated_at"])
    .where("tenant_id", "=", tenantId)
    .execute();
  const requests = tallyByDay(trials, days);
  const activated = tallyByDay(
    trials.filter((t) => t.activated_at !== null).map((t) => ({ at: t.activated_at as Date })),
    days,
  );
  const results = await db
    .selectFrom("trial.trial_technical_results")
    .innerJoin("trial.trials", (join) =>
      join
        .onRef("trial.trials.tenant_id", "=", "trial.trial_technical_results.tenant_id")
        .onRef("trial.trials.id", "=", "trial.trial_technical_results.trial_id"),
    )
    .select(["trial.trials.created_at as at", "trial.trial_technical_results.summary_outcome as outcome"])
    .where("trial.trial_technical_results.tenant_id", "=", tenantId)
    .execute();
  const passedByDay = newDayCounts(days);
  const failedByDay = newDayCounts(days);
  const inconclusiveByDay = newDayCounts(days);
  for (const row of results) {
    const key = bucketKeyUTC(row.at);
    if (!passedByDay.has(key)) {
      continue;
    }
    if (row.outcome === "PASSED") {
      passedByDay.set(key, (passedByDay.get(key) as number) + 1);
    } else if (row.outcome === "FAILED") {
      failedByDay.set(key, (failedByDay.get(key) as number) + 1);
    } else {
      inconclusiveByDay.set(key, (inconclusiveByDay.get(key) as number) + 1);
    }
  }
  for (const day of days) {
    const key = bucketKeyUTC(day);
    const passed = passedByDay.get(key) as number;
    const failed = failedByDay.get(key) as number;
    const inconclusive = inconclusiveByDay.get(key) as number;
    const rate = rateBps(passed, passed + failed);
    points.push({ key: "trial.requests", bucket: day, valueJson: { count: requests.get(key) as number }, valueMinor: null });
    points.push({ key: "trial.activated", bucket: day, valueJson: { count: activated.get(key) as number }, valueMinor: null });
    points.push({
      key: "trial.technical_pass_rate_bps",
      bucket: day,
      valueJson: { passed, failed, inconclusive, passRateBps: rate === null ? null : rate.toString() },
      valueMinor: null,
    });
  }
}

async function projectSales(db: Db, tenantId: string, days: Date[], points: Point[], window: RecomputeWindow): Promise<void> {
  failIfInjected(window, "SALES");
  const orders = await db
    .selectFrom("commerce.orders")
    .select(["settled_at as at", "settled_amount_minor"])
    .where("tenant_id", "=", tenantId)
    .where("status", "=", "SETTLED")
    .execute();
  const inWindow = orders.filter((o) => o.at !== null);
  const counts = tallyByDay(inWindow as Array<{ at: Date }>, days);
  const revenueByDay = new Map<string, bigint>();
  for (const day of days) {
    revenueByDay.set(bucketKeyUTC(day), 0n);
  }
  for (const order of inWindow) {
    const key = bucketKeyUTC(order.at as Date);
    if (revenueByDay.has(key)) {
      revenueByDay.set(key, (revenueByDay.get(key) as bigint) + toMinorStrict(order.settled_amount_minor));
    }
  }
  for (const day of days) {
    const key = bucketKeyUTC(day);
    const revenue = revenueByDay.get(key) as bigint;
    points.push({ key: "sales.settled_orders", bucket: day, valueJson: { count: counts.get(key) as number }, valueMinor: null });
    points.push({
      key: "sales.settled_revenue_minor",
      bucket: day,
      valueJson: { count: counts.get(key) as number, totalMinor: revenue.toString() },
      valueMinor: revenue.toString(),
    });
  }
}

async function projectFin(db: Db, tenantId: string, days: Date[], points: Point[], window: RecomputeWindow): Promise<void> {
  failIfInjected(window, "FIN");
  // FIN-01 via finance-math (same normalization as the finance overview):
  // active recurring components → monthly equivalent. MRR is NOT cash.
  const activeSubs = await db
    .selectFrom("subscription.subscriptions")
    .select(["id", "plan_id"])
    .where("tenant_id", "=", tenantId)
    .where("status", "=", "ACTIVE")
    .limit(5000)
    .execute();
  let mrrMinor = 0n;
  let unnormalized = 0;
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
      unnormalized += 1;
      continue;
    }
    const normalized = normalizeMrrMinor(
      toMinorStrict(cycle.base_revenue_minor),
      plan.billing_interval_unit,
      plan.billing_interval_count,
    );
    if (normalized === null) {
      unnormalized += 1;
      continue;
    }
    mrrMinor += normalized;
  }
  points.push({
    key: "fin.mrr_minor",
    bucket: days[days.length - 1] as Date,
    valueJson: {
      totalMinor: mrrMinor.toString(),
      activeSubscriptions: activeSubs.length,
      coverage: unnormalized === 0 ? "COMPLETE" : "PARTIAL",
    },
    valueMinor: mrrMinor.toString(),
  });
}

async function projectBill(db: Db, tenantId: string, days: Date[], points: Point[], window: RecomputeWindow): Promise<void> {
  failIfInjected(window, "BILL");
  const active = await db
    .selectFrom("subscription.subscriptions")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("tenant_id", "=", tenantId)
    .where("status", "=", "ACTIVE")
    .executeTakeFirstOrThrow();
  points.push({
    key: "bill.active_subscriptions",
    bucket: days[days.length - 1] as Date,
    valueJson: { count: Number(active.n) },
    valueMinor: null,
  });
}

async function projectRet(db: Db, tenantId: string, days: Date[], points: Point[], window: RecomputeWindow): Promise<void> {
  failIfInjected(window, "RET");
  const open = await db
    .selectFrom("renewal.recovery_tasks")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("tenant_id", "=", tenantId)
    .where("status", "=", "OPEN")
    .executeTakeFirstOrThrow();
  points.push({
    key: "ret.open_recovery_tasks",
    bucket: days[days.length - 1] as Date,
    valueJson: { count: Number(open.n) },
    valueMinor: null,
  });
  const grants = await db
    .selectFrom("subscription.trust_renewal_grants")
    .select(["created_at as at"])
    .where("tenant_id", "=", tenantId)
    .execute();
  const counts = tallyByDay(grants, days);
  for (const day of days) {
    points.push({ key: "ret.trust_grants", bucket: day, valueJson: { count: counts.get(bucketKeyUTC(day)) as number }, valueMinor: null });
  }
}

async function projectSup(db: Db, tenantId: string, days: Date[], points: Point[], window: RecomputeWindow): Promise<void> {
  failIfInjected(window, "SUP");
  const open = await db
    .selectFrom("support.support_tickets")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("tenant_id", "=", tenantId)
    .where("status", "in", OPEN_TICKET_STATUSES)
    .executeTakeFirstOrThrow();
  points.push({
    key: "sup.open_tickets",
    bucket: days[days.length - 1] as Date,
    valueJson: { count: Number(open.n) },
    valueMinor: null,
  });
  const resolved = await db
    .selectFrom("support.support_tickets")
    .select(["id", "resolved_at as at"])
    .where("tenant_id", "=", tenantId)
    .where("status", "in", ["RESOLVED", "CLOSED"])
    .execute();
  const resolvedInWindow = resolved.filter((t) => t.at !== null);
  const counts = tallyByDay(resolvedInWindow as Array<{ at: Date }>, days);
  // SUP-03 proxy: resolved tickets with NO human solution attempt are
  // counted AI-resolved. Labeled proxy per the catalog (never presented
  // as measured satisfaction or causal AI effect).
  const resolvedIds = resolvedInWindow.map((t) => t.id);
  const humanTouched = new Set<string>();
  if (resolvedIds.length > 0) {
    const attempts = await db
      .selectFrom("support.solution_attempts")
      .select(["support_ticket_id"])
      .where("tenant_id", "=", tenantId)
      .where("support_ticket_id", "in", resolvedIds)
      .where("actor_type", "=", "human")
      .execute();
    for (const a of attempts) {
      humanTouched.add(a.support_ticket_id);
    }
  }
  const aiResolvedByDay = newDayCounts(days);
  for (const ticket of resolvedInWindow) {
    if (humanTouched.has(ticket.id)) {
      continue;
    }
    const key = bucketKeyUTC(ticket.at as Date);
    if (aiResolvedByDay.has(key)) {
      aiResolvedByDay.set(key, (aiResolvedByDay.get(key) as number) + 1);
    }
  }
  for (const day of days) {
    const key = bucketKeyUTC(day);
    const resolvedCount = counts.get(key) as number;
    const aiCount = aiResolvedByDay.get(key) as number;
    const rate = rateBps(aiCount, resolvedCount);
    points.push({ key: "sup.resolved_tickets", bucket: day, valueJson: { count: resolvedCount }, valueMinor: null });
    points.push({
      key: "sup.ai_resolution_rate_bps",
      bucket: day,
      valueJson: {
        resolved: resolvedCount,
        aiResolved: aiCount,
        aiResolutionRateBps: rate === null ? null : rate.toString(),
        proxy: "no-human-attempt",
      },
      valueMinor: null,
    });
  }
}

async function projectRef(db: Db, tenantId: string, days: Date[], points: Point[], window: RecomputeWindow): Promise<void> {
  failIfInjected(window, "REF");
  const referrals = await db
    .selectFrom("referral.referrals")
    .select(["created_at as at", "confirmed_at"])
    .where("tenant_id", "=", tenantId)
    .execute();
  const created = tallyByDay(referrals, days);
  const confirmed = tallyByDay(
    referrals.filter((r) => r.confirmed_at !== null).map((r) => ({ at: r.confirmed_at as Date })),
    days,
  );
  for (const day of days) {
    const key = bucketKeyUTC(day);
    points.push({ key: "ref.created", bucket: day, valueJson: { count: created.get(key) as number }, valueMinor: null });
    points.push({ key: "ref.confirmed", bucket: day, valueJson: { count: confirmed.get(key) as number }, valueMinor: null });
  }
}

async function projectFul(db: Db, tenantId: string, days: Date[], points: Point[], window: RecomputeWindow): Promise<void> {
  failIfInjected(window, "FUL");
  // FUL-01: succeeded / terminalized (succeeded + failed + cancelled).
  // human_required is NOT terminal while the operation can resume.
  const ops = await db
    .selectFrom("provider.provider_operations")
    .select(["status", "completed_at as at"])
    .where("tenant_id", "=", tenantId)
    .where("status", "in", TERMINAL_OPERATION_STATUSES)
    .execute();
  const succeededByDay = newDayCounts(days);
  const terminalByDay = newDayCounts(days);
  for (const op of ops) {
    if (op.at === null) {
      continue;
    }
    const key = bucketKeyUTC(op.at);
    if (!terminalByDay.has(key)) {
      continue;
    }
    terminalByDay.set(key, (terminalByDay.get(key) as number) + 1);
    if (op.status === "SUCCEEDED") {
      succeededByDay.set(key, (succeededByDay.get(key) as number) + 1);
    }
  }
  for (const day of days) {
    const key = bucketKeyUTC(day);
    const succeeded = succeededByDay.get(key) as number;
    const terminal = terminalByDay.get(key) as number;
    const rate = rateBps(succeeded, terminal);
    points.push({
      key: "ful.success_rate_bps",
      bucket: day,
      valueJson: { succeeded, terminal, successRateBps: rate === null ? null : rate.toString() },
      valueMinor: null,
    });
  }
}

async function projectAi(db: Db, tenantId: string, days: Date[], points: Point[], window: RecomputeWindow): Promise<void> {
  failIfInjected(window, "AI");
  const runs = await db
    .selectFrom("agent.agent_runs")
    .select(["created_at as at"])
    .where("tenant_id", "=", tenantId)
    .execute();
  const counts = tallyByDay(runs, days);
  for (const day of days) {
    points.push({ key: "ai.runs", bucket: day, valueJson: { count: counts.get(bucketKeyUTC(day)) as number }, valueMinor: null });
  }
}

const FAMILY_PROJECTORS: Record<string, (db: Db, tenantId: string, days: Date[], points: Point[], window: RecomputeWindow) => Promise<void>> = {
  ACQ: projectAcq,
  TRIAL: projectTrial,
  SALES: projectSales,
  FIN: projectFin,
  BILL: projectBill,
  RET: projectRet,
  SUP: projectSup,
  REF: projectRef,
  FUL: projectFul,
  AI: projectAi,
};

/** Primary metric per family receiving the DEGRADED marker on failure. */
const FAMILY_PRIMARY_METRIC: Record<string, string> = {
  ACQ: "acq.touches",
  TRIAL: "trial.requests",
  SALES: "sales.settled_orders",
  FIN: "fin.mrr_minor",
  BILL: "bill.active_subscriptions",
  RET: "ret.open_recovery_tasks",
  SUP: "sup.open_tickets",
  REF: "ref.created",
  FUL: "ful.success_rate_bps",
  AI: "ai.runs",
};

/**
 * Recompute daily snapshots for one tenant (idempotent; replay-safe).
 * Reads domain facts only; writes solely to `analytics.*`.
 */
export async function recomputeAnalytics(db: Db, tenantId: string, window: RecomputeWindow = {}): Promise<RecomputeResult> {
  if (window.failFamily !== undefined && !isMetricFamily(window.failFamily)) {
    throw new Error(`unknown family for failFamily: ${window.failFamily}`);
  }
  const { from, to } = defaultWindow(window);
  if (to.getTime() - from.getTime() > 93 * 86_400_000) {
    throw new Error("recompute window exceeds 93 days");
  }
  // `to` is exclusive; counters bucket the closed day range.
  let days = eachDayUTC(from, new Date(to.getTime() - 1));
  if (days.length === 0) {
    days = [bucketDayUTC(from)];
  }
  // Gauges snapshot current state at the recompute instant, never a
  // historical bucket (the underlying facts are point-in-time reads).
  const gaugeBucket = bucketDayUTC(new Date());
  if (gaugeBucket.getTime() > (days[days.length - 1] as Date).getTime()) {
    days = [...days, gaugeBucket];
  }
  const computedAt = new Date();
  await ensureDefinitions(db, tenantId);

  const points: Point[] = [];
  const degradedFamilies: string[] = [];
  for (const [family, project] of Object.entries(FAMILY_PROJECTORS)) {
    try {
      await project(db, tenantId, days, points, window);
    } catch {
      degradedFamilies.push(family);
      points.push({
        key: FAMILY_PRIMARY_METRIC[family] as string,
        bucket: days[days.length - 1] as Date,
        valueJson: { degraded: true, family },
        valueMinor: null,
      });
    }
  }

  // Idempotent write: delete the window's own rows per touched key, then
  // a single batched insert per key.
  const byKey = new Map<string, Point[]>();
  for (const point of points) {
    const slot = byKey.get(point.key) ?? [];
    slot.push(point);
    byKey.set(point.key, slot);
  }
  let snapshotsWritten = 0;
  for (const [key, keyPoints] of byKey) {
    const degradedOnly = keyPoints.every((p) => (p.valueJson as { degraded?: boolean }).degraded === true);
    const buckets = keyPoints.map((p) => p.bucket);
    if (!degradedOnly) {
      const minBucket = new Date(Math.min(...buckets.map((b) => b.getTime())));
      const maxBucket = new Date(Math.max(...buckets.map((b) => b.getTime())));
      await db
        .deleteFrom("analytics.metric_snapshots")
        .where("tenant_id", "=", tenantId)
        .where("metric_key", "=", key)
        .where("bucket_start", ">=", minBucket)
        .where("bucket_start", "<=", maxBucket)
        .execute();
    } else {
      // DEGRADED marker replaces only its own bucket — history is preserved.
      await db
        .deleteFrom("analytics.metric_snapshots")
        .where("tenant_id", "=", tenantId)
        .where("metric_key", "=", key)
        .where("bucket_start", "=", (keyPoints[0] as Point).bucket)
        .execute();
    }
    await db
      .insertInto("analytics.metric_snapshots")
      .values(
        keyPoints.map((point) => ({
          id: newId(),
          tenant_id: tenantId,
          metric_key: point.key,
          bucket_start: point.bucket,
          granularity: "DAY",
          value_json: point.valueJson,
          value_minor: point.valueMinor,
          computed_at: computedAt,
          data_quality: (point.valueJson as { degraded?: boolean }).degraded === true ? "DEGRADED" : "OK",
        })),
      )
      .execute();
    snapshotsWritten += keyPoints.length;
  }

  return {
    snapshotsWritten,
    degradedFamilies,
    computedAt: computedAt.toISOString(),
    window: { from: from.toISOString(), to: to.toISOString() },
  };
}
