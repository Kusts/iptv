import {
  POLICY_CLASS_ORDER,
  isPolicyClass,
  mergePolicyLayers,
  type PolicyClass,
} from "@iptv/domain";
import type { StoredPolicyDocument } from "../commands/command-bus.js";

/**
 * Wave 4 Trial policy + transition pure logic.
 *
 * Canonical rules (baseline 02/03/06):
 * - Trial != Retrial != TechnicalAccessGrant != TrustRenewalGrant. Persisted
 *   kind is ONLY `TRIAL | RETRIAL` ("Primary" is descriptive, never an enum).
 * - Retrial requires `previous_trial_id` + a legitimate (non-blank) reason.
 * - Technical result (`PENDING | PASSED | FAILED | INCONCLUSIVE`) is a
 *   separate assessment: technical FAILED is never a second lifecycle state.
 * - Lifecycle: `REQUESTED | PROVISIONING | ACTIVE | ENDED | INVALIDATED |
 *   CANCELLED`, typical path `REQUESTED -> PROVISIONING -> ACTIVE -> ENDED`.
 *   A provisioning failure with certain non-application returns the trial to
 *   `REQUESTED` (nothing was provisioned, so retry stays possible and the
 *   single-open-access invariant keeps guarding); an unusable provisioned
 *   trial is explicitly `INVALIDATED`, enabling policy-reviewed retrial.
 * - Trust Renewal is a policy-family decision (`trial.trust_renewal`), NOT
 *   hardcoded magic; the safe default matches the documented example
 *   (exactly +3 days, only ACTIVE, remaining <= 3 days).
 */

export const TRIAL_STATUSES = [
  "REQUESTED",
  "PROVISIONING",
  "ACTIVE",
  "ENDED",
  "INVALIDATED",
  "CANCELLED",
] as const;

export type TrialStatus = (typeof TRIAL_STATUSES)[number];

export const TRIAL_KINDS = ["TRIAL", "RETRIAL"] as const;

export const TECHNICAL_OUTCOMES = ["PASSED", "FAILED", "INCONCLUSIVE"] as const;

export type TechnicalOutcome = (typeof TECHNICAL_OUTCOMES)[number];

/**
 * Owning-context transition map (exhaustive: every status lists exactly the
 * statuses a Wave 4 command may move it to; terminal states map to `[]`).
 */
export const TRIAL_TRANSITIONS: Record<TrialStatus, readonly TrialStatus[]> = {
  REQUESTED: ["PROVISIONING", "CANCELLED"],
  PROVISIONING: ["ACTIVE", "REQUESTED", "CANCELLED"],
  ACTIVE: ["ENDED", "INVALIDATED"],
  ENDED: [],
  INVALIDATED: [],
  CANCELLED: [],
};

export function isTrialTransition(from: string, to: string): boolean {
  const allowed = (TRIAL_TRANSITIONS as Record<string, readonly string[]>)[from];
  return allowed !== undefined && allowed.includes(to);
}

/** Registry-listed trial/provider events this wave may emit. Nothing else. */
export const TRIAL_EVENT_ALLOWLIST = [
  "trial.requested.v1",
  "trial.eligibility_allowed.v1",
  "trial.eligibility_denied.v1",
  "trial.eligibility_review_required.v1",
  "trial.provisioning_started.v1",
  "trial.provisioning_failed.v1",
  "trial.activated.v1",
  "trial.technical_passed.v1",
  "trial.technical_failed.v1",
  "trial.technical_inconclusive.v1",
  "trial.expired.v1",
  "trial.cancelled.v1",
  "trial.invalidated.v1",
  "trial.retrial_allowed.v1",
  "provider.operation_requested.v1",
  "provider.operation_succeeded.v1",
  "provider.operation_failed.v1",
] as const;

export function isAllowedTrialEvent(eventType: string): boolean {
  return (TRIAL_EVENT_ALLOWLIST as readonly string[]).includes(eventType);
}

