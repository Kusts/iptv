/**
 * CINEVISION write-operation typed seam (credential-independent prep).
 *
 * Write contract UNOBSERVED — contract-before-code holds: this file invents
 * NO endpoints, params, payloads, selectors or routes. It defines the typed
 * operation envelope, lease/fencing plumbing (reusing the migration 045
 * dispatch-lease shape: `claimed_by` token + `lease_expires_at` +
 * `dispatch_started_at` frontier), idempotency keys, timeout→UNKNOWN
 * classification, the readback interface and the reconciliation hook.
 * Every execution path below is SIMULATED (see `write-simulated.ts`).
 */

export const CINEVISION_WRITE_SIMULATED_VERSION = "cinevision-write-simulated-v1" as const;

/** Semantic write actions (names only — no endpoints implied). */
export type CinevisionWriteAction =
  | "createTrial"
  | "createCustomer"
  | "renewCustomer"
  | "blockCustomer"
  | "unblockCustomer"
  | "changeConnections";

export type CinevisionWriteOutcome = "SUCCESS" | "FAILURE" | "UNKNOWN" | "MANUAL";

export type CinevisionReconciliationState =
  | "REQUESTED"
  | "RUNNING"
  | "VERIFYING"
  | "SUCCEEDED"
  | "FAILED"
  | "MANUAL";

/**
 * Lease plumbing (migration 045 shape): a freshely minted `claimedBy`
 * fencing token owns the claim until `leaseExpiresAt`; the
 * `dispatchStartedAt` frontier marks that an external effect may have
 * happened (post-send → VERIFYING on expiry, never silent requeue).
 */
export interface CinevisionWriteLease {
  claimedBy: string;
  leaseExpiresAt: string;
  dispatchStartedAt: string | null;
}

export interface CinevisionWriteInput {
  action: CinevisionWriteAction;
  /** Caller-supplied idempotency key (required, validated token shape). */
  idempotencyKey: string;
  /** Fencing token minted per acquisition (never reused across claims). */
  fencingToken: string;
  /** Opaque entity id (validated token shape, never a URL). */
  entityId: string;
  /** Certified scalar fields only — no nested objects, no secrets. */
  fields: Record<string, string | number | boolean>;
  /** `infisical://…` credential ref. Never a value. */
  credentialRef: string;
}

export interface CinevisionWriteResult {
  outcome: CinevisionWriteOutcome;
  reconciliationState: CinevisionReconciliationState;
  /** Fixed words only — never provider bodies or refs. */
  detail: string;
  externalRef: string | null;
  simulated: true;
  needsHuman: boolean;
}

export interface CinevisionWriteAuditEntry {
  action: CinevisionWriteAction;
  outcome: CinevisionWriteOutcome;
  reconciliationState: CinevisionReconciliationState;
  idempotencyPrefix: string;
  fencingPrefix: string;
  detail: string;
  simulated: true;
}

/**
 * Operation/payload fingerprint bound to an idempotency key. Replaying the
 * SAME key with a DIVERGENT fingerprint is a conflict (MANUAL), never a
 * silent success replay — a bare key match alone must not claim another
 * operation's outcome. Field order is normalized so key order never splits
 * the identity of the same operation.
 */
export function fingerprintCinevisionWriteInput(
  input: Pick<CinevisionWriteInput, "action" | "entityId" | "fields">,
): string {
  const keys = Object.keys(input.fields).sort();
  const fields = keys
    .map((key) => `${key}:${JSON.stringify(input.fields[key] ?? null)}`)
    .join(",");
  return `${input.action}|${input.entityId}|${fields}`;
}

export function cinevisionWriteAuditFor(
  input: CinevisionWriteInput,
  result: CinevisionWriteResult,
): CinevisionWriteAuditEntry {
  return {
    action: input.action,
    outcome: result.outcome,
    reconciliationState: result.reconciliationState,
    idempotencyPrefix: input.idempotencyKey.slice(0, 8),
    fencingPrefix: input.fencingToken.slice(0, 8),
    detail: result.detail,
    simulated: true,
  };
}

