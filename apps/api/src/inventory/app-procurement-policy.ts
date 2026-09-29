/**
 * Wave 7 read-only slice: paid-app procurement readiness gate (pure, no I/O).
 *
 * Canonical rule (inventory-procurement SPEC §§57–75, acceptance §111–119;
 * policy-architecture refinements v0.14; G07/F15 acceptance matrix):
 *
 * ```text
 * recommend compatible app
 * → configure free test
 * → customer validates
 * → Order + payment (SETTLED)
 * → reserve MK balance
 * → purchase/activate license
 * → verify postcondition
 * ```
 *
 * This module evaluates ONLY the preconditions for a caller to *attempt* an
 * atomic MK-balance reservation. It is a pure, read-only function over
 * already-resolved caller facts:
 *
 * - Callers MUST resolve every fact inside the same tenant/customer scope
 *   before invoking this evaluator. This function cannot verify tenancy or
 *   ownership itself (no database, no network); cross-scope facts must never
 *   be mixed by the caller.
 * - `READY_FOR_RESERVATION` means preconditions passed for the caller to
 *   attempt an atomic reservation. It does NOT authorize a supplier purchase,
 *   perform a reservation/debit, emit an event or alert, or claim that
 *   concurrent overspend is prevented. The reservation itself must still be
 *   atomic at the ledger layer (reservations separate total/reserved/
 *   available), and the F15 pause/alert decision belongs to the caller.
 * - `BLOCKED` with `INSUFFICIENT_SUPPLIER_BALANCE` (or balance-unknown
 *   reasons) is the stable signal the F15 pause/alert caller pauses on. No
 *   alert is emitted here.
 * - Fail-closed: any unknown fact blocks; malformed/negative/fractional
 *   money is rejected (never evaluated with JS floating-point arithmetic —
 *   all comparison is exact `bigint` minor-unit math).
 *
 * Money conventions mirror `supplier-app-catalog.ts`: integer minor units
 * with an explicit 3-letter currency per amount (no hidden default), within
 * PostgreSQL BIGINT range.
 */

const CURRENCY_RE = /^[A-Z]{3}$/;

/** PostgreSQL signed BIGINT max: minor-unit values above this cannot persist. */
const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;

export const APP_PROCUREMENT_STATUS = ["READY_FOR_RESERVATION", "BLOCKED"] as const;
export type AppProcurementStatus = (typeof APP_PROCUREMENT_STATUS)[number];

export const APP_PROCUREMENT_REASON_CODES = [
  "PRECONDITIONS_MET",
  "CATALOG_ITEM_MISSING",
  "TRIAL_NOT_VALIDATED",
  "ORDER_NOT_SETTLED",
  "APP_COST_UNKNOWN",
  "INVALID_APP_COST",
  "SUPPLIER_BALANCE_UNKNOWN",
  "INVALID_SUPPLIER_BALANCE",
  "INVALID_CURRENCY",
  "CURRENCY_MISMATCH",
  "INSUFFICIENT_SUPPLIER_BALANCE",
] as const;
export type AppProcurementReasonCode = (typeof APP_PROCUREMENT_REASON_CODES)[number];

/**
 * Already-resolved caller facts. Every field is the caller's resolved view
 * inside one tenant/customer scope — this evaluator performs no lookup.
 */
export interface AppProcurementPolicyInput {
  /** Whether the supplier catalog item for the paid app was resolved. */
  catalogItemExists: boolean | null | undefined;
  /**
   * Whether the customer validated the free test. Only exactly `true`
   * passes; `false`, `"unknown"`, `null` and `undefined` all block.
   */
  trialValidated: boolean | string | null | undefined;
  /** Resolved Order status; only exactly `"SETTLED"` passes. */
  orderStatus: string | null | undefined;
  /** Required paid-app cost in integer minor units (unknown when null). */
  appCostMinor: string | number | bigint | null | undefined;
  /** Explicit currency of the required cost (no default). */
  appCurrency: string | null | undefined;
  /** Available supplier balance in integer minor units (unknown when null). */
  supplierBalanceMinor: string | number | bigint | null | undefined;
  /** Explicit currency of the supplier balance (no default). */
  supplierCurrency: string | null | undefined;
}

