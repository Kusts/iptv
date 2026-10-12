/**
 * CINEVISION SIMULATED write external + skeleton adapter.
 *
 * Explicitly SIMULATED: an in-memory ledger keyed by idempotency key with
 * a single-effect guarantee (replays return the recorded outcome, no new
 * mutation). Failure injection covers negative tests: no-authz, timeout,
 * session-expired, browser-disconnected, crash-after-effect.
 *
 * No endpoints/params/payloads are invented: the "send" is a ledger insert
 * and the "readback" is a ledger lookup. Anything needing a live panel is
 * marked LIVE_NEEDED in tests, never simulated as proof.
 */

import {
  cinevisionWriteAuditFor,
  cinevisionWriteManual,
  classifyCinevisionWriteTimeout,
  decideCinevisionWriteReconcile,
  validateCinevisionWriteInput,
  type CinevisionReconcileDecision,
  type CinevisionWriteAction,
  type CinevisionWriteAuditEntry,
  type CinevisionWriteInput,
  type CinevisionWriteReadbackQuery,
  type CinevisionWriteReadbackResult,
  type CinevisionWriteResult,
} from "./writes.js";

export type SimulatedWriteBehavior =
  | "success"
  | "failure"
  | "unknown"
  | "timeout"
  | "no_authz"
  | "session_expired"
  | "browser_disconnected"
  | "crash_after_effect";

export interface SimulatedWriteResponse {
  result: CinevisionWriteResult;
  duplicate: boolean;
}

export class InMemorySimulatedCinevisionWriteExternal {
  private readonly ledger = new Map<string, CinevisionWriteResult>();
  /** Operation identity per key (action + ref) so readback can validate. */
  private readonly meta = new Map<string, { action: CinevisionWriteAction; externalRef: string | null }>();
  private effects = 0;
  readonly sends: Array<{ action: CinevisionWriteAction; idempotencyKey: string; behavior: SimulatedWriteBehavior }> =
    [];
  readonly audit: string[] = [];

  constructor(private readonly defaultBehavior: SimulatedWriteBehavior = "success") {}

  get effectCount(): number {
    return this.effects;
  }

  async send(
    input: CinevisionWriteInput,
    behavior: SimulatedWriteBehavior = this.defaultBehavior,
  ): Promise<SimulatedWriteResponse> {
    this.sends.push({ action: input.action, idempotencyKey: input.idempotencyKey, behavior });
    const prior = this.ledger.get(input.idempotencyKey);
    if (prior !== undefined) {
      this.audit.push(
        `SIMULATED replay absorbed action=${input.action} key-prefix=${input.idempotencyKey.slice(0, 8)}`,
      );
      return { result: prior, duplicate: true };
    }
    const result = this.buildResult(input, behavior);
    this.ledger.set(input.idempotencyKey, result);
    this.meta.set(input.idempotencyKey, { action: input.action, externalRef: result.externalRef });
    // crash_after_effect: the effect happened but the ack never arrived —
    // the ledger holds SUCCESS while the caller observes UNKNOWN.
    if (result.outcome === "SUCCESS") this.effects += 1;
    this.audit.push(
      `SIMULATED send action=${input.action} behavior=${behavior} outcome=${result.outcome} key-prefix=${input.idempotencyKey.slice(0, 8)}`,
    );
    if (behavior === "crash_after_effect") {
      return {
        result: {
          outcome: "UNKNOWN",
          reconciliationState: "VERIFYING",
          detail: `cinevision: ${input.action} ack lost after effect, verify before retry (SIMULATED)`,
          externalRef: result.externalRef,
          simulated: true,
          needsHuman: true,
        },
        duplicate: false,
      };
    }
    return { result, duplicate: false };
  }

  /**
   * Readback consults the ledger only — never re-sends. Keyed by the
   * operation identity (idempotencyKey + action + externalRef): the entry
   * is fetched by exact idempotency key, the recorded action must match
   * the query action, and a SUCCESS claim additionally requires presenting
   * the recorded non-null externalRef. A null reference is never
   * identifying on its own and can never reconcile another operation's
   * effect: null-ref SUCCESS lookups stay inconclusive, and uncertain or
   * refused effects for the exact key report only that key's outcome.
   */
  async readback(query: CinevisionWriteReadbackQuery): Promise<CinevisionWriteReadbackResult> {
    const recorded = this.ledger.get(query.idempotencyKey);
    if (recorded === undefined) {
      return { effectApplied: false, conclusive: false, evidence: "SIMULATED no record", simulated: true };
    }
    const identity = this.meta.get(query.idempotencyKey);
    if (identity === undefined || identity.action !== query.action) {
      return { effectApplied: false, conclusive: false, evidence: "SIMULATED action mismatch", simulated: true };
    }
    if (recorded.outcome === "SUCCESS") {
      if (query.externalRef === null || recorded.externalRef === null || query.externalRef !== recorded.externalRef) {
        return { effectApplied: false, conclusive: false, evidence: "SIMULATED ref mismatch", simulated: true };
      }
      return { effectApplied: true, conclusive: true, evidence: "SIMULATED ledger hit", simulated: true };
    }
    if (recorded.outcome === "FAILURE") {
      return { effectApplied: false, conclusive: true, evidence: "SIMULATED ledger hit", simulated: true };
    }
    return { effectApplied: false, conclusive: false, evidence: "SIMULATED uncertain", simulated: true };
  }