/** Readback: verifies the ACTUAL external effect. Never re-executes. */
export interface CinevisionWriteReadbackQuery {
  action: CinevisionWriteAction;
  idempotencyKey: string;
  externalRef: string | null;
}

export interface CinevisionWriteReadbackResult {
  effectApplied: boolean;
  conclusive: boolean;
  /** Fixed words only. */
  evidence: string;
  simulated: true;
}

/** Reconciliation decision over a readback observation. */
export type CinevisionReconcileDecision =
  | { kind: "succeed" }
  | { kind: "fail" }
  | { kind: "manual"; reason: string };

export function decideCinevisionWriteReconcile(
  readback: CinevisionWriteReadbackResult | null,
): CinevisionReconcileDecision {
  if (readback === null || readback.conclusive !== true) {
    return { kind: "manual", reason: "inconclusive readback, operator must verify" };
  }
  return readback.effectApplied ? { kind: "succeed" } : { kind: "fail" };
}

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:=-]{0,127}$/;

function isRefLike(value: string): boolean {
  const lowered = value.toLowerCase();
  return lowered.includes("infisical://") || lowered.includes("wave4://");
}

export function validateCinevisionWriteInput(input: CinevisionWriteInput): string | null {
  if (typeof input.idempotencyKey !== "string" || !TOKEN_RE.test(input.idempotencyKey)) {
    return "idempotencyKey: invalid";
  }
  if (typeof input.fencingToken !== "string" || input.fencingToken.trim().length < 8) {
    return "fencingToken: invalid";
  }
  if (typeof input.entityId !== "string" || !TOKEN_RE.test(input.entityId)) {
    return "entityId: invalid";
  }
  if (typeof input.credentialRef !== "string" || !isRefLike(input.credentialRef)) {
    return "credentialRef: expected secret ref, never a value";
  }
  if (input.fields === null || typeof input.fields !== "object" || Array.isArray(input.fields)) {
    return "fields: expected flat record";
  }
  for (const [key, value] of Object.entries(input.fields)) {
    if (key.length === 0 || key.length > 64) return `fields.${key}: invalid key`;
    const lowered = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      lowered.includes("secret") ||
      lowered.includes("token") ||
      lowered.includes("password") ||
      lowered.includes("credential") ||
      lowered.includes("infisical")
    ) {
      return `fields.${key}: forbidden key`;
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return `fields.${key}: expected scalar`;
    }
    if (typeof value === "string" && isRefLike(value)) return `fields.${key}: forbidden ref value`;
  }
  return null;
}

/**
 * Timeout classification (SPEC §35): a write call that outlives its budget
 * AFTER a potential effect is UNKNOWN — never FAILED, never a silent
 * re-send. The caller parks VERIFYING for readback.
 */
export function classifyCinevisionWriteTimeout(action: CinevisionWriteAction): CinevisionWriteResult {
  return {
    outcome: "UNKNOWN",
    reconciliationState: "VERIFYING",
    detail: `cinevision: ${action} timed out after potential effect, verify before retry (SIMULATED)`,
    externalRef: null,
    simulated: true,
    needsHuman: true,
  };
}

/** Uncertain/unauthorized write effects park MANUAL with an audit trail. */
export function cinevisionWriteManual(action: CinevisionWriteAction, reason: string): CinevisionWriteResult {
  return {
    outcome: "MANUAL",
    reconciliationState: "MANUAL",
    detail: `cinevision: ${action} parked for operator: ${reason} (SIMULATED)`,
    externalRef: null,
    simulated: true,
    needsHuman: true,
  };
}

/**
 * Pure recovery decision reusing the migration 045 frontier polarity:
 * pre-send expiry (no frontier) may release; post-send expiry (frontier
 * set) must park VERIFYING; live leases and terminal states are untouched.
 */
export type CinevisionLeaseRecovery = "release" | "park_verifying" | "none";

export function decideCinevisionLeaseRecovery(input: {
  status: string;
  leaseExpired: boolean;
  dispatchStarted: boolean;
}): CinevisionLeaseRecovery {
  if (!input.leaseExpired) return "none";
  if (input.status !== "QUEUED" && input.status !== "RUNNING") return "none";
  return input.dispatchStarted ? "park_verifying" : "release";
}
