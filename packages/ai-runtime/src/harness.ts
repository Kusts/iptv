import {
  looksLikeInjection,
  looksLikeSecret,
  renderUserBlock,
  type ModelGatewayPort,
} from "./model-gateway.js";
import { mapFailureToStatus, type ToolDispatcher, type ToolRegistry } from "./tool-registry.js";
import type { AgentReleaseStore } from "./release-store.js";
import type {
  AgentHarnessPort,
  AgentProposal,
  AgentRunRequest,
  AgentRunResult,
  ToolCallRecord,
} from "./types.js";

const MAX_PROPOSAL_CHARS = 1000;

export interface HarnessDeps {
  gateway: ModelGatewayPort;
  releases: AgentReleaseStore;
  tools: ToolRegistry;
  /** Host dispatcher (application commands/queries); defaults to deny-all. */
  dispatch?: ToolDispatcher;
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

  constructor(deps: HarnessDeps) {
    this.gateway = deps.gateway;
    this.releases = deps.releases;
    this.tools = deps.tools;
    this.dispatch = deps.dispatch ?? denyAll;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const trace: string[] = [];
    const toolCalls: ToolCallRecord[] = [];

    // Tenant-scope guard: request and context must agree, or fail closed.
    if (request.tenantId !== request.context.tenantId) {
      return escalated("tenant_scope_mismatch", trace, toolCalls, request);
    }

    const release = await this.releases.getPublished(request.releaseId);
    if (release === null) {
      return escalated("release_not_found", trace, toolCalls, request);
    }
    trace.push(`release:${release.key}:v${release.version}`);

    // Single specialist-as-tool step: read-only person lookup when the
    // inbound asks about the customer's own record and the tool is allowed.
    const startedAt = Date.now();
    if (request.allowedTools.includes("crm.lookup_person") && wantsPersonLookup(request.inboundText)) {
      const tool = this.tools.get("crm.lookup_person");
      if (tool !== null && request.context.personSummary !== null) {
        const parsed = tool.inputSchema.safeParse({ personId: request.context.personSummary.personId });
        if (parsed.success) {
          const result = await tool.execute(
            {
              tenantId: request.tenantId,
              actorType: "agent",
              actorId: "agent-harness",
              conversationId: request.conversationId,
            },
            parsed.data,
            this.dispatch,
          );
          const latencyMs = Date.now() - startedAt;
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
        }
      }
    }

    const completion = await this.gateway.complete(
      [
        { role: "system", content: release.systemPrompt },
        { role: "developer", content: release.developerPrompt },
        { role: "user", content: renderUserBlock(request.context, request.inboundText, request.mode) },
      ],
      { model: release.model, maxTokens: 500 },
    );
    trace.push(`model:${this.gateway.name}:${completion.label}`);

    // Validate untrusted model output before acting on it.
    const proposal = validateCompletion(completion.text, completion.label);
    trace.push(`proposal:${proposal.kind}:${proposal.label}`);
    return {
      proposals: [proposal],
      toolCalls,
      usage: { ...completion.usage, model: release.model },
      finishReason: proposal.kind === "REPLY" ? "proposal_ready" : proposal.kind === "REFUSE" ? "refused" : "escalated",
      trace,
    };
  }
}

function wantsPersonLookup(inboundText: string): boolean {
  return /meus?\s+dados|meu\s+cadastro|my\s+(data|account|profile)/i.test(inboundText);
}

function validateCompletion(text: string, label: string): AgentProposal {
  const trimmed = text.trim().slice(0, MAX_PROPOSAL_CHARS);
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

async function escalated(
  reason: string,
  trace: string[],
  toolCalls: ToolCallRecord[],
  request: AgentRunRequest,
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
    usage: { inputTokens: 0, outputTokens: 0, model: "none" },
    finishReason: "escalated",
    trace,
  };
}