/** Terminal trial statuses: a retrial's `previous_trial_id` must be one. */
export const TERMINAL_TRIAL_STATUSES = ["ENDED", "INVALIDATED"] as const;

export const ELIGIBILITY_FAMILY = "trial.eligibility";
export const TRUST_RENEWAL_FAMILY = "trial.trust_renewal";

/** CINEVISION trial durations from the capability registry (1h/3h/6h). */
export const DEFAULT_ALLOWED_DURATIONS_MINUTES = [60, 180, 360] as const;

export interface EligibilityPolicy {
  allow: boolean;
  retrialMode: "allow" | "review" | "deny";
  durationsMinutes: number[];
  allowAdult: boolean;
  reviewFirstTrial: boolean;
}

export const DEFAULT_ELIGIBILITY_POLICY: EligibilityPolicy = {
  allow: true,
  retrialMode: "review",
  durationsMinutes: [...DEFAULT_ALLOWED_DURATIONS_MINUTES],
  allowAdult: true,
  reviewFirstTrial: false,
};

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Parse a merged `trial.eligibility` document; unknown shapes fall back safely. */
export function parseEligibilityPolicy(doc: Record<string, unknown> | null): EligibilityPolicy {
  if (doc === null) {
    return { ...DEFAULT_ELIGIBILITY_POLICY };
  }
  const retrialRaw = asString(doc["retrial_mode"]);
  const retrialMode: EligibilityPolicy["retrialMode"] =
    retrialRaw === "allow" || retrialRaw === "review" || retrialRaw === "deny"
      ? retrialRaw
      : DEFAULT_ELIGIBILITY_POLICY.retrialMode;
  const durationsRaw = doc["durations_minutes"];
  const durationsMinutes =
    Array.isArray(durationsRaw) &&
    durationsRaw.length > 0 &&
    durationsRaw.every((v): v is number => typeof v === "number" && Number.isInteger(v) && v > 0)
      ? [...durationsRaw]
      : [...DEFAULT_ELIGIBILITY_POLICY.durationsMinutes];
  return {
    allow: asBoolean(doc["allow"], true),
    retrialMode,
    durationsMinutes,
    allowAdult: asBoolean(doc["allow_adult"], true),
    reviewFirstTrial: asBoolean(doc["review_first_trial"], false),
  };
}

export type EligibilityOutcome = "ALLOW" | "ALLOW_RETRIAL" | "REVIEW" | "DENY";

export interface EligibilityContext {
  hasPrimary: boolean;
  hasOpen: boolean;
  isRetrial: boolean;
  previousStatus: string | null;
  durationMinutes: number;
  adult: boolean;
}

export interface EligibilityEvaluation {
  outcome: EligibilityOutcome;
  reasonCodes: string[];
}

/**
 * Pure eligibility evaluation (unit-tested). The caller checks duration
 * validity and previous-trial terminality separately and maps them to
 * `validation_failed` / `precondition_failed` before invoking this.
 */
export function evaluateEligibility(
  policy: EligibilityPolicy,
  ctx: EligibilityContext,
): EligibilityEvaluation {
  if (!policy.allow) {
    return { outcome: "DENY", reasonCodes: ["POLICY_DISABLED"] };
  }
  if (ctx.hasOpen) {
    return { outcome: "DENY", reasonCodes: ["OPEN_TRIAL_EXISTS"] };
  }
  if (ctx.adult && !policy.allowAdult) {
    return { outcome: "DENY", reasonCodes: ["ADULT_NOT_ALLOWED"] };
  }
  if (ctx.isRetrial) {
    if (policy.retrialMode === "deny") {
      return { outcome: "DENY", reasonCodes: ["RETRIAL_POLICY_DENY"] };
    }
    if (policy.retrialMode === "allow") {
      return { outcome: "ALLOW_RETRIAL", reasonCodes: ["RETRIAL_POLICY_ALLOW"] };
    }
    return { outcome: "REVIEW", reasonCodes: ["RETRIAL_REQUIRES_REVIEW"] };
  }
  if (ctx.hasPrimary) {
    return { outcome: "DENY", reasonCodes: ["PRIMARY_ALREADY_EXISTS"] };
  }
  if (policy.reviewFirstTrial) {
    return { outcome: "REVIEW", reasonCodes: ["FIRST_TRIAL_REVIEW"] };
  }
  return { outcome: "ALLOW", reasonCodes: ["FIRST_PRIMARY_TRIAL"] };
}

