/**
 * FASE5-S6 trial provision readback + postcondition gate (SPEC
 * cinevision-runtime-hardening §10/§11/§25/§31).
 *
 * Rule: on the REAL dispatch path (secret-required provenance,
 * `op action=trial.provision`) a SUCCEEDED port result NEVER terminates the
 * operation alone. After the send, the flow must READ_CUSTOMER back through
 * a `TrialReadbackPort`, validate the postconditions
 * (customer exists / is_trial / expires_at future / external_id present),
 * and record the `provider_bindings` row BEFORE the operation may become
 * SUCCEEDED/KNOWN_APPLIED and the trial ACTIVE.
 *
 * - Postcondition failure → `POSTCONDITION_MISMATCH` → HUMAN_REQUIRED
 *   (never SUCCEEDED), with sanitized evidence recorded.
 * - Inconclusive/errored readback → VERIFYING/UNKNOWN (the S3 reconcile
 *   convergence owns what follows); the POST is never re-sent.
 * - Synthetic (echo/manual) flows never consult this gate: they keep the
 *   current direct behavior (dev convenience, documented).
 *
 * The port call itself MUST happen outside any command transaction (like
 * the dispatcher port call): the durable dispatcher resolves the readback
 * between Phase 2 (port call, no tx) and Phase 3 (fenced result write).
 * The inline secret handler shares the same pure decision helper so both
 * paths stay in parity. Only sanitized shapes cross into persistence:
 * status/shape/non-sensitive ids/timestamps — never bearer/cookie/PII or
 * the raw provider payload (the port's free-form `evidence` string is
 * deliberately dropped at the boundary, mirroring the reconcile rule).
 */

/** Raw customer snapshot observed by the readback (provider-shaped). */
export interface TrialCustomerSnapshot {
  /** Whether the provider knows this customer at all. */
  exists: boolean;
  /** Raw `externalId` as observed (validated, never trusted blindly). */
  externalId: unknown;
  /**
   * Raw `is_trial` as observed. The provider contract is not a stable
   * public API (observed: string) — callers MUST NOT read this directly;
   * use `normalizeTrialIsTrial` (§11).
   */
  isTrial: unknown;
  /**
   * Raw `expires_at` as observed. Callers MUST NOT read this directly;
   * use `parseTrialExpiresAt` (§11).
   */
  expiresAt: unknown;
}

export interface TrialReadbackQuery {
  tenantId: string;
  operationId: string;
  trialId: string;
  providerAccountId: string;
  externalRef: string | null;
}

export interface TrialReadbackResult {
  /**
   * `false` (INCONCLUSIVE) means "no proof either way" — the operation
   * stays VERIFYING and must never be coerced to applied/not-applied.
   * When `false`, `customer` carries no proof and is ignored.
   */
  conclusive: boolean;
  customer: TrialCustomerSnapshot | null;
  /**
   * Free-form observation note. NEVER persisted or emitted — only fixed
   * outcome codes cross the boundary (§31).
   */
  evidence: string;
}

export interface TrialReadbackPort {
  readTrialCustomer(query: TrialReadbackQuery): Promise<TrialReadbackResult>;
}

/**
 * Default readback: always INCONCLUSIVE (fail-closed). A secret-required
 * operation can never be proven by this stub — the real CINEVISION
 * readback (or an injected fake in tests) supplies conclusive snapshots.
 * Mirrors the `StubProviderReadback` provenance rule for secret-required
 * operations.
 */
export class StubTrialReadback implements TrialReadbackPort {
  async readTrialCustomer(query: TrialReadbackQuery): Promise<TrialReadbackResult> {
    return {
      conclusive: false,
      customer: null,
      evidence: `stub:INCONCLUSIVE:op=${query.operationId}`,
    };
  }
}

