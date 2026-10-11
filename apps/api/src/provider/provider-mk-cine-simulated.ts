/**
 * MK + CINEVISION SIMULATED write seam for the API provider surface.
 *
 * Credential-independent engineering (PROV-MK-CINE-01): typed
 * write-operation envelopes, lease/fencing plumbing reusing the migration
 * 045 dispatch-lease shape, idempotency keys, timeout→UNKNOWN
 * classification, readback + reconciliation hooks, and audit entries.
 *
 * Explicitly SIMULATED: both ports below implement the existing
 * `ProviderOpsPort` contract against in-memory ledgers keyed by
 * idempotency key (single-effect guarantee). They are NOT wired into
 * `resolveOpsPort` (which stays `echo | manual`) nor into the dispatcher
 * claim filter (which stays `secret-required-v1`): no architecture change,
 * no new live path. Anything unobserved stays a typed seam.
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

export const MK_CINE_SIMULATED_VERSION = "mk-cine-write-simulated-v1" as const;

export type SimulatedWriteKind = "mk" | "cinevision";

export type SimulatedWriteBehavior =
  | "success"
  | "failure"
  | "unknown"
  | "timeout"
  | "no_authz";

export interface SimulatedWriteAuditEntry {
  kind: SimulatedWriteKind;
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
export function classifySimulatedWriteTimeout(kind: SimulatedWriteKind, action: string): AdapterResult {
  return {
    outcome: "UNKNOWN",
    detail: `${kind}: ${action} timed out after potential effect, verify before retry (SIMULATED)`,
    externalRef: null,
  };
}

function behaviorResult(
  kind: SimulatedWriteKind,
  action: string,
  behavior: SimulatedWriteBehavior,
  input: ProviderOperationRequest,
): AdapterResult {
  switch (behavior) {
    case "success":
      return {
        outcome: "SUCCEEDED",
        detail: `${kind}: synthetic write success (SIMULATED)`,
        externalRef: `${kind}-sim-${input.entityType}-${input.entityId}`,
      };
    case "failure":
      return { outcome: "FAILED", detail: `${kind}: synthetic write refused (SIMULATED)`, externalRef: null };
    case "unknown":
    case "timeout":
      return classifySimulatedWriteTimeout(kind, action);
    case "no_authz":
      return {
        outcome: "MANUAL",
        detail: `${kind}: not authorized, operator approval required (SIMULATED)`,
        externalRef: null,
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
 * Base SIMULATED write port: single-effect ledger keyed by idempotency key.
 * Replays return the recorded outcome with NO new mutation. Requires a
 * secret ref at the type level (`requiresSecretRef: true`) so any future
 * wiring must pass the secret gate — but this class itself never resolves
 * or carries a value.
 */
export abstract class SimulatedWritePortBase implements ProviderOpsPort {
  abstract readonly name: string;
  readonly requiresSecretRef = true;
  readonly audit: SimulatedWriteAuditEntry[] = [];
  private readonly ledger = new Map<string, AdapterResult>();
  private effects = 0;
  /** Number of `sendOnce` attempts (including absorbed replays). */
  sendAttempts = 0;

  constructor(
    protected readonly kind: SimulatedWriteKind,
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

  async requestOperation(input: ProviderOperationRequest): Promise<AdapterResult> {
    if (!validateSimulatedWriteKey(input.idempotencyKey)) {
      return this.park(input, "invalid idempotency key");
    }
    const raced = await withTimeout(this.sendOnce(input), this.timeoutMs);
    if (raced === null) {
      return this.park(input, "timeout budget lapsed, verify before retry", classifySimulatedWriteTimeout(this.kind, input.action));
    }
    if (raced.duplicate && raced.result.outcome === "UNKNOWN") {
      return this.park(input, "replay of uncertain effect, operator must verify");
    }
    this.writeAudit(input, raced.result);
    return raced.result;
  }

  private async sendOnce(input: ProviderOperationRequest): Promise<{ result: AdapterResult; duplicate: boolean }> {
    this.sendAttempts += 1;
    const prior = this.ledger.get(input.idempotencyKey);
    if (prior !== undefined) {
      return { result: prior, duplicate: true };
    }
    if (this.behavior === "timeout") {
      await new Promise<never>(() => undefined);
    }
    const result = behaviorResult(this.kind, input.action, this.behavior, input);
    this.ledger.set(input.idempotencyKey, result);
    if (result.outcome === "SUCCEEDED") this.effects += 1;
    return { result, duplicate: false };
  }

  private park(input: ProviderOperationRequest, reason: string, result?: AdapterResult): AdapterResult {
    const parked: AdapterResult = result ?? {
      outcome: "MANUAL",
      detail: `${this.kind}: parked for operator: ${reason} (SIMULATED)`,
      externalRef: null,
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

/** SIMULATED MK write port (purchase/activation surface, no live calls). */
export class MkSimulatedWritePort extends SimulatedWritePortBase {
  readonly name = "mk-simulated";
  constructor(behavior: SimulatedWriteBehavior = "success", timeoutMs = 30_000) {
    super("mk", behavior, timeoutMs);
  }
}

/** SIMULATED CINEVISION write port (typed write ops, no live calls). */
export class CinevisionSimulatedWritePort extends SimulatedWritePortBase {
  readonly name = "cinevision-write-simulated";
  constructor(behavior: SimulatedWriteBehavior = "success", timeoutMs = 30_000) {
    super("cinevision", behavior, timeoutMs);
  }
}

/**
 * SIMULATED readback for write seams: answers from the port ledger shape
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
