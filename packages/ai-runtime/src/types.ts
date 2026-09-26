/**
 * Wave 3 ai-runtime shared types (framework-free).
 *
 * Canonical rules:
 * - Business policy NEVER lives in prompts; authorization/policy stays
 *   outside model instructions. The model receives an already-assembled,
 *   tenant-scoped `ContextBundle` built by the host app (Context Builder).
 * - LLM output is untrusted: the harness validates every proposal before
 *   the host app may act on it.
 * - Shadow mode proposes only and never sends; only the host pipeline may
 *   send, and only through the approved HUMAN/approved-command path.
 */

/** Tenant-scoped context assembled OUTSIDE the model (host Context Builder). */
export interface ContextMessage {
  direction: "INBOUND" | "OUTBOUND";
  senderType: string;
  /** Body text is UNTRUSTED inbound data; tagged, never an instruction. */
  bodyText: string | null;
  occurredAt: string;
}

export interface ContextBundle {
  tenantId: string;
  conversationId: string;
  channel: string;
  controlMode: string;
  personSummary: {
    personId: string;
    canonicalName: string | null;
    locale: string | null;
  } | null;
  /** Bounded recent window (host enforces the cap). */
  recentMessages: ContextMessage[];
  /** Structured policy facts (already resolved by PolicyResolver). */
  policySummary: {
    /** True only when tenant policy explicitly enables autonomous send. */
    allowAutonomous: boolean;
    notes: string[];
  };
  /** True when a suppression/opt-out blocks outbound on this channel. */
  suppressionsActive: boolean;
  openReviewCount: number;
}

export type AgentMode = "SHADOW" | "LIVE";

export interface AgentRunRequest {
  tenantId: string;
  conversationId: string;
  /** AgentRelease key (e.g. `customer-agent-v1`); never an inline prompt. */
  releaseId: string;
  mode: AgentMode;
  allowedTools: string[];
  context: ContextBundle;
  /** Latest inbound text (untrusted; rendered to the model as data). */
  inboundText: string;
}

export type ProposalKind = "REPLY" | "REFUSE" | "ESCALATE";

export interface AgentProposal {
  kind: ProposalKind;
  /** Proposed reply text (REPLY) or safe customer-facing note otherwise. */
  text: string;
  /** Deterministic eval label (e.g. `happy_reply`, `injection_refusal`). */
  label: string;
  confidence: number;
}

export interface ToolCallRecord {
  name: string;
  status: "SUCCEEDED" | "DENIED" | "REVIEW_REQUIRED" | "FAILED_RETRYABLE" | "FAILED_TERMINAL";
  /** Coarse failure class per the tool-failure taxonomy. */
  failureKind: "TRANSIENT" | "FATAL" | "UNKNOWN_EFFECT" | null;
  latencyMs: number;
}

export interface AgentRunResult {
  proposals: AgentProposal[];
  toolCalls: ToolCallRecord[];
  usage: { inputTokens: number; outputTokens: number; model: string };
  finishReason: "proposal_ready" | "refused" | "escalated" | "failed";
  /** Redacted step trace (no secrets, no raw provider text). */
  trace: string[];
}

/** Harness port: the execution harness, not the product architecture. */
export interface AgentHarnessPort {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