/**
 * SPEC §11 defensive `is_trial` normalization. The internal provider API
 * is not a stable public contract, so the allowlist is explicit and
 * strict: anything outside it normalizes to `null` (unexpected schema →
 * postcondition mismatch, never silent coercion).
 *
 * - `true`: boolean `true`, string `"true"`/`"1"` (trimmed,
 *   case-insensitive), number `1`.
 * - `false`: boolean `false`, string `"false"`/`"0"`, number `0`.
 * - `null`: everything else (including `"yes"`, `"sim"`, objects,
 *   arrays, blanks — strictness is deliberate).
 */
export function normalizeTrialIsTrial(raw: unknown): boolean | null {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "number") {
    if (raw === 1) {
      return true;
    }
    if (raw === 0) {
      return false;
    }
    return null;
  }
  if (typeof raw === "string") {
    const lowered = raw.trim().toLowerCase();
    if (lowered === "true" || lowered === "1") {
      return true;
    }
    if (lowered === "false" || lowered === "0") {
      return false;
    }
    return null;
  }
  return null;
}

/**
 * SPEC §11 defensive `expires_at` parsing. Accepts `Date`, ISO strings
 * and epoch-millis numbers; anything else (including `NaN` dates,
 * objects, blanks) parses to `null` — never a guessed instant.
 */
export function parseTrialExpiresAt(raw: unknown): Date | null {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : new Date(raw.getTime());
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const parsed = new Date(Math.floor(raw));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * External-id presence check for the postcondition (§10/§30: the stable
 * provider id recorded in `provider_bindings`).
 *
 * FASE5-FIX3-R6: conservative observed contract — `^[A-Za-z0-9._:-]{1,64}$`
 * (alphanumerics plus dot/underscore/colon/dash, max 64). No scheme
 * separators (`://`), no whitespace, no `@`, no `;` — so URLs, emails or
 * secret-like material can never pass as a stable id into
 * summary/binding/evidence. Absent OR malformed both fail the postcondition.
 */
const TRIAL_EXTERNAL_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export function normalizeTrialExternalId(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return TRIAL_EXTERNAL_ID_RE.test(trimmed) ? trimmed : null;
}

export type TrialPostconditionReason =
  | "readback_absent"
  | "readback_inconclusive"
  | "customer_missing"
  | "external_id_missing"
  | "not_trial"
  | "expires_at_invalid"
  | "expires_at_past";

export interface TrialPostconditionSatisfied {
  ok: true;
  normalized: { externalId: string; expiresAt: Date };
}

export interface TrialPostconditionViolated {
  ok: false;
  reason: TrialPostconditionReason;
}

export type TrialPostconditionVerdict = TrialPostconditionSatisfied | TrialPostconditionViolated;

/**
 * Pure SPEC §25 postcondition evaluation over an already-obtained
 * readback (no I/O — safe inside a result transaction). ALL must hold:
 * (a) customer exists, (b) `is_trial` normalizes to true, (c) `expires_at`
 * parses and is strictly future (`> now + minFutureMs`), (d) a stable
 * external id is present.
 *
 * - `null`/absent readback → `readback_absent`; inconclusive → 
 *   `readback_inconclusive`. Both mean VERIFYING/UNKNOWN downstream.
 * - Any violated postcondition → its reason (HUMAN_REQUIRED with
 *   `POSTCONDITION_MISMATCH` downstream).
 */
export function evaluateTrialProvisionPostconditions(
  readback: TrialReadbackResult | null | undefined,
  opts?: { now?: Date; minFutureMs?: number },
): TrialPostconditionVerdict {
  if (readback === null || readback === undefined) {
    return { ok: false, reason: "readback_absent" };
  }
  if (readback.conclusive !== true || readback.customer === null) {
    return { ok: false, reason: "readback_inconclusive" };
  }
  const customer = readback.customer;
  if (customer.exists !== true) {
    return { ok: false, reason: "customer_missing" };
  }
  const externalId = normalizeTrialExternalId(customer.externalId);
  if (externalId === null) {
    return { ok: false, reason: "external_id_missing" };
  }
  if (normalizeTrialIsTrial(customer.isTrial) !== true) {
    return { ok: false, reason: "not_trial" };
  }
  const expiresAt = parseTrialExpiresAt(customer.expiresAt);
  if (expiresAt === null) {
    return { ok: false, reason: "expires_at_invalid" };
  }
  const nowMs = opts?.now instanceof Date ? opts.now.getTime() : Date.now();
  const minFutureMs = opts?.minFutureMs ?? 0;
  if (!(expiresAt.getTime() > nowMs + minFutureMs)) {
    return { ok: false, reason: "expires_at_past" };
  }
  return { ok: true, normalized: { externalId, expiresAt } };
}

/**
 * Whether a postcondition verdict keeps the operation uncertain
 * (VERIFYING/UNKNOWN, S3 convergence owns the rest) instead of parking
 * a `POSTCONDITION_MISMATCH` (HUMAN_REQUIRED). Only conclusive
 * readbacks with a concrete violated postcondition mismatch; absent or
 * inconclusive readbacks stay uncertain — never a mismatch claim without
 * proof.
 */
export function isTrialPostconditionMismatch(reason: TrialPostconditionReason): boolean {
  return reason !== "readback_absent" && reason !== "readback_inconclusive";
}

/** Default: any strictly-future `expires_at` satisfies (c). */
export const DEFAULT_TRIAL_READBACK_MIN_FUTURE_MS = 0;

/**
 * Minimum future margin for postcondition (c), in milliseconds
 * (`PROVIDER_TRIAL_READBACK_MIN_FUTURE_MS`, call time like the other
 * provider env seams). The default accepts any strictly-future instant;
 * operators may demand a larger margin. Garbage/negative input falls
 * back to the default; capped at 1 hour to keep the gate sane.
 */
export function trialReadbackMinFutureMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env["PROVIDER_TRIAL_READBACK_MIN_FUTURE_MS"]);
  if (!Number.isFinite(raw) || raw < 0) {
    return DEFAULT_TRIAL_READBACK_MIN_FUTURE_MS;
  }
  return Math.min(Math.floor(raw), 3_600_000);
}

