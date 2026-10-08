import {
  isTransientGatewayError,
  looksLikeInjection,
  looksLikeSecret,
  renderUserBlock,
  runWithTimeout,
  type ModelCompletion,
  type ModelGatewayPort,
  type ModelMessage,
} from "./model-gateway.js";
import type { AgentMode, ContextBundle } from "./types.js";
import { estimateCostMicros, estimateTokensForChars, resolveBudgets, type HarnessBudgets } from "./budgets.js";
import { mapFailureToStatus, type ToolDispatcher, type ToolRegistry } from "./tool-registry.js";
import type { AgentReleaseStore } from "./release-store.js";
import type {
  AgentHarnessPort,
  AgentProposal,
  AgentRunRequest,
  AgentRunResult,
  ToolCallRecord,
} from "./types.js";

export interface HarnessDeps {
  gateway: ModelGatewayPort;
  releases: AgentReleaseStore;
  tools: ToolRegistry;
  /** Host dispatcher (application commands/queries); defaults to deny-all. */
  dispatch?: ToolDispatcher;
  /** Budget overrides; every field falls back to a safe default (see DEFAULT_BUDGETS). */
  budgets?: Partial<HarnessBudgets>;
  /**
   * Optional secondary gateway (model fallback). Tried ONCE, only when the
   * primary exhausts its attempt budget with a TRANSIENT failure
   * (indisponibilidade: timeout, 429, 5xx, transport). FATAL failures
   * (4xx, empty, unsafe output) NEVER fall back — a second model cannot fix
   * a bad or unsafe answer, and retrying unsafe output is forbidden.
   * Fallback use is always visible in `trace` (`model:fallback:<name>`).
   * Honest-direction note: prefer a second compatible model as fallback;
   * wiring echo here in LIVE yields generic deterministic replies, which
   * the trace will show — it degrades, it does not replicate the primary.
   */
  fallback?: ModelGatewayPort;
}

const denyAll: ToolDispatcher = async () => ({
  ok: false,
  code: "NOT_AUTHORIZED",
  message: "no dispatcher wired",
  failureKind: "FATAL",
});

/**
 * Primary-agent harness: context → model → validated proposal.
 *
 * Pattern: Primary → Specialist-as-tool → Primary (single specialist call,
 * no recursive chains). LLM output is untrusted and validated before it
 * leaves the harness. The harness NEVER sends messages and NEVER authorizes:
 * tool execution goes through the host dispatcher (CommandBus permission
 * checks), and sending stays with the host pipeline (approval-gated).
 */
export class AgentHarness implements AgentHarnessPort {
  private readonly gateway: ModelGatewayPort;
  private readonly releases: AgentReleaseStore;
  private readonly tools: ToolRegistry;
  private readonly dispatch: ToolDispatcher;
  private readonly budgets: HarnessBudgets;
  private readonly fallback: ModelGatewayPort | null;