export interface AppProcurementEvaluation {
  status: AppProcurementStatus;
  /** Exactly one deterministic reason code, in gate-priority order. */
  reasonCodes: [AppProcurementReasonCode];
}

type MoneyParse =
  | { readonly kind: "unknown" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly value: bigint };

function parseMinorUnits(value: string | number | bigint | null | undefined): MoneyParse {
  if (value === null || value === undefined) {
    return { kind: "unknown" };
  }
  if (typeof value === "bigint") {
    if (value < 0n || value > PG_BIGINT_MAX) {
      return { kind: "invalid" };
    }
    return { kind: "value", value };
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      return { kind: "invalid" };
    }
    const asBigint = BigInt(value);
    if (asBigint > PG_BIGINT_MAX) {
      return { kind: "invalid" };
    }
    return { kind: "value", value: asBigint };
  }
  const text = value.trim();
  if (!/^\d+$/.test(text)) {
    return { kind: "invalid" };
  }
  const parsed = BigInt(text);
  if (parsed > PG_BIGINT_MAX) {
    return { kind: "invalid" };
  }
  return { kind: "value", value: parsed };
}

function blocked(code: AppProcurementReasonCode): AppProcurementEvaluation {
  return { status: "BLOCKED", reasonCodes: [code] };
}

/**
 * Pure readiness evaluation (deterministic, fail-closed). Gates run in the
 * canonical procurement order and the first failing gate decides the single
 * returned reason code:
 *
 * 1. catalog item exists → else `CATALOG_ITEM_MISSING`
 * 2. trial explicitly validated (`=== true`) → else `TRIAL_NOT_VALIDATED`
 * 3. Order status exactly `SETTLED` → else `ORDER_NOT_SETTLED`
 * 4. app cost known → else `APP_COST_UNKNOWN`; malformed, zero, negative or
 *    out-of-range → `INVALID_APP_COST` (cost must be strictly positive)
 * 5. supplier balance known → else `SUPPLIER_BALANCE_UNKNOWN`; malformed,
 *    negative or out-of-range → `INVALID_SUPPLIER_BALANCE`
 * 6. both currencies explicit 3-letter codes → else `INVALID_CURRENCY`;
 *    unequal → `CURRENCY_MISMATCH`
 * 7. balance >= cost (exact `bigint` comparison, equality is sufficient) →
 *    else `INSUFFICIENT_SUPPLIER_BALANCE`
 * 8. otherwise `READY_FOR_RESERVATION` with `PRECONDITIONS_MET`
 */
export function evaluateAppProcurementReadiness(
  input: AppProcurementPolicyInput,
): AppProcurementEvaluation {
  if (input.catalogItemExists !== true) {
    return blocked("CATALOG_ITEM_MISSING");
  }
  if (input.trialValidated !== true) {
    return blocked("TRIAL_NOT_VALIDATED");
  }
  if (input.orderStatus !== "SETTLED") {
    return blocked("ORDER_NOT_SETTLED");
  }

  const cost = parseMinorUnits(input.appCostMinor);
  if (cost.kind === "unknown") {
    return blocked("APP_COST_UNKNOWN");
  }
  if (cost.kind === "invalid" || cost.value <= 0n) {
    return blocked("INVALID_APP_COST");
  }

  const balance = parseMinorUnits(input.supplierBalanceMinor);
  if (balance.kind === "unknown") {
    return blocked("SUPPLIER_BALANCE_UNKNOWN");
  }
  if (balance.kind === "invalid") {
    return blocked("INVALID_SUPPLIER_BALANCE");
  }

  if (
    typeof input.appCurrency !== "string" ||
    !CURRENCY_RE.test(input.appCurrency) ||
    typeof input.supplierCurrency !== "string" ||
    !CURRENCY_RE.test(input.supplierCurrency)
  ) {
    return blocked("INVALID_CURRENCY");
  }
  if (input.appCurrency !== input.supplierCurrency) {
    return blocked("CURRENCY_MISMATCH");
  }

  if (balance.value < cost.value) {
    return blocked("INSUFFICIENT_SUPPLIER_BALANCE");
  }
  return { status: "READY_FOR_RESERVATION", reasonCodes: ["PRECONDITIONS_MET"] };
}