/** Canonical `POSTCONDITION_MISMATCH` error code (SPEC §18, no new enums). */
export const TRIAL_POSTCONDITION_MISMATCH_CODE = "POSTCONDITION_MISMATCH";

/** Canonical sanitized evidence type for the readback gate (§31). */
export const TRIAL_READBACK_EVIDENCE_TYPE = "TRIAL_READBACK_POSTCONDITION";

/** Default READ_CUSTOMER budget in milliseconds (SPEC §35). */
export const DEFAULT_TRIAL_READBACK_TIMEOUT_MS = 30_000;

/**
 * READ_CUSTOMER budget in milliseconds (SPEC §35: every external operation
 * has a finite budget; a timeout after a potential write means UNKNOWN,
 * never FAILED/`KNOWN_NOT_APPLIED`). Same shape as the port-call budget
 * (`providerDispatchTimeoutMsFromEnv`): read at call time, falls back to
 * 30s on missing/garbage input, capped at 300s.
 */
export function trialReadbackTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env["PROVIDER_TRIAL_READBACK_TIMEOUT_MS"]);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TRIAL_READBACK_TIMEOUT_MS;
  }
  return Math.min(Math.floor(raw), 300_000);
}

/**
 * Bounded READ_CUSTOMER consult (SPEC §35, same pattern as `racePortCall`).
 * Resolves `null` (INCONCLUSIVE → VERIFYING/UNKNOWN downstream) when the
 * budget lapses AND when the port throws — the POST is never re-sent and
 * the throw never propagates into a transaction rollback. Never rejects.
 */
export function raceTrialReadback(
  port: TrialReadbackPort,
  query: TrialReadbackQuery,
  timeoutMs: number,
): Promise<TrialReadbackResult | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(Math.floor(timeoutMs), 1));
    void Promise.resolve()
      .then(() => port.readTrialCustomer(query))
      .then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        () => {
          clearTimeout(timer);
          resolve(null);
        },
      );
  });
}
