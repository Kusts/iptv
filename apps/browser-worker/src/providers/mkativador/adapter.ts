/**
 * MK Ativador skeleton adapter (credential-independent, SIMULATED-only).
 *
 * Covers the certified surface: secure auth seam (credential refs, never
 * values), balance query, product query, purchase, activation, readback.
 * Every external call goes through the explicit SIMULATED fixture
 * interface — there is no live path in this slice. Every uncertain
 * external effect defaults to MANUAL fallback with an audit log entry.
 */

import { InMemorySimulatedMkExternal, type SimulatedMkBehavior } from "./simulated.js";
import {
  classifyMkTimeout,
  isOverSpendingLimit,
  mkAuditFor,
  mkManualFallback,
  validateMkInput,
  type MkAuditEntry,
  type MkOperationInput,
  type MkOperationResult,
} from "./types.js";

export interface MkSkeletonDeps {
  external: InMemorySimulatedMkExternal;
  /** Per-call behavior override for tests (default: fixture default). */
  behavior?: SimulatedMkBehavior;
  /** Timeout budget in ms for mutating calls (SIMULATED race). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

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

export class MkAtivadorSkeletonAdapter {
  readonly audit: MkAuditEntry[] = [];

  constructor(private readonly deps: MkSkeletonDeps) {}

  async execute(input: MkOperationInput): Promise<MkOperationResult> {
    const invalid = validateMkInput(input);
    if (invalid !== null) {
      return this.park(input, `invalid input: ${invalid}`);
    }
    if (isOverSpendingLimit(input)) {
      return this.park(input, "amount exceeds operator spending limit");
    }
    if (input.kind === "readback") {
      return this.readback(input);
    }
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const raced = await withTimeout(
      this.deps.external.perform(input.kind, input.idempotencyKey, this.deps.behavior),
      timeoutMs,
    );
    if (raced === null) {
      const result = classifyMkTimeout(input.kind);
      this.audit.push(mkAuditFor(input, result));
      return result;
    }
    const result = raced.duplicate === true ? this.onReplay(input, raced.result) : raced.result;
    this.audit.push(mkAuditFor(input, result));
    if (result.outcome === "UNKNOWN") {
      return { ...result, needsHuman: true };
    }
    return result;
  }

  private onReplay(input: MkOperationInput, recorded: MkOperationResult): MkOperationResult {
    if (recorded.outcome === "UNKNOWN") {
      return mkManualFallback(input.kind, "replay of uncertain effect, operator must verify");
    }
    return recorded;
  }

  private async readback(input: MkOperationInput): Promise<MkOperationResult> {
    const raced = await withTimeout(
      this.deps.external.perform(input.kind, input.idempotencyKey, this.deps.behavior),
      this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (raced === null) {
      const result = classifyMkTimeout(input.kind);
      this.audit.push(mkAuditFor(input, result));
      return result;
    }
    // Readback NEVER re-executes the subject: the fixture ledger answers
    // from the recorded outcome only (replay-safe by construction).
    const result: MkOperationResult = {
      outcome: raced.result.outcome,
      reconciliationState: raced.result.reconciliationState,
      detail: `mk: readback observed ${raced.result.outcome} (SIMULATED, no re-execution)`,
      externalRef: raced.result.externalRef,
      simulated: true,
      needsHuman: raced.result.outcome === "UNKNOWN" || raced.result.outcome === "MANUAL",
    };
    this.audit.push(mkAuditFor(input, result));
    return result;
  }

  private park(input: MkOperationInput, reason: string): MkOperationResult {
    const result = mkManualFallback(input.kind, reason);
    this.audit.push(mkAuditFor(input, result));
    return result;
  }
}

export { InMemorySimulatedMkExternal };
export type { SimulatedMkBehavior };
