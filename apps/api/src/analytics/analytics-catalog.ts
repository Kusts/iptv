/**
 * Wave 14 Metric Catalog (static registry).
 *
 * Canonical formulas live in `docs/08-data-analytics/metric-catalog.md`
 * (families ACQ/TRIAL/SALES/BILL/FUL/RET/ADDON/APP/REF/SUP/KNOW/AI/FIN/INV/
 * REL/SAAS + guardrails §18). This file invents NO metric: every entry
 * below names its `formulaRef` section. The tenant-scoped
 * `analytics.metric_definitions` rows (migration 036) are upserted from
 * this list by the recompute — the list is the registry, the table is the
 * per-tenant materialization.
 *
 * Money metrics report exact minor-unit strings; ratios report integer
 * basis points (×10_000) — never IEEE floats.
 */

export interface MetricDefinition {
  key: string;
  family: string;
  formulaRef: string;
  formulaVersion: string;
  unit: string;
  granularity: "DAY";
  kind: "COUNTER" | "GAUGE" | "RATIO";
}

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  { key: "acq.touches", family: "ACQ", formulaRef: "metric-catalog.md §ACQ funnel (attribution first-touch)", formulaVersion: "v1", unit: "count", granularity: "DAY", kind: "COUNTER" },
  { key: "acq.conversions", family: "ACQ", formulaRef: "metric-catalog.md §ACQ funnel (conversion events)", formulaVersion: "v1", unit: "count", granularity: "DAY", kind: "COUNTER" },
  { key: "trial.requests", family: "TRIAL", formulaRef: "metric-catalog.md §TRIAL-01 numerator", formulaVersion: "v1", unit: "count", granularity: "DAY", kind: "COUNTER" },
  { key: "trial.activated", family: "TRIAL", formulaRef: "metric-catalog.md §Trial activation (dashboards.md §4)", formulaVersion: "v1", unit: "count", granularity: "DAY", kind: "COUNTER" },
  { key: "trial.technical_pass_rate_bps", family: "TRIAL", formulaRef: "metric-catalog.md §TRIAL-03", formulaVersion: "v1", unit: "basis_points", granularity: "DAY", kind: "RATIO" },
  { key: "sales.settled_orders", family: "SALES", formulaRef: "metric-catalog.md §SALES-03 numerator", formulaVersion: "v1", unit: "count", granularity: "DAY", kind: "COUNTER" },
  { key: "sales.settled_revenue_minor", family: "SALES", formulaRef: "metric-catalog.md §Revenue (Financial Ledger + reconciled Orders)", formulaVersion: "v1", unit: "minor", granularity: "DAY", kind: "COUNTER" },
  { key: "fin.mrr_minor", family: "FIN", formulaRef: "metric-catalog.md §FIN-01", formulaVersion: "v1", unit: "minor", granularity: "DAY", kind: "GAUGE" },
  { key: "bill.active_subscriptions", family: "BILL", formulaRef: "metric-catalog.md §FIN-01 population (active recurring)", formulaVersion: "v1", unit: "count", granularity: "DAY", kind: "GAUGE" },
  { key: "ret.open_recovery_tasks", family: "RET", formulaRef: "metric-catalog.md §RET-05 queue (winback eligible)", formulaVersion: "v1", unit: "count", granularity: "DAY", kind: "GAUGE" },
  { key: "ret.trust_grants", family: "RET", formulaRef: "metric-catalog.md §RET-06 numerator", formulaVersion: "v1", unit: "count", granularity: "DAY", kind: "COUNTER" },
  { key: "sup.open_tickets", family: "SUP", formulaRef: "metric-catalog.md §Support queue (dashboards.md §8)", formulaVersion: "v1", unit: "count", granularity: "DAY", kind: "GAUGE" },
  { key: "sup.resolved_tickets", family: "SUP", formulaRef: "metric-catalog.md §SUP-02 numerator", formulaVersion: "v1", unit: "count", granularity: "DAY", kind: "COUNTER" },
  { key: "sup.ai_resolution_rate_bps", family: "SUP", formulaRef: "metric-catalog.md §SUP-03", formulaVersion: "v1", unit: "basis_points", granularity: "DAY", kind: "RATIO" },
  { key: "ref.created", family: "REF", formulaRef: "metric-catalog.md §REF-02 numerator", formulaVersion: "v1", unit: "count", granularity: "DAY", kind: "COUNTER" },
  { key: "ref.confirmed", family: "REF", formulaRef: "metric-catalog.md §REF-04 numerator", formulaVersion: "v1", unit: "count", granularity: "DAY", kind: "COUNTER" },
  { key: "ful.success_rate_bps", family: "FUL", formulaRef: "metric-catalog.md §FUL-01", formulaVersion: "v1", unit: "basis_points", granularity: "DAY", kind: "RATIO" },
  { key: "ai.runs", family: "AI", formulaRef: "metric-catalog.md §AI task volume (dashboards.md §11)", formulaVersion: "v1", unit: "count", granularity: "DAY", kind: "COUNTER" },
  { key: "growth.scheduled_intents", family: "ACQ", formulaRef: "metric-catalog.md §Growth outreach queue (dashboards.md §12)", formulaVersion: "v1", unit: "count", granularity: "DAY", kind: "GAUGE" },
];

export const METRIC_KEYS = new Set(METRIC_DEFINITIONS.map((d) => d.key));

/** Families with independent failure isolation (F14: one never sinks the recompute). */
export const METRIC_FAMILIES = ["ACQ", "TRIAL", "SALES", "FIN", "BILL", "RET", "SUP", "REF", "FUL", "AI"] as const;

export type MetricFamily = (typeof METRIC_FAMILIES)[number];

export function isMetricFamily(value: string): value is MetricFamily {
  return (METRIC_FAMILIES as readonly string[]).includes(value);
}
