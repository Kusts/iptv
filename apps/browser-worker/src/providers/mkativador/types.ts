/**
 * MK Ativador typed port (credential-independent engineering, G07).
 *
 * Contract-before-code: NO endpoint, param, payload, selector, route or
 * credential value is invented here. Every external effect goes through the
 * explicit SIMULATED fixture interface in `simulated.ts`. Anything
 * unobserved stays a typed seam.
 *
 * Credential rule: this port carries credential REFS (`infisical://…`
 * strings) only — never values. Values stay in the operator vault and are
 * resolved by the Browser Worker identity at execution time.
 */

export const MK_SIMULATED_ADAPTER_VERSION = "mk-ativador-simulated-v1" as const;

/** Terminal outcome. UNKNOWN is distinct from SUCCESS/FAILURE. */
export type MkOutcome = "SUCCESS" | "FAILURE" | "UNKNOWN" | "MANUAL";

/** Reconciliation state tracked per operation. */
export type MkReconciliationState =
  | "REQUESTED"
  | "RUNNING"
  | "VERIFYING"
  | "SUCCEEDED"
  | "FAILED"
  | "MANUAL";

/** Certified MK semantic operations (names only — no endpoints). */
export type MkOperationKind =
  | "auth.session"
  | "balance.query"
  | "product.query"
  | "purchase"
  | "activation"
  | "readback";

export interface MkCredentialRefs {
  /** `infisical://…` ref for the panel/account identity. Never a value. */
  accountRef: string;
  /** `infisical://…` ref for the purchase channel secret. Never a value. */
  channelRef: string;
}

export interface MkOperationBase {
  kind: MkOperationKind;
  /** Idempotency key: caller-supplied, required on mutating ops. */
  idempotencyKey: string;
  /** Operator-configured spending cap (minor units). 0 = no purchases. */
  spendingLimitMinor: number;
  /** Amount this op would spend (minor units). 0 for reads. */
  amountMinor: number;
}

export interface MkAuthSessionInput extends MkOperationBase {
  kind: "auth.session";
  credentials: MkCredentialRefs;
  amountMinor: 0;
}

export interface MkBalanceQueryInput extends MkOperationBase {
  kind: "balance.query";
  credentials: MkCredentialRefs;
  amountMinor: 0;
}

export interface MkProductQueryInput extends MkOperationBase {
  kind: "product.query";
  credentials: MkCredentialRefs;
  /** External supplier product id (opaque string, never a URL). */
  externalProductId: string;
  amountMinor: 0;
}

export interface MkPurchaseInput extends MkOperationBase {
  kind: "purchase";
  credentials: MkCredentialRefs;
  externalProductId: string;
}

export interface MkActivationInput extends MkOperationBase {
  kind: "activation";
  credentials: MkCredentialRefs;
  /** Supplier purchase/activation reference from a prior purchase. */
  purchaseRef: string;
  /** Target device/account identifier (opaque, e.g. MAC — never a secret). */
  targetId: string;
}

export interface MkReadbackInput extends MkOperationBase {
  kind: "readback";
  credentials: MkCredentialRefs;
  /** Operation whose external effect is being verified. */
  subjectIdempotencyKey: string;
  amountMinor: 0;
}

export type MkOperationInput =
  | MkAuthSessionInput
  | MkBalanceQueryInput
  | MkProductQueryInput
  | MkPurchaseInput
  | MkActivationInput
  | MkReadbackInput;

export interface MkOperationResult {
  outcome: MkOutcome;
  reconciliationState: MkReconciliationState;
  /** Fixed words only — never provider bodies, refs or secret values. */
  detail: string;
  /** Opaque supplier reference (validated token shape) or null. */
  externalRef: string | null;
  /** True when this result came from the SIMULATED fixture. */
  simulated: true;
  needsHuman: boolean;
}

/** Sanitized audit entry. Never carries refs, values or provider bodies. */
export interface MkAuditEntry {
  kind: MkOperationKind;
  outcome: MkOutcome;
  reconciliationState: MkReconciliationState;
  /** Idempotency key prefix only (first 8 chars) — never the full key. */
  idempotencyPrefix: string;
  detail: string;
  simulated: true;
}

export function mkAuditFor(input: MkOperationInput, result: MkOperationResult): MkAuditEntry {
  return {
    kind: input.kind,
    outcome: result.outcome,
    reconciliationState: result.reconciliationState,
    idempotencyPrefix: input.idempotencyKey.slice(0, 8),
    detail: result.detail,
    simulated: true,
  };
}

const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._:=-]{0,127}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:=-]{0,127}$/;

function isRefLike(value: string): boolean {
  const lowered = value.toLowerCase();
  return lowered.includes("infisical://") || lowered.includes("wave4://");
}

export function validateMkCredentialRefs(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "credentials: expected object";
  }
  const record = value as Record<string, unknown>;
  for (const key of ["accountRef", "channelRef"] as const) {
    const entry = record[key];
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return `${key}: expected non-empty string`;
    }
    if (!isRefLike(entry)) {
      return `${key}: expected secret ref, never a value`;
    }
  }
  return null;
}

export function validateMkInput(input: MkOperationInput): string | null {
  if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_RE.test(input.idempotencyKey)) {
    return "idempotencyKey: invalid";
  }
  if (
    !Number.isInteger(input.spendingLimitMinor) ||
    input.spendingLimitMinor < 0 ||
    !Number.isInteger(input.amountMinor) ||
    input.amountMinor < 0
  ) {
    return "spending fields: expected non-negative integers";
  }
  if (input.kind === "purchase" || input.kind === "activation") {
    const refErr = validateMkCredentialRefs((input as MkPurchaseInput).credentials);
    if (refErr !== null) return refErr;
  }
  switch (input.kind) {
    case "auth.session":
    case "balance.query":
    case "readback":
      return validateMkCredentialRefs(input.credentials);
    case "product.query":
    case "purchase":
      if (!OPAQUE_ID_RE.test(input.externalProductId)) return "externalProductId: invalid";
      return validateMkCredentialRefs(input.credentials);
    case "activation": {
      if (!OPAQUE_ID_RE.test(input.purchaseRef)) return "purchaseRef: invalid";
      if (!OPAQUE_ID_RE.test(input.targetId)) return "targetId: invalid";
      return null;
    }
  }
}

/**
 * Spending-limit gate (pure): any purchase whose amount exceeds the
 * operator cap parks MANUAL before any external call. Reads never spend.
 */
export function isOverSpendingLimit(input: MkOperationInput): boolean {
  if (input.kind !== "purchase" && input.kind !== "activation") return false;
  if (input.amountMinor <= 0) return false;
  return input.amountMinor > input.spendingLimitMinor;
}

/** Timeout classification: a timed-out mutating call is UNKNOWN, never FAILED. */
export function classifyMkTimeout(kind: MkOperationKind): MkOperationResult {
  return {
    outcome: "UNKNOWN",
    reconciliationState: "VERIFYING",
    detail: `mk: ${kind} timed out after potential effect, verify before retry (SIMULATED)`,
    externalRef: null,
    simulated: true,
    needsHuman: true,
  };
}

/** Uncertain external effect defaults to MANUAL fallback with audit log. */
export function mkManualFallback(kind: MkOperationKind, reason: string): MkOperationResult {
  return {
    outcome: "MANUAL",
    reconciliationState: "MANUAL",
    detail: `mk: ${kind} parked for operator: ${reason} (SIMULATED)`,
    externalRef: null,
    simulated: true,
    needsHuman: true,
  };
}
