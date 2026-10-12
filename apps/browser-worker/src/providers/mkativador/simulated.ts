/**
 * MK Ativador SIMULATED external fixture (explicitly SIMULATED).
 *
 * This is the ONLY place an "external" MK effect happens in this slice:
 * an in-memory ledger keyed by idempotency key. No network, no provider
 * calls, no purchases, no charges. Every method is marked SIMULATED in its
 * result so a simulated outcome can never be mistaken for a live proof.
 *
 * Single-effect guarantee: the first call with a given idempotency key
 * records the effect; a replay with the same key returns the recorded
 * outcome with `duplicate: true` and performs NO new mutation.
 */

import type { MkOperationKind, MkOperationResult } from "./types.js";

export type SimulatedMkBehavior =
  | "success"
  | "failure"
  | "unknown"
  | "timeout"
  | "no_authz"
  | "session_expired"
  | "browser_disconnected";

export interface SimulatedMkCall {
  kind: MkOperationKind;
  idempotencyKey: string;
  behavior: SimulatedMkBehavior;
}

export interface SimulatedMkResponse {
  result: MkOperationResult;
  /** True when this key was already seen (replay — no new mutation). */
  duplicate: boolean;
}

/**
 * In-memory SIMULATED MK external. `effects` counts actually-applied
 * mutations (successes only); replays never increment it.
 */
export class InMemorySimulatedMkExternal {
  private readonly ledger = new Map<string, MkOperationResult>();
  private effects = 0;
  readonly calls: SimulatedMkCall[] = [];
  readonly audit: string[] = [];

  constructor(private readonly defaultBehavior: SimulatedMkBehavior = "success") {}

  get effectCount(): number {
    return this.effects;
  }

  get ledgerSize(): number {
    return this.ledger.size;
  }

  async perform(
    kind: MkOperationKind,
    idempotencyKey: string,
    behavior: SimulatedMkBehavior = this.defaultBehavior,
  ): Promise<SimulatedMkResponse> {
    this.calls.push({ kind, idempotencyKey, behavior });
    const prior = this.ledger.get(idempotencyKey);
    if (prior !== undefined) {
      this.audit.push(`SIMULATED replay absorbed kind=${kind} key-prefix=${idempotencyKey.slice(0, 8)}`);
      return { result: prior, duplicate: true };
    }
    const result = this.buildResult(kind, behavior);
    this.ledger.set(idempotencyKey, result);
    if (result.outcome === "SUCCESS") this.effects += 1;
    this.audit.push(
      `SIMULATED external kind=${kind} behavior=${behavior} outcome=${result.outcome} key-prefix=${idempotencyKey.slice(0, 8)}`,
    );
    return { result, duplicate: false };
  }

  /**
   * Read-only subject lookup for honest readback: answers from the recorded
   * outcome keyed by the SUBJECT idempotency key only. Never inserts,
   * never mutates, never increments the effect count — a readback observes,
   * it does not execute. Returns `undefined` when the subject was never
   * recorded (caller must treat absence as inconclusive/MANUAL).
   */
  lookup(subjectIdempotencyKey: string): MkOperationResult | undefined {
    return this.ledger.get(subjectIdempotencyKey);
  }

  private buildResult(kind: MkOperationKind, behavior: SimulatedMkBehavior): MkOperationResult {
    switch (behavior) {
      case "success":
        return {
          outcome: "SUCCESS",
          reconciliationState: "SUCCEEDED",
          detail: `mk: ${kind} applied (SIMULATED)`,
          externalRef: `mk-sim-${kind}-ref`,
          simulated: true,
          needsHuman: false,
        };
      case "failure":
        return {
          outcome: "FAILURE",
          reconciliationState: "FAILED",
          detail: `mk: ${kind} refused by simulated provider (SIMULATED)`,
          externalRef: null,
          simulated: true,
          needsHuman: false,
        };
      case "timeout":
      case "unknown":
        return {
          outcome: "UNKNOWN",
          reconciliationState: "VERIFYING",
          detail: `mk: ${kind} uncertain effect, verify before retry (SIMULATED)`,
          externalRef: null,
          simulated: true,
          needsHuman: true,
        };
      case "no_authz":
        return {
          outcome: "MANUAL",
          reconciliationState: "MANUAL",
          detail: `mk: ${kind} not authorized, operator approval required (SIMULATED)`,
          externalRef: null,
          simulated: true,
          needsHuman: true,
        };
      case "session_expired":
        return {
          outcome: "UNKNOWN",
          reconciliationState: "VERIFYING",
          detail: `mk: ${kind} session expired mid-call, effect unobserved (SIMULATED)`,
          externalRef: null,
          simulated: true,
          needsHuman: true,
        };
      case "browser_disconnected":
        return {
          outcome: "UNKNOWN",
          reconciliationState: "VERIFYING",
          detail: `mk: ${kind} browser disconnected mid-call, effect unobserved (SIMULATED)`,
          externalRef: null,
          simulated: true,
          needsHuman: true,
        };
    }
  }
}