  constructor(deps: HarnessDeps) {
    this.gateway = deps.gateway;
    this.releases = deps.releases;
    this.tools = deps.tools;
    this.dispatch = deps.dispatch ?? denyAll;
    this.budgets = resolveBudgets(deps.budgets);
    this.fallback = deps.fallback ?? null;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const budgets = this.budgets;
    const trace: string[] = [];
    const toolCalls: ToolCallRecord[] = [];
    const startedAt = Date.now();
    const elapsedMs = (): number => Date.now() - startedAt;
    const deadlineExceeded = (): boolean => elapsedMs() >= budgets.totalTimeoutMs;

    // Tenant-scope guard: request and context must agree, or fail closed.
    if (request.tenantId !== request.context.tenantId) {
      return escalated("tenant_scope_mismatch", trace, toolCalls, request);
    }

    const release = await this.releases.getPublished(request.releaseId);
    if (release === null) {
      return escalated("release_not_found", trace, toolCalls, request);
    }
    trace.push(`release:${release.key}:v${release.version}`);

    // Specialist-as-tool step (bounded: at most maxToolSteps per run).
    let toolStepsUsed = 0;
    const toolWanted =
      request.allowedTools.includes("crm.lookup_person") && wantsPersonLookup(request.inboundText);
    if (toolWanted && toolStepsUsed >= budgets.maxToolSteps) {
      trace.push("tool:crm.lookup_person:skipped:budget");
    }
    if (toolWanted && toolStepsUsed < budgets.maxToolSteps) {
      const tool = this.tools.get("crm.lookup_person");
      if (tool !== null && request.context.personSummary !== null) {
        const parsed = tool.inputSchema.safeParse({ personId: request.context.personSummary.personId });
        if (parsed.success) {
          toolStepsUsed += 1;
          const toolStartedAt = Date.now();
          try {
            const result = await runWithTimeout(budgets.toolTimeoutMs, () =>
              tool.execute(
                {
                  tenantId: request.tenantId,
                  actorType: "agent",
                  actorId: "agent-harness",
                  conversationId: request.conversationId,
                },
                parsed.data,
                this.dispatch,
              ),
            );
            const latencyMs = Date.now() - toolStartedAt;
            if (result.ok) {
              toolCalls.push({ name: tool.name, status: "SUCCEEDED", failureKind: null, latencyMs });
              trace.push(`tool:${tool.name}:SUCCEEDED`);
            } else {
              toolCalls.push({
                name: tool.name,
                status: mapFailureToStatus(result.failureKind),
                failureKind: result.failureKind,
                latencyMs,
              });
              trace.push(`tool:${tool.name}:${result.code}`);
            }
          } catch (err) {
            // ONLY the step timeout lands here as REVIEW_REQUIRED: the host
            // call may still be running, so its effect is UNKNOWN — park for
            // reconciliation, never blind-retry. Any other dispatcher throw
            // propagates exactly as before (no behavior change).
            if (!isTransientGatewayError(err)) {
              throw err;
            }
            const latencyMs = Date.now() - toolStartedAt;
            toolCalls.push({
              name: tool.name,
              status: "REVIEW_REQUIRED",
              failureKind: "UNKNOWN_EFFECT",
              latencyMs,
            });
            trace.push(`tool:${tool.name}:TIMEOUT_EFFECT_UNKNOWN`);
          }
        }
      }
    }

    // Context budget: shrink the recent window deterministically until the
    // estimated input fits (a harness-local context-epoch rebuild). The host
    // Context Builder owns full epoch policy; the harness never sends
    // oversized context regardless of what it receives.
    const prefixChars = release.systemPrompt.length + release.developerPrompt.length;
    const { block: userBlock, rebuilt, keptMessages } = buildUserBlockWithinBudget(
      request.context,
      request.inboundText,
      request.mode,
      prefixChars,
      budgets.maxInputTokens,
    );
    trace.push(rebuilt ? `context:rebuilt:kept=${keptMessages}` : "context:full");
    const inputTokens = estimateTokensForChars(prefixChars + userBlock.length);

    // Pre-call cost cap: never place a call whose estimate already exceeds it.
    const preCost = estimateCostMicros(inputTokens, budgets.maxTokens, budgets);
    if (preCost > budgets.maxEstimatedCostMicros) {
      trace.push(`cost:precheck_exceeded:${Math.round(preCost)}`);
      return escalated("cost_budget_exceeded", trace, toolCalls, request);
    }

    if (deadlineExceeded()) {
      return escalated("run_deadline_exceeded", trace, toolCalls, request);
    }

    const messages = [
      { role: "system" as const, content: release.systemPrompt },
      { role: "developer" as const, content: release.developerPrompt },
      { role: "user" as const, content: userBlock },
    ];
    const completion = await this.completeWithBudgets(messages, release.model, trace, elapsedMs, deadlineExceeded);

    // Post-call cost cap: the spend already happened, so discard an
    // over-cost completion to ESCALATE instead of acting on an anomalous
    // output. Real usage is preserved for spend observability.
    const postCost = estimateCostMicros(completion.usage.inputTokens, completion.usage.outputTokens, budgets);
    if (postCost > budgets.maxEstimatedCostMicros) {
      trace.push(`cost:postcheck_exceeded:${Math.round(postCost)}`);
      return escalated("cost_budget_exceeded", trace, toolCalls, request, {
        inputTokens: completion.usage.inputTokens,
        outputTokens: completion.usage.outputTokens,
        model: release.model,
      });
    }

    // Validate untrusted model output before acting on it.
    const proposal = validateCompletion(completion.text, completion.label, budgets.maxProposalChars);
    trace.push(`proposal:${proposal.kind}:${proposal.label}`);
    return {
      proposals: [proposal],
      toolCalls,
      usage: { ...completion.usage, model: release.model },
      finishReason: proposal.kind === "REPLY" ? "proposal_ready" : proposal.kind === "REFUSE" ? "refused" : "escalated",
      trace,
    };
  }

