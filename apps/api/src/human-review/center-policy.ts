import {
  DEFAULT_HITL_SLA_POLICY,
  classifySlaBand,
  parseHitlSlaPolicy,
  type HitlSlaPolicy,
  type SlaBand,
} from "../support/support-policy.js";

/**
 * Wave 8 HITL center read-model helpers (pure, unit-tested).
 *
 * The "center" is NOT a table — it aggregates OPEN work from the four
 * existing queues (human reviews, communications exceptions, billing
 * exceptions, recovery tasks) into one normalized, tenant-scoped view.
 * Staleness is policy-driven (`hitl.sla` family, safe defaults 4h/24h):
 * an explicit per-item `slaDueAt` (reviews) breaches on deadline first;
 * everything else classifies by age.
 */

export const CENTER_SOURCES = ["human_review", "comm_exception", "billing_exception", "recovery_task"] as const;

export type CenterSource = (typeof CENTER_SOURCES)[number];

export interface CenterItemInput {
  source: CenterSource;
  id: string;
  kind: string;
  summary: string;
  createdAt: Date;
  slaDueAt?: Date | null;
  deepLink: string;
  priority?: string | null;
}

export interface CenterItem extends CenterItemInput {
  ageMinutes: number;
  sla: SlaBand;
}

export function classifyCenterSla(
  policy: HitlSlaPolicy,
  input: { createdAt: Date; slaDueAt?: Date | null; at: Date },
): SlaBand {
  // An explicit deadline is authoritative: past-due is always a breach,
  // even under a lenient age policy. A future deadline never excuses age
  // staleness — the band is the worse of the two signals.
  if (input.slaDueAt !== undefined && input.slaDueAt !== null && input.at.getTime() > input.slaDueAt.getTime()) {
    return "BREACH";
  }
  return classifySlaBand(policy, { createdAt: input.createdAt, at: input.at });
}

export function normalizeCenterItem(
  policy: HitlSlaPolicy,
  input: CenterItemInput,
  at: Date,
): CenterItem {
  return {
    ...input,
    ageMinutes: Math.max(0, Math.floor((at.getTime() - input.createdAt.getTime()) / 60_000)),
    sla: classifyCenterSla(policy, { createdAt: input.createdAt, slaDueAt: input.slaDueAt, at }),
  };
}

export function resolveSlaPolicy(document: Record<string, unknown> | null): HitlSlaPolicy {
  return parseHitlSlaPolicy(document);
}

export { DEFAULT_HITL_SLA_POLICY };
