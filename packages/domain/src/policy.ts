/**
 * Policy resolution + autonomy primitives (W1-09/W1-10).
 *
 * Pure functions only — no I/O. Canonical precedence:
 * `PLATFORM_INVARIANT > PLATFORM_POLICY > TENANT_POLICY > PARTNER_POLICY`.
 * `RUNTIME_FACT` is observed state and never participates as configuration.
 *
 * Autonomy uses downgrade-only semantics: a lower layer (or an explicit
 * request) may reduce autonomy (`AUTO → APPROVAL`) but can never silently
 * increase it (`APPROVAL → AUTO` is forbidden by construction — the
 * combination is always the minimum rank).
 */

/** Policy classes in precedence order (highest first). */
export const POLICY_CLASSES = [
  "PLATFORM_INVARIANT",
  "PLATFORM_POLICY",
  "TENANT_POLICY",
  "PARTNER_POLICY",
] as const;

export type PolicyClass = (typeof POLICY_CLASSES)[number];

/** Storage scopes; each class maps to exactly one scope. */
export const POLICY_SCOPES = ["PLATFORM", "TENANT", "PARTNER"] as const;

export type PolicyScope = (typeof POLICY_SCOPES)[number];

/** Action autonomy levels (canonical task vocabulary). */
export const AUTONOMY_LEVELS = ["AUTO", "APPROVAL", "MANUAL", "DENY"] as const;

export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

const AUTONOMY_RANK: Record<AutonomyLevel, number> = {
  DENY: 0,
  MANUAL: 1,
  APPROVAL: 2,
  AUTO: 3,
};

/** Precedence rank: lower number = higher authority. */
export const POLICY_CLASS_ORDER: Record<PolicyClass, number> = {
  PLATFORM_INVARIANT: 0,
  PLATFORM_POLICY: 1,
  TENANT_POLICY: 2,
  PARTNER_POLICY: 3,
};

/** One link in the resolution provenance chain. */
export interface ResolutionStep {
  /** Which class contributed this step. */
  source: PolicyClass;
  /** Human-stable reference, e.g. `PLATFORM:trial-eligibility:v2`. */
  ref: string;
  /** The contributing document (or decision fragment). */
  decision: unknown;
}

/** Effective decision with its full provenance chain. */
export interface EffectiveDecision<T> {
  /** False when no published document covers the family. */
  configured: boolean;
  value: T;
  provenance: ResolutionStep[];
}

export function isPolicyClass(value: string): value is PolicyClass {
  return (POLICY_CLASSES as readonly string[]).includes(value);
}

export function isPolicyScope(value: string): value is PolicyScope {
  return (POLICY_SCOPES as readonly string[]).includes(value);
}

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return typeof value === "string" && (AUTONOMY_LEVELS as readonly string[]).includes(value);
}

/** The single scope each class is allowed to live in (mirrors SQL CHECK). */
export function scopeOfClass(klass: PolicyClass): PolicyScope {
  switch (klass) {
    case "PLATFORM_INVARIANT":
    case "PLATFORM_POLICY":
      return "PLATFORM";
    case "TENANT_POLICY":
      return "TENANT";
    case "PARTNER_POLICY":
      return "PARTNER";
  }
}

/** Scope/class coherence check (same rule as the migration CHECK). */
export function scopeMatchesClass(scope: string, klass: string): boolean {
  if (!isPolicyScope(scope) || !isPolicyClass(klass)) {
    return false;
  }
  return scopeOfClass(klass) === scope;
}

/**
 * Downgrade-only combination: returns the LOWER of the two autonomy levels.
 * A request for `AUTO` bounded by `APPROVAL` resolves to `APPROVAL`;
 * a request for `MANUAL` bounded by `AUTO` stays `MANUAL` (never upgraded).
 */
export function downgradeAutonomy(requested: AutonomyLevel, bound: AutonomyLevel): AutonomyLevel {
  return AUTONOMY_RANK[requested] <= AUTONOMY_RANK[bound] ? requested : bound;
}

/** Clamp a requested autonomy to a platform maximum (never upgrades). */
export function clampAutonomyToMax(requested: AutonomyLevel, max: AutonomyLevel): AutonomyLevel {
  return downgradeAutonomy(requested, max);
}

/**
 * Merge document layers given in precedence order (highest authority first).
 * Higher layers win per key; lower layers only fill keys not set above —
 * a lower layer can never violate (overwrite) a superior guardrail.
 */
export function mergePolicyLayers(layers: Array<Record<string, unknown>>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (!(key in merged)) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

/** Typed "family not configured" result (empty value, empty provenance). */
export function notConfigured(): EffectiveDecision<Record<string, unknown>> {
  return { configured: false, value: {}, provenance: [] };
}

/**
 * Generic base-autonomy interpretation of a family document:
 * - `allow === false` → `DENY` (explicit policy refusal);
 * - valid `autonomy` key → that level;
 * - `require_approval === true` → `APPROVAL`;
 * - otherwise → `AUTO` (pilot default for permitted operations).
 */
export function baseAutonomyOf(document: Record<string, unknown>): AutonomyLevel {
  if (document["allow"] === false) {
    return "DENY";
  }
  const declared = document["autonomy"];
  if (isAutonomyLevel(declared)) {
    return declared;
  }
  if (document["require_approval"] === true) {
    return "APPROVAL";
  }
  return "AUTO";
}

/** Platform-maximum interpretation: valid `max_autonomy` key, else null. */
export function maxAutonomyOf(document: Record<string, unknown>): AutonomyLevel | null {
  const declared = document["max_autonomy"];
  return isAutonomyLevel(declared) ? declared : null;
}