  /**
   * Bounded model call: up to maxModelAttempts on TRANSIENT, then ONE
   * fallback attempt (when wired), then reject loudly (F07: no silent
   * degrade — the pipeline persists nothing). FATAL never retries.
   * Each attempt is capped at min(perCallTimeoutMs, deadline remaining).
   */
  private async completeWithBudgets(
    messages: ModelMessage[],
    model: string,
    trace: string[],
    elapsedMs: () => number,
    deadlineExceeded: () => boolean,
  ): Promise<ModelCompletion> {
    const budgets = this.budgets;
    const maxAttempts = Math.max(1, budgets.maxModelAttempts);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (deadlineExceeded()) {
        throw new Error("run deadline exceeded before model call");
      }
      const remaining = budgets.totalTimeoutMs - elapsedMs();
      const timeoutMs = Math.min(budgets.perCallTimeoutMs, Math.max(0, remaining));
      try {
        const completion = await runWithTimeout(timeoutMs, (signal) =>
          this.gateway.complete(messages, { model, maxTokens: budgets.maxTokens, signal }),
        );
        trace.push(`model:${this.gateway.name}:${completion.label}`);
        return completion;
      } catch (err) {
        lastError = err;
        const transient = isTransientGatewayError(err);
        trace.push(`model:${this.gateway.name}:error:${transient ? "transient" : "fatal"}:attempt${attempt}`);
        if (!transient) {
          throw err;
        }
      }
    }
    // Primary attempts exhausted on TRANSIENT: one fallback attempt, same caps.
    if (this.fallback !== null && !deadlineExceeded()) {
      const remaining = budgets.totalTimeoutMs - elapsedMs();
      const timeoutMs = Math.min(budgets.perCallTimeoutMs, Math.max(0, remaining));
      try {
        const completion = await runWithTimeout(timeoutMs, (signal) =>
          (this.fallback as ModelGatewayPort).complete(messages, {
            model,
            maxTokens: budgets.maxTokens,
            signal,
          }),
        );
        trace.push(`model:fallback:${(this.fallback as ModelGatewayPort).name}:${completion.label}`);
        return completion;
      } catch (err) {
        const transient = isTransientGatewayError(err);
        trace.push(
          `model:fallback:${(this.fallback as ModelGatewayPort).name}:error:${transient ? "transient" : "fatal"}`,
        );
        throw err;
      }
    }
    throw lastError;
  }
}

function wantsPersonLookup(inboundText: string): boolean {
  return /meus?\s+dados|meu\s+cadastro|my\s+(data|account|profile)/i.test(inboundText);
}

function validateCompletion(text: string, label: string, maxProposalChars: number): AgentProposal {
  const trimmed = text.trim().slice(0, Math.max(0, maxProposalChars));
  if (trimmed.length === 0 || looksLikeSecret(trimmed) || looksLikeInjection(trimmed)) {
    return {
      kind: "ESCALATE",
      text: "Vou encaminhar sua mensagem para um atendente humano.",
      label: "output_guardrail_escalation",
      confidence: 1,
    };
  }
  if (label === "off_scope_refusal" || label === "injection_refusal") {
    return { kind: "REFUSE", text: trimmed, label, confidence: 1 };
  }
  if (label === "suppression_respect") {
    return { kind: "ESCALATE", text: trimmed, label, confidence: 1 };
  }
  return { kind: "REPLY", text: trimmed, label, confidence: 0.7 };
}

/**
 * Shrink the recent-message window (8 → 4 → 2 → 0) until the estimated full
 * input (caller prefix + user block) fits `maxInputTokens`. Deterministic,
 * newest-first; inbound text is never dropped, only older context rows.
 */
function buildUserBlockWithinBudget(
  context: ContextBundle,
  inboundText: string,
  mode: AgentMode,
  prefixChars: number,
  maxInputTokens: number,
): { block: string; rebuilt: boolean; keptMessages: number } {
  const windows = [8, 4, 2, 0];
  for (const window of windows) {
    const scoped: ContextBundle =
      window >= 8 ? context : { ...context, recentMessages: context.recentMessages.slice(-window) };
    const block = renderUserBlock(scoped, inboundText, mode);
    if (estimateTokensForChars(prefixChars + block.length) <= maxInputTokens || window === 0) {
      return {
        block,
        rebuilt: window < 8,
        keptMessages: Math.min(window, context.recentMessages.length),
      };
    }
  }
  throw new Error("unreachable: window 0 always returns");
}

async function escalated(
  reason: string,
  trace: string[],
  toolCalls: ToolCallRecord[],
  request: AgentRunRequest,
  usage?: { inputTokens: number; outputTokens: number; model: string },
): Promise<AgentRunResult> {
  trace.push(`escalated:${reason}`);
  const proposal: AgentProposal = {
    kind: "ESCALATE",
    text: "Vou encaminhar sua mensagem para um atendente humano.",
    label: reason,
    confidence: 1,
  };
  void request;
  return {
    proposals: [proposal],
    toolCalls,
    usage: usage ?? { inputTokens: 0, outputTokens: 0, model: "none" },
    finishReason: "escalated",
    trace,
  };
}
