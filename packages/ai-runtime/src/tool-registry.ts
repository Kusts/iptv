import type { z } from "zod";

/**
 * Safe tool registry (framework-free).
 *
 * Canonical rules:
 * - Every tool declares tenant scope + failure taxonomy. Tool existence
 *   NEVER implies authorization: `execute` runs through the host's
 *   permission/policy checks (the CommandBus in apps/api).
 * - Tools invoke the SAME application commands/queries as the frontend —
 *   never raw SQL/DB/provider calls from the tool layer. The package only
 *   declares the dispatcher port; apps/api wires the real dispatcher.
 * - Failure taxonomy (transient/fatal/unknown_effect) maps deterministically
 *   to runtime statuses; UNKNOWN_EFFECT never becomes "retry immediately".
 */

/** Coarse failure class per the tool-failure taxonomy. */
export type ToolFailureKind = "TRANSIENT" | "FATAL" | "UNKNOWN_EFFECT";

export type RuntimeToolStatus =
  | "SUCCEEDED"
  | "DENIED"
  | "REVIEW_REQUIRED"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL";

/** Deterministic mapping from failure class to runtime status. */
export function mapFailureToStatus(kind: ToolFailureKind): RuntimeToolStatus {
  switch (kind) {
    case "TRANSIENT":
      return "FAILED_RETRYABLE";
    case "FATAL":
      return "FAILED_TERMINAL";
    case "UNKNOWN_EFFECT":
      // Uncertain effect: verify external state/postcondition first — the
      // workflow parks for reconciliation, never blind-retries.
      return "REVIEW_REQUIRED";
  }
}

export type ToolRiskClass = "R0" | "R1" | "R2" | "R3" | "R4";

export interface ToolContext {
  tenantId: string;
  actorType: "agent" | "human" | "system";
  actorId: string;
  conversationId: string;
}

export type ToolExecResult =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; code: string; message: string; failureKind: ToolFailureKind };

/**
 * Dispatcher port: the host injects the real application-command dispatcher
 * (CommandBus + tenant-scoped query services). The package stays pure.
 */
export type ToolDispatcher = (ctx: ToolContext, command: string, input: unknown) => Promise<ToolExecResult>;

export interface ToolDescriptor {
  /** Stable tool name (e.g. `crm.lookup_person`). */
  name: string;
  /** Tenant scope declaration: tools are tenant-scoped reads/writes. */
  tenantScope: "tenant";
  riskClass: ToolRiskClass;
  inputSchema: z.ZodType<unknown, z.ZodTypeDef, unknown>;
  /** Execute via the injected dispatcher — never direct DB/provider access. */
  execute: (ctx: ToolContext, input: unknown, dispatch: ToolDispatcher) => Promise<ToolExecResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDescriptor>();

  register(tool: ToolDescriptor): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    if (tool.tenantScope !== "tenant") {
      throw new Error(`tool ${tool.name} must declare tenant scope`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDescriptor | null {
    return this.tools.get(name) ?? null;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}