export interface TrustRenewalPolicy {
  allow: boolean;
  extensionDays: number;
  maxRemainingDays: number;
}

/** Safe default matching the documented example: +3 days, remaining <= 3. */
export const DEFAULT_TRUST_RENEWAL_POLICY: TrustRenewalPolicy = {
  allow: true,
  extensionDays: 3,
  maxRemainingDays: 3,
};

function asPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Parse a merged `trial.trust_renewal` document; unknown shapes fall back safely. */
export function parseTrustRenewalPolicy(doc: Record<string, unknown> | null): TrustRenewalPolicy {
  if (doc === null) {
    return { ...DEFAULT_TRUST_RENEWAL_POLICY };
  }
  return {
    allow: asBoolean(doc["allow"], true),
    extensionDays: asPositiveNumber(doc["extension_days"], DEFAULT_TRUST_RENEWAL_POLICY.extensionDays),
    maxRemainingDays: asPositiveNumber(
      doc["max_remaining_days"],
      DEFAULT_TRUST_RENEWAL_POLICY.maxRemainingDays,
    ),
  };
}

export type TrustRenewalDecision =
  | { allowed: true; extensionDays: number; remainingMs: number }
  | { allowed: false; reason: string };

const DAY_MS = 86_400_000;

/**
 * Pure trust-renewal gate (unit-tested, boundary-exact): ACTIVE only,
 * `remaining <= maxRemainingDays` (exactly 3 days remaining is allowed,
 * 4 days is denied under the default policy). No lower bound: expiry
 * itself belongs to the `trial.expire_due` scheduler seam.
 */
export function decideTrustRenewal(
  policy: TrustRenewalPolicy,
  input: { status: string; expiresAt: Date | null; at: Date },
): TrustRenewalDecision {
  if (!policy.allow) {
    return { allowed: false, reason: "trust renewal is disabled by policy" };
  }
  if (input.status !== "ACTIVE") {
    return { allowed: false, reason: `trial is ${input.status}, trust renewal requires ACTIVE` };
  }
  if (input.expiresAt === null) {
    return { allowed: false, reason: "trial has no expiration to extend" };
  }
  const remainingMs = input.expiresAt.getTime() - input.at.getTime();
  if (remainingMs > policy.maxRemainingDays * DAY_MS) {
    return {
      allowed: false,
      reason: `remaining time exceeds the policy threshold of ${policy.maxRemainingDays} days`,
    };
  }
  return { allowed: true, extensionDays: policy.extensionDays, remainingMs };
}

/** Merge published policy rows (latest version per class, class precedence). */
export function mergePolicyRows(rows: StoredPolicyDocument[]): {
  document: Record<string, unknown> | null;
  versionRef: string;
} {
  if (rows.length === 0) {
    return { document: null, versionRef: "default-v1" };
  }
  const latestByClass = new Map<PolicyClass, StoredPolicyDocument>();
  for (const row of rows) {
    if (!isPolicyClass(row.class)) {
      continue;
    }
    const current = latestByClass.get(row.class);
    if (current === undefined || row.version > current.version) {
      latestByClass.set(row.class, row);
    }
  }
  const ordered = [...latestByClass.entries()].sort(
    ([a], [b]) => POLICY_CLASS_ORDER[a] - POLICY_CLASS_ORDER[b],
  );
  if (ordered.length === 0) {
    return { document: null, versionRef: "default-v1" };
  }
  const value = mergePolicyLayers(ordered.map(([, row]) => row.document));
  const versionRef = ordered.map(([, row]) => `${row.scope}:${row.family}:v${row.version}`).join("+");
  return { document: value, versionRef };
}
