/**
 * Provider operations port (Wave 4).
 *
 * The real CINEVISION integration is Wave-0-gated (no credentials anywhere
 * in this codebase), so the ONLY implementations shipped here are:
 * - `EchoProviderOpsAdapter`: deterministic synthetic terminal outcomes for
 *   tests and local flows (success / failure / unknown effect).
 * - `ManualProviderOpsAdapter`: parks the operation in `HUMAN_REQUIRED`;
 *   a provider operator resolves it later via `provider.resolve_operation`.
 *
 * Selection: `PROVIDER_OPS_ADAPTER=echo|manual` (default `manual`); a
 * per-command `adapter` input overrides the env for that call (test seam).
 * When the `provider.cinevision` capability row exists and is UNAVAILABLE,
 * callers force MANUAL regardless of the requested adapter.
 */

export interface ProviderOperationRequest {
  tenantId: string;
  providerAccountId: string;
  action: string;
  entityType: string;
  entityId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  correlationId: string;
  /**
   * PF-05: validated `secret_ref` STRING for secret-requiring (future
   * BROWSER) adapters only. In-memory frontier field — never persisted to
   * `requested_payload_json`, events or audit. Carries the ref, never a
   * secret value. Echo/manual never set it.
   */
  secretRef?: string;
}

export type AdapterOutcome = "SUCCEEDED" | "FAILED" | "UNKNOWN" | "MANUAL";

export interface AdapterResult {
  outcome: AdapterOutcome;
  detail: string;
  externalRef: string | null;
}

export interface ProviderOpsPort {
  readonly name: string;
  /**
   * PF-05: set `true` only on future real (BROWSER) adapters that need a
   * provider secret. Echo/manual omit it (falsy) so synthetic flows never
   * hit the secret gate. The gate also treats a port named `browser`
   * (case-insensitive) as secret-requiring as defense-in-depth.
   */
  readonly requiresSecretRef?: boolean;
  requestOperation(input: ProviderOperationRequest): Promise<AdapterResult>;
}

export type EchoOutcome = "success" | "failed" | "unknown" | "drift";

/** Read the deterministic echo mode (call time, so tests can set per case). */
export function echoOutcomeFromEnv(): EchoOutcome {
  const raw = (process.env["PROVIDER_ECHO_OUTCOME"] ?? "success").trim().toLowerCase();
  if (raw === "failed" || raw === "unknown" || raw === "drift") {
    return raw;
  }
  return "success";
}

/** Deterministic synthetic adapter: no network, no credentials. */
export class EchoProviderOpsAdapter implements ProviderOpsPort {
  readonly name = "echo";

  async requestOperation(input: ProviderOperationRequest): Promise<AdapterResult> {
    const forced = input.payload["__echo_outcome"];
    const mode: EchoOutcome =
      forced === "failed" || forced === "unknown" || forced === "success" || forced === "drift"
        ? forced
        : echoOutcomeFromEnv();
    if (mode === "success") {
      return {
        outcome: "SUCCEEDED",
        detail: "echo: synthetic success",
        externalRef: `echo-${input.entityType}-${input.entityId}`,
      };
    }
    if (mode === "failed") {
      return { outcome: "FAILED", detail: "echo: synthetic failure", externalRef: null };
    }
    if (mode === "drift") {
      return { outcome: "UNKNOWN", detail: "echo: synthetic DOM drift, degraded, verify before retry", externalRef: null };
    }
    return { outcome: "UNKNOWN", detail: "echo: synthetic unknown effect", externalRef: null };
  }
}

/** Manual adapter: every operation parks in HUMAN_REQUIRED. */
export class ManualProviderOpsAdapter implements ProviderOpsPort {
  readonly name = "manual";

  async requestOperation(): Promise<AdapterResult> {
    return { outcome: "MANUAL", detail: "manual: awaiting provider operator", externalRef: null };
  }
}

export function adapterNameFromEnv(): "echo" | "manual" {
  return process.env["PROVIDER_OPS_ADAPTER"] === "echo" ? "echo" : "manual";
}

/**
 * Durable post-commit dispatch mode (CV-DSP-01, migration 045).
 *
 * - `durable`: the secret-required `provider.request_operation` path commits
 *   the REQUESTED operation + `operation_requested` event and returns QUEUED
 *   WITHOUT calling the port; `ProviderDispatcherService.drainOnce` claims
 *   it later (SKIP LOCKED + lease), marks the send frontier
 *   (`dispatch_started_at`) and only then calls the port.
 * - anything else (unset included) = `inline`: the current behavior —
 *   the port call happens inside the request transaction.
 *
 * Read at call time (like `adapterNameFromEnv`) so tests flip it per case.
 */
