/**
 * Runtime budgets for the platform-owned agent harness (P2b / ADR-0026
 * condition 1).
 *
 * Every budget degrades deterministically: exhaustion produces a labelled
 * ESCALATE (or skips the over-budget step), never an unbounded loop and
 * never open-ended cost. Total model failure still rejects loudly (the F07
 * contract: no run, no review, no message) — budgets bound the attempt,
 * they do not mask the outage.
 *
 * Token/cost figures are CHAR-based heuristics (`chars / 4`), not provider
 * metering. They exist to stop pathological context before it is sent and
 * to cap spend; the host MUST calibrate `inputMicrosPerToken` /
 * `outputMicrosPerToken` for the live model in use.
 */

export interface HarnessBudgets {
  /**
   * Max model attempts per run (1 initial + retries on TRANSIENT only).
   * FATAL gateway errors never retry. Default 2.
   */
  maxModelAttempts: number;
  /** Max specialist tool steps per run (current shape: 0 or 1). Default 1. */
  maxToolSteps: number;
  /** Per model-call timeout in ms (real AbortSignal, not a comment). Default 15_000. */
  perCallTimeoutMs: number;
  /** Per tool-step timeout in ms. A tool timeout is UNKNOWN_EFFECT → REVIEW_REQUIRED. Default 10_000. */
  toolTimeoutMs: number;
  /** Wall-clock deadline for the whole run in ms. Hit → ESCALATE `run_deadline_exceeded`. Default 60_000. */
  totalTimeoutMs: number;
  /** Max estimated input tokens (system + developer + user block). Over → deterministic context rebuild (shrink the recent window), never send oversized. Default 8_000. */
  maxInputTokens: number;
  /** Max output tokens requested per completion. Default 500 (current behaviour). */
  maxTokens: number;
  /** Max proposal chars kept after validation. Default 1000 (current behaviour). */
  maxProposalChars: number;
  /** Heuristic input price, micro-USD per token. Calibrate per live model. Default 0.15 (≈ mini-class). */
  inputMicrosPerToken: number;
  /** Heuristic output price, micro-USD per token. Calibrate per live model. Default 0.6 (≈ mini-class). */
  outputMicrosPerToken: number;
  /**
   * Max estimated cost per run in micro-USD. Enforced BEFORE the call
   * (no call when the input estimate already exceeds it) and AFTER (an
   * over-cost completion is discarded to ESCALATE `cost_budget_exceeded`).
   * Default 1_000_000 (= $1/run, far above any single echo/dev call).
   */
  maxEstimatedCostMicros: number;
}

export const DEFAULT_BUDGETS: Readonly<HarnessBudgets> = {
  maxModelAttempts: 2,
  maxToolSteps: 1,
  perCallTimeoutMs: 15_000,
  toolTimeoutMs: 10_000,
  totalTimeoutMs: 60_000,
  maxInputTokens: 8_000,
  maxTokens: 500,
  maxProposalChars: 1000,
  inputMicrosPerToken: 0.15,
  outputMicrosPerToken: 0.6,
  maxEstimatedCostMicros: 1_000_000,
};

/** Merge caller overrides over the safe defaults (shallow, explicit). */
export function resolveBudgets(overrides?: Partial<HarnessBudgets>): HarnessBudgets {
  return { ...DEFAULT_BUDGETS, ...overrides };
}

/** Char-based token heuristic shared by budget checks (NOT provider metering). */
export function estimateTokensForChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export function estimateCostMicros(
  inputTokens: number,
  outputTokens: number,
  rates: Pick<HarnessBudgets, "inputMicrosPerToken" | "outputMicrosPerToken">,
): number {
  return inputTokens * rates.inputMicrosPerToken + outputTokens * rates.outputMicrosPerToken;
}
