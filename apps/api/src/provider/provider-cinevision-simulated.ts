/**
 * CINEVISION SIMULATED write seam for the API provider surface.
 *
 * Credential-independent engineering: typed write-operation envelope,
 * lease/fencing plumbing reusing the migration 045 dispatch-lease shape,
 * idempotency keys with operation/payload fingerprinting, timeout→UNKNOWN
 * classification, readback + reconciliation hooks, and audit entries.
 *
 * Explicitly SIMULATED: the port below implements the existing
 * `ProviderOpsPort` contract against an in-memory ledger keyed by
 * idempotency key (single-effect guarantee). Reusing a key for a DIVERGENT
 * operation/payload parks MANUAL as a conflict — never a new effect, never
 * a ledger overwrite. It is NOT wired into `resolveOpsPort` (which stays
 * `echo | manual`) nor into the dispatcher claim filter (which stays
 * `secret-required-v1`): no architecture change, no new live path.
 * Anything unobserved stays a typed seam. Every result carries an explicit
 * `simulated: true` marker.
 */

import { randomUUID } from "node:crypto";
import type {
  AdapterResult,
  ProviderOperationRequest,
  ProviderOpsPort,
  ProviderReadbackPort,
  ReadbackQuery,
  ReadbackResult,
} from "./provider-port.js";

export const CINEVISION_SIMULATED_VERSION = "cinevision-write-simulated-v1" as const;

/** API adapter result with the explicit SIMULATED envelope marker. */
export type CinevisionSimulatedAdapterResult = AdapterResult & { simulated: true };

export type SimulatedWriteBehavior =
  | "success"
  | "failure"
  | "unknown"
  | "timeout"
  | "no_authz";

export interface SimulatedWriteAuditEntry {
  kind: "cinevision";
  action: string;
  outcome: string;
  /** Idempotency-key prefix only — never the full key. */
  idempotencyPrefix: string;
  /** Fencing-token prefix only. */
  fencingPrefix: string;
  detail: string;
  simulated: true;
}

const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._:=-]{0,127}$/;

export function validateSimulatedWriteKey(idempotencyKey: unknown): boolean {
  return typeof idempotencyKey === "string" && IDEMPOTENCY_RE.test(idempotencyKey);
}

/**
 * Fencing-token minter with the same shape as the dispatcher claim tokens
 * (`<worker>:<uuid>`, one token per acquisition — never reused). Thin local
 * copy so this seam stays dependency-free (no import cycle with the
 * dispatcher service).
 */
export function buildSimulatedFencingToken(worker: string, id: string = randomUUID()): string {
  return `${worker}:${id}`;
}

/**
 * Timeout classification: a port call that outlives its budget AFTER a
 * potential effect is UNKNOWN — never FAILED, never a silent re-send.
 */
export function classifySimulatedWriteTimeout(action: string): CinevisionSimulatedAdapterResult {
  return {
    outcome: "UNKNOWN",
    detail: `cinevision: ${action} timed out after potential effect, verify before retry (SIMULATED)`,
    externalRef: null,
    simulated: true,
  };
}

/** Stable (key-order-independent) JSON for fingerprinting. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

/**
 * Operation/payload fingerprint bound to an idempotency key. Replaying the
 * SAME key with a DIVERGENT fingerprint is a conflict (parked MANUAL),
 * never a silent success replay — a bare key match alone must not claim
 * another operation's outcome.
 */
export function buildSimulatedWriteFingerprint(input: ProviderOperationRequest): string {
  return `${input.action}|${input.entityType}|${input.entityId}|${stableJson(input.payload)}`;
}