export type ProviderDispatchMode = "durable" | "inline";

export function providerDispatchModeFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderDispatchMode {
  return env["PROVIDER_DISPATCH_MODE"] === "durable" ? "durable" : "inline";
}

/**
 * Dispatch send timeout in milliseconds (CV-DSP-01). A port call that
 * outlives this budget AFTER `dispatch_started_at` was persisted parks the
 * operation in VERIFYING/UNKNOWN for readback — never FAILED. Read at call
 * time; falls back to 30000 on missing/garbage input.
 */
export function providerDispatchTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env["PROVIDER_DISPATCH_TIMEOUT_MS"]);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 30_000;
  }
  return Math.min(Math.floor(raw), 300_000);
}

/**
 * Dispatch claim lease in milliseconds (CV-DSP-01): how long a claimed
 * operation stays owned before `recoverOnce` may release (pre-send) or park
 * it (post-send). Read at call time; defaults to 300000 (5 minutes).
 */
export function providerDispatchLeaseMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env["PROVIDER_DISPATCH_LEASE_MS"]);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 300_000;
  }
  return Math.min(Math.floor(raw), 3_600_000);
}

export function resolveOpsPort(name: "echo" | "manual"): ProviderOpsPort {
  return name === "echo" ? new EchoProviderOpsAdapter() : new ManualProviderOpsAdapter();
}

export interface CapabilityGate {
  availability: string;
  certificationStatus: string;
}

/**
 * Wave-0 capability gate (pure, unit-tested): an UNAVAILABLE
 * `provider.cinevision` capability forces MANUAL no matter what was
 * requested; otherwise the requested adapter stands and the capability
 * state is recorded as provenance.
 */
export function applyCapabilityGate(
  requested: "echo" | "manual",
  capability: CapabilityGate | null,
): { name: "echo" | "manual"; note: string } {
  if (capability === null) {
    return { name: requested, note: "capability_not_catalogued" };
  }
  if (capability.availability === "UNAVAILABLE") {
    return { name: "manual", note: "capability_unavailable_forced_manual" };
  }
  return { name: requested, note: `capability_${capability.availability}_${capability.certificationStatus}` };
}

/**
 * PF-05 (MVP-PF05-SECRETREF-04): branch-derived provenance discriminator for
 * secret-required operations. The secret-required branches persist this
 * RESERVED constant as `adapter_version` — never `${port.name}-v1` — so a
 * fake secret-requiring port named `manual`/`echo` can never be mistaken for
 * a synthetic echo/manual operation by cancel/readback provenance checks,
 * regardless of the port name. Independent of any port name by design.
 */
export const SECRET_REQUIRED_ADAPTER_VERSION = "secret-required-v1";

/** Readback port: verifies the ACTUAL external effect of an uncertain op. */
export interface ReadbackQuery {
  tenantId: string;
  operationId: string;
  action: string;
  externalRef: string | null;
  /**
   * PF-05 (MVP-PF05-SECRETREF-03): operation provenance for the stub gate.
   * Callers on the provider reconcile path MUST pass the persisted
   * `requested_payload.adapter` and `adapter_version` so the stub can tell
   * synthetic (echo/manual) operations apart from secret-required/real ones.
   * When present, the stub applies strict rules: unset env is INCONCLUSIVE
   * and an explicit APPLIED/NOT_APPLIED is conclusive ONLY for synthetic
   * operations. Legacy callers without provenance (inventory/license, out of
   * PF-05 scope) keep the prior defaults until migrated.
   */
  adapter?: string | null;
  adapterVersion?: string | null;
}

export interface ReadbackResult {
  effectApplied: boolean;
  evidence: string;
  /**
   * Wave 7 review fix F6: whether the readback produced conclusive
   * evidence. `false` (INCONCLUSIVE) means "no proof either way" — the
   * operation stays VERIFYING and the finding stays OPEN. It must never
   * be coerced to applied/not-applied.
   */
  conclusive: boolean;
}

export interface ProviderReadbackPort {
  verify(query: ReadbackQuery): Promise<ReadbackResult>;
}

/**
 * PF-05 (MVP-PF05-SECRETREF-03/04/05): synthetic-operation provenance check
 * for the stub readback gate. True only for the EXACT pairs written
 * internally by the echo/manual branches — `(echo, echo-v1)` or
 * `(manual, manual-v1)` (case-insensitive). Everything else is ambiguous
 * and therefore NOT synthetic: null/blank/missing version, legacy or
 * mismatched versions, prefix/suffix spoofs (`echo-v2`, `manual-x`,
 * `echo-v1-extra`), unknown adapters, and the reserved
 * `secret-required-v1` version all return false (inconclusive, never
 * resolved by this stub).
 */
