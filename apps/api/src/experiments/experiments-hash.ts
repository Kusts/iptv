import { createHash } from "node:crypto";

/**
 * Wave 16 deterministic assignment (pure — no database).
 *
 * Stable assignment per experimentation.md §6: `hash(experiment_key +
 * subject + assignment_version)` maps a subject to exactly one variant,
 * so replays always return the same variant without storing anything.
 * The store persists the first RUNNING-time answer; later replays read
 * the row back, so the hash below only ever decides fresh assignments.
 *
 * Weights are integer basis points (`weightBps`, sum > 0); the sha256
 * digest is read as a uint32 and reduced into the weight ring. No floats,
 * no randomness, no LLM anywhere near assignment (§11 guardrail).
 */

export interface VariantWeight {
  key: string;
  weightBps: number;
}

export const SUBJECT_TYPES = ["PERSON", "CUSTOMER", "CONVERSATION", "TENANT"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

/** Fallback variant answered when the experiment cannot assign (fail-open). */
export const CONTROL_VARIANT = "control";

export function parseVariantSpec(spec: unknown): VariantWeight[] {
  if (!Array.isArray(spec) || spec.length === 0) {
    throw new Error("arm_variant_spec must be a non-empty array of {key, weightBps}");
  }
  const out: VariantWeight[] = [];
  const seen = new Set<string>();
  for (const entry of spec) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("arm_variant_spec entries must be objects");
    }
    const { key, weightBps } = entry as { key?: unknown; weightBps?: unknown };
    if (typeof key !== "string" || key.trim().length === 0 || key.trim().length > 80) {
      throw new Error("arm_variant_spec entry key must be a non-empty string (max 80)");
    }
    if (!Number.isInteger(weightBps) || (weightBps as number) <= 0) {
      throw new Error(`arm_variant_spec weightBps for ${JSON.stringify(key)} must be a positive integer`);
    }
    const normalized = key.trim();
    if (seen.has(normalized)) {
      throw new Error(`arm_variant_spec has a duplicate variant: ${JSON.stringify(normalized)}`);
    }
    seen.add(normalized);
    out.push({ key: normalized, weightBps: weightBps as number });
  }
  return out;
}

/** Stable subject identity folded into the hash (type-prefixed, no PII). */
export function subjectKeyOf(subjectType: string, subjectId: string): string {
  return `${subjectType}:${subjectId}`;
}

function hashToUint32(input: string): number {
  const digest = createHash("sha256").update(input, "utf8").digest();
  return digest.readUInt32BE(0);
}

/**
 * Deterministically pick a variant. Same
 * `(experimentKey, subjectKey, assignmentVersion, variants)` always yields
 * the same variant; bumping `assignmentVersion` re-randomizes (the only
 * supported way to re-bucket — never silently).
 */
export function assignVariant(
  experimentKey: string,
  subjectKey: string,
  assignmentVersion: number,
  variants: VariantWeight[],
): string {
  const total = variants.reduce((acc, v) => acc + v.weightBps, 0);
  if (total <= 0) {
    throw new Error("arm_variant_spec weights must sum to a positive total");
  }
  const point = hashToUint32(`${experimentKey}\n${subjectKey}\n${assignmentVersion}`) % total;
  let cursor = 0;
  for (const variant of variants) {
    cursor += variant.weightBps;
    if (point < cursor) {
      return variant.key;
    }
  }
  const last = variants[variants.length - 1] as VariantWeight;
  return last.key;
}