function behaviorResult(
  action: string,
  behavior: SimulatedWriteBehavior,
  input: ProviderOperationRequest,
): CinevisionSimulatedAdapterResult {
  switch (behavior) {
    case "success":
      return {
        outcome: "SUCCEEDED",
        detail: `cinevision: synthetic write success (SIMULATED)`,
        externalRef: `cinevision-sim-${input.entityType}-${input.entityId}`,
        simulated: true,
      };
    case "failure":
      return {
        outcome: "FAILED",
        detail: `cinevision: synthetic write refused (SIMULATED)`,
        externalRef: null,
        simulated: true,
      };
    case "unknown":
    case "timeout":
      return classifySimulatedWriteTimeout(action);
    case "no_authz":
      return {
        outcome: "MANUAL",
        detail: `cinevision: not authorized, operator approval required (SIMULATED)`,
        externalRef: null,
        simulated: true,
      };
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(Math.floor(timeoutMs), 1));
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * SIMULATED CINEVISION write port: single-effect ledger keyed by idempotency
 * key with operation/payload fingerprinting. Replays return the recorded
 * outcome with NO new mutation; divergent reuse parks MANUAL as a conflict.
 * Requires a secret ref at the type level (`requiresSecretRef: true`) so any
 * future wiring must pass the secret gate — but this class itself never
 * resolves or carries a value.
 */
export abstract class SimulatedWritePortBase implements ProviderOpsPort {
  abstract readonly name: string;
  readonly requiresSecretRef = true;
  readonly audit: SimulatedWriteAuditEntry[] = [];
  private readonly ledger = new Map<string, { result: CinevisionSimulatedAdapterResult; fingerprint: string }>();
  private effects = 0;
  /** Number of `sendOnce` attempts (including absorbed replays). */
  sendAttempts = 0;

  protected readonly kind = "cinevision" as const;

  constructor(
    protected behavior: SimulatedWriteBehavior = "success",
    protected timeoutMs = 30_000,
  ) {}

  setBehavior(behavior: SimulatedWriteBehavior): void {
    this.behavior = behavior;
  }

  get effectCount(): number {
    return this.effects;
  }

  get ledgerSize(): number {
    return this.ledger.size;
  }

  async requestOperation(input: ProviderOperationRequest): Promise<CinevisionSimulatedAdapterResult> {
    if (!validateSimulatedWriteKey(input.idempotencyKey)) {
      return this.park(input, "invalid idempotency key");
    }
    const raced = await withTimeout(this.sendOnce(input), this.timeoutMs);
    if (raced === null) {
      return this.park(input, "timeout budget lapsed, verify before retry", classifySimulatedWriteTimeout(input.action));
    }
    if (raced.duplicate && raced.result.outcome === "UNKNOWN") {
      return this.park(input, "replay of uncertain effect, operator must verify");
    }
    this.writeAudit(input, raced.result);
    return raced.result;
  }

  private async sendOnce(
    input: ProviderOperationRequest,
  ): Promise<{ result: CinevisionSimulatedAdapterResult; duplicate: boolean }> {
    this.sendAttempts += 1;
    const fingerprint = buildSimulatedWriteFingerprint(input);
    const prior = this.ledger.get(input.idempotencyKey);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) {
        return {
          result: {
            outcome: "MANUAL",
            detail: `cinevision: idempotency key reuse with divergent operation/payload, operator must verify (SIMULATED)`,
            externalRef: null,
            simulated: true,
          },
          duplicate: true,
        };
      }
      return { result: prior.result, duplicate: true };
    }
    // Reserve the key BEFORE the effect so a timeout preserves uncertainty:
    // the ledger holds UNKNOWN/VERIFYING while the send is in flight, and a
    // retry of the same key replays that uncertain record (parks MANUAL for
    // verification) instead of re-executing the send.
    this.ledger.set(input.idempotencyKey, {
      result: classifySimulatedWriteTimeout(input.action),
      fingerprint,
    });
    if (this.behavior === "timeout") {
      await new Promise<never>(() => undefined);
    }
    const result = behaviorResult(input.action, this.behavior, input);
    this.ledger.set(input.idempotencyKey, { result, fingerprint });
    if (result.outcome === "SUCCEEDED") this.effects += 1;
    return { result, duplicate: false };
  }

  private park(
    input: ProviderOperationRequest,
    reason: string,
    result?: CinevisionSimulatedAdapterResult,
  ): CinevisionSimulatedAdapterResult {
    const parked: CinevisionSimulatedAdapterResult = result ?? {
      outcome: "MANUAL",
      detail: `cinevision: parked for operator: ${reason} (SIMULATED)`,
      externalRef: null,
      simulated: true,
    };
    this.writeAudit(input, parked);
    return parked;
  }

  private writeAudit(input: ProviderOperationRequest, result: AdapterResult): void {
    const fencing = typeof input.correlationId === "string" ? input.correlationId : "";
    this.audit.push({
      kind: this.kind,
      action: input.action,
      outcome: result.outcome,
      idempotencyPrefix: input.idempotencyKey.slice(0, 8),
      fencingPrefix: fencing.slice(0, 8),
      detail: result.detail,
      simulated: true,
    });
  }
}

/** SIMULATED CINEVISION write port (typed write ops, no live calls). */
export class CinevisionSimulatedWritePort extends SimulatedWritePortBase {
  readonly name = "cinevision-write-simulated";
  constructor(behavior: SimulatedWriteBehavior = "success", timeoutMs = 30_000) {
    super(behavior, timeoutMs);
  }
}

/**
 * SIMULATED readback for the write seam: answers from the port ledger shape
 * (`APPLIED` / `NOT_APPLIED` conclusive, anything else INCONCLUSIVE).
 * Never re-executes the operation.
 */
export class SimulatedWriteReadback implements ProviderReadbackPort {
  constructor(private readonly appliedKeys: Set<string> = new Set()) {}

  markApplied(operationId: string): void {
    this.appliedKeys.add(operationId);
  }

  async verify(query: ReadbackQuery): Promise<ReadbackResult> {
    if (this.appliedKeys.has(query.operationId)) {
      return { effectApplied: true, evidence: `simulated:applied:${query.operationId}`, conclusive: true };
    }
    const raw = process.env["PROVIDER_SIMULATED_WRITE_READBACK"] ?? "";
    const normalized = raw.trim().toUpperCase();
    if (normalized === "APPLIED") {
      return { effectApplied: true, evidence: `simulated:APPLIED:${query.operationId}`, conclusive: true };
    }
    if (normalized === "NOT_APPLIED") {
      return { effectApplied: false, evidence: `simulated:NOT_APPLIED:${query.operationId}`, conclusive: true };
    }
    return { effectApplied: false, evidence: `simulated:INCONCLUSIVE:${query.operationId}`, conclusive: false };
  }
}