export function isSyntheticReadbackSubject(input: {
  adapter?: string | null;
  adapterVersion?: string | null;
}): boolean {
  const version = typeof input.adapterVersion === "string" ? input.adapterVersion.toLowerCase() : "";
  const adapter = typeof input.adapter === "string" ? input.adapter.toLowerCase() : "";
  if (adapter === "echo") {
    return version === "echo-v1";
  }
  if (adapter === "manual") {
    return version === "manual-v1";
  }
  return false;
}

/**
 * Stub readback: answers from `PROVIDER_READBACK_EFFECT` (`APPLIED` =
 * conclusively applied, `NOT_APPLIED` = conclusively not applied,
 * `UNKNOWN` or any other value = INCONCLUSIVE, no proof either way).
 * The real CINEVISION readback implements this port after Wave-0
 * certification. Reconcile NEVER re-executes the operation — it only
 * records what the readback observed.
 *
 * PF-05 (MVP-PF05-SECRETREF-03) provenance gate: when the caller supplies
 * operation provenance (`adapter`/`adapterVersion`, always set on the
 * provider reconcile path), strict rules apply —
 * - unset/blank `PROVIDER_READBACK_EFFECT` is INCONCLUSIVE (never a
 *   default `effectApplied:false/conclusive:true`), and
 * - an explicit `APPLIED`/`NOT_APPLIED` is conclusive ONLY for synthetic
 *   echo/manual operations; secret-required/real operations stay
 *   INCONCLUSIVE no matter what the env configures.
 * Callers without provenance (inventory/license, out of PF-05 scope) keep
 * the legacy defaults so their existing flows stay green.
 */
export class StubProviderReadback implements ProviderReadbackPort {
  async verify(query: ReadbackQuery): Promise<ReadbackResult> {
    const hasProvenance = query.adapter !== undefined || query.adapterVersion !== undefined;
    const envRaw = process.env["PROVIDER_READBACK_EFFECT"];
    if (!hasProvenance) {
      const raw = (envRaw ?? "NOT_APPLIED").trim().toUpperCase();
      if (raw === "APPLIED") {
        return { effectApplied: true, evidence: `stub:${raw}:op=${query.operationId}`, conclusive: true };
      }
      if (raw === "NOT_APPLIED") {
        return { effectApplied: false, evidence: `stub:${raw}:op=${query.operationId}`, conclusive: true };
      }
      return { effectApplied: false, evidence: `stub:${raw}:op=${query.operationId}`, conclusive: false };
    }
    const raw = (envRaw ?? "").trim().toUpperCase();
    if (
      (raw === "APPLIED" || raw === "NOT_APPLIED") &&
      isSyntheticReadbackSubject({ adapter: query.adapter ?? null, adapterVersion: query.adapterVersion ?? null })
    ) {
      return {
        effectApplied: raw === "APPLIED",
        evidence: `stub:${raw}:op=${query.operationId}`,
        conclusive: true,
      };
    }
    return { effectApplied: false, evidence: `stub:INCONCLUSIVE:op=${query.operationId}`, conclusive: false };
  }
}

/** Default generic effect-readback budget in milliseconds (SPEC §35). */
export const DEFAULT_GENERIC_READBACK_TIMEOUT_MS = 30_000;

/**
 * Generic effect-readback budget in milliseconds (SPEC §35: every external
 * operation has a finite budget; a timeout after a potential effect means
 * UNKNOWN, never a terminal claim). Same shape as the sibling budgets
 * (`providerDispatchTimeoutMsFromEnv`, `trialReadbackTimeoutMsFromEnv`):
 * read at call time, falls back to 30s on missing/garbage input, capped at
 * 300s.
 */
export function genericReadbackTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env["PROVIDER_GENERIC_READBACK_TIMEOUT_MS"]);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_GENERIC_READBACK_TIMEOUT_MS;
  }
  return Math.min(Math.floor(raw), 300_000);
}

/**
 * Bounded generic effect-readback consult (SPEC §35, same pattern as
 * `racePortCall`/`raceTrialReadback`). Resolves `null` (INCONCLUSIVE →
 * HUMAN_REQUIRED downstream via the shared reconcile decision) when the
 * budget lapses AND when the port throws — a hanging verify can never wedge
 * the caller (scheduler tick, admin drain), and the throw never propagates.
 * Never rejects.
 */
export function raceGenericReadback(
  port: ProviderReadbackPort,
  query: ReadbackQuery,
  timeoutMs: number,
): Promise<ReadbackResult | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(Math.floor(timeoutMs), 1));
    void Promise.resolve()
      .then(() => port.verify(query))
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
