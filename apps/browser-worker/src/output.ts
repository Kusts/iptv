/**
 * Sanitized CLI output envelope.
 *
 * stdout carries ONE compact JSON line with booleans + fixed code words.
 * Raw profiles, response bodies, emails, tokens and URLs are NEVER
 * included. stderr carries the same envelope on failure (exit != 0).
 *
 * V2: every command result also carries execution metadata
 * (`executionChannel`, `strategy`, `adapterVersion`, `command`,
 * `reauthenticated`) so callers can tell which channel/strategy produced
 * the read and whether a bounded reauth happened. Successful reads attach
 * the sanitized projected `data` plus minimal sanitized `evidence`
 * (relative path, HTTP status, duration) — never tokens or PII beyond
 * the ids already supplied as CLI args.
 */

import { randomUUID } from "node:crypto";
import {
  ADAPTER_VERSION,
  EXECUTION_CHANNEL,
  READ_STRATEGY,
  type CinevisionOperation,
  type WorkerErrorCode,
  type WorkerStatus,
} from "./constants.js";

/** Minimal sanitized read evidence (no tokens, no bodies, no secrets). */
export interface WorkerEvidence {
  status: number | null;
  path: string;
  durationMs: number;
}

export interface WorkerResult {
  correlationId: string;
  providerAccountId: string;
  status: WorkerStatus;
  identityMatched: boolean;
  readbackMatched: boolean;
  needsHuman: boolean;
  errorCode: WorkerErrorCode;
  /** Dotted operation that produced this result (V2 commands). */
  command?: CinevisionOperation;
  executionChannel?: typeof EXECUTION_CHANNEL;
  strategy?: typeof READ_STRATEGY;
  adapterVersion?: typeof ADAPTER_VERSION;
  /** True when a single bounded reauth was performed before the read. */
  reauthenticated?: boolean;
  /** Sanitized projected payload (present on successful reads only). */
  data?: unknown;
  evidence?: WorkerEvidence;
}

export function newResult(
  providerAccountId: string,
  partial: Omit<WorkerResult, "correlationId" | "providerAccountId">,
): WorkerResult {
  return { correlationId: randomUUID(), providerAccountId, ...partial };
}

/** Stamp V2 execution metadata on a command result (success or failure). */
export function withExecutionMetadata<T extends WorkerResult>(
  result: T,
  command: CinevisionOperation,
  reauthenticated: boolean,
): T {
  result.command = command;
  result.executionChannel = EXECUTION_CHANNEL;
  result.strategy = READ_STRATEGY;
  result.adapterVersion = ADAPTER_VERSION;
  result.reauthenticated = reauthenticated;
  return result;
}

export function formatResult(result: WorkerResult): string {
  return JSON.stringify(result);
}