  private buildResult(input: CinevisionWriteInput, behavior: SimulatedWriteBehavior): CinevisionWriteResult {
    switch (behavior) {
      case "success":
      case "crash_after_effect":
        return {
          outcome: "SUCCESS",
          reconciliationState: "SUCCEEDED",
          detail: `cinevision: ${input.action} applied (SIMULATED)`,
          externalRef: `cv-sim-${input.action}-ref`,
          simulated: true,
          needsHuman: false,
        };
      case "failure":
        return {
          outcome: "FAILURE",
          reconciliationState: "FAILED",
          detail: `cinevision: ${input.action} refused by simulated provider (SIMULATED)`,
          externalRef: null,
          simulated: true,
          needsHuman: false,
        };
      case "timeout":
      case "unknown":
      case "session_expired":
      case "browser_disconnected":
        return {
          outcome: "UNKNOWN",
          reconciliationState: "VERIFYING",
          detail: `cinevision: ${input.action} uncertain effect ${behavior}, verify before retry (SIMULATED)`,
          externalRef: null,
          simulated: true,
          needsHuman: true,
        };
      case "no_authz":
        return cinevisionWriteManual(input.action, "not authorized, operator approval required");
    }
  }
}

export interface CinevisionWriteSkeletonDeps {
  external: InMemorySimulatedCinevisionWriteExternal;
  behavior?: SimulatedWriteBehavior;
  timeoutMs?: number;
}

const DEFAULT_WRITE_TIMEOUT_MS = 30_000;

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

export class CinevisionWriteSkeletonAdapter {
  readonly audit: CinevisionWriteAuditEntry[] = [];

  constructor(private readonly deps: CinevisionWriteSkeletonDeps) {}

  async execute(input: CinevisionWriteInput): Promise<CinevisionWriteResult> {
    const invalid = validateCinevisionWriteInput(input);
    if (invalid !== null) return this.park(input, `invalid input: ${invalid}`);
    const raced = await withTimeout(
      this.deps.external.send(input, this.deps.behavior),
      this.deps.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS,
    );
    if (raced === null) {
      const result = classifyCinevisionWriteTimeout(input.action);
      this.audit.push(cinevisionWriteAuditFor(input, result));
      return result;
    }
    if (raced.duplicate && raced.result.outcome === "UNKNOWN") {
      return this.park(input, "replay of uncertain effect, operator must verify");
    }
    const result = raced.result;
    this.audit.push(cinevisionWriteAuditFor(input, result));
    return result;
  }

  async reconcile(
    input: CinevisionWriteInput,
    query: CinevisionWriteReadbackQuery,
  ): Promise<{ decision: CinevisionReconcileDecision; readback: CinevisionWriteReadbackResult }> {
    // Bind the reconcile to the originating input: the readback query must
    // name the same operation identity (idempotencyKey + action). A
    // divergent query would otherwise let reconcile(inputA, queryB) report
    // B's outcome for A — returning succeed/fail for the wrong operation.
    // Divergence stays inconclusive (MANUAL), without touching the ledger.
    if (input.idempotencyKey !== query.idempotencyKey || input.action !== query.action) {
      const readback: CinevisionWriteReadbackResult = {
        effectApplied: false,
        conclusive: false,
        evidence: "SIMULATED input/query mismatch",
        simulated: true,
      };
      return { decision: decideCinevisionWriteReconcile(readback), readback };
    }
    const raced = await withTimeout(
      this.deps.external.readback(query),
      this.deps.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS,
    );
    const readback: CinevisionWriteReadbackResult =
      raced ?? { effectApplied: false, conclusive: false, evidence: "SIMULATED readback timeout", simulated: true };
    return { decision: decideCinevisionWriteReconcile(readback), readback };
  }

  private park(input: CinevisionWriteInput, reason: string): CinevisionWriteResult {
    const result = cinevisionWriteManual(input.action, reason);
    this.audit.push(cinevisionWriteAuditFor(input, result));
    return result;
  }
}
