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
}

export type AdapterOutcome = "SUCCEEDED" | "FAILED" | "UNKNOWN" | "MANUAL";

export interface AdapterResult {
  outcome: AdapterOutcome;
  detail: string;
  externalRef: string | null;
}

export interface ProviderOpsPort {
  readonly name: string;
  requestOperation(input: ProviderOperationRequest): Promise<AdapterResult>;
}

export type EchoOutcome = "success" | "failed" | "unknown";

/** Read the deterministic echo mode (call time, so tests can set per case). */
export function echoOutcomeFromEnv(): EchoOutcome {
  const raw = (process.env["PROVIDER_ECHO_OUTCOME"] ?? "success").trim().toLowerCase();
  return raw === "failed" || raw === "unknown" ? raw : "success";
}

/** Deterministic synthetic adapter: no network, no credentials. */
export class EchoProviderOpsAdapter implements ProviderOpsPort {
  readonly name = "echo";

  async requestOperation(input: ProviderOperationRequest): Promise<AdapterResult> {
    const forced = input.payload["__echo_outcome"];
    const mode: EchoOutcome =
      forced === "failed" || forced === "unknown" || forced === "success"
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

/** Readback port: verifies the ACTUAL external effect of an uncertain op. */
export interface ReadbackQuery {
  tenantId: string;
  operationId: string;
  action: string;
  externalRef: string | null;
}

export interface ReadbackResult {
  effectApplied: boolean;
  evidence: string;
}

export interface ProviderReadbackPort {
  verify(query: ReadbackQuery): Promise<ReadbackResult>;
}

/**
 * Stub readback: answers from `PROVIDER_READBACK_EFFECT` (`APPLIED` or
 * anything else = not applied; safe default NOT_APPLIED). The real
 * CINEVISION readback implements this port after Wave-0 certification.
 * Reconcile NEVER re-executes the operation — it only records what the
 * readback observed.
 */
export class StubProviderReadback implements ProviderReadbackPort {
  async verify(query: ReadbackQuery): Promise<ReadbackResult> {
    const raw = (process.env["PROVIDER_READBACK_EFFECT"] ?? "NOT_APPLIED").trim().toUpperCase();
    const effectApplied = raw === "APPLIED";
    return {
      effectApplied,
      evidence: `stub:${raw}:op=${query.operationId}`,
    };
  }
}
