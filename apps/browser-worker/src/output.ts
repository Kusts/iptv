/**
 * Sanitized CLI output envelope.
 *
 * stdout carries ONE compact JSON line with booleans + fixed code words.
 * Raw profiles, response bodies, emails, tokens and URLs are NEVER
 * included. stderr carries the same envelope on failure (exit != 0).
 */

import { randomUUID } from "node:crypto";
import type { WorkerErrorCode, WorkerStatus } from "./constants.js";

export interface WorkerResult {
  correlationId: string;
  providerAccountId: string;
  status: WorkerStatus;
  identityMatched: boolean;
  readbackMatched: boolean;
  needsHuman: boolean;
  errorCode: WorkerErrorCode;
}

export function newResult(
  providerAccountId: string,
  partial: Omit<WorkerResult, "correlationId" | "providerAccountId">,
): WorkerResult {
  return { correlationId: randomUUID(), providerAccountId, ...partial };
}

export function formatResult(result: WorkerResult): string {
  return JSON.stringify(result);
}
