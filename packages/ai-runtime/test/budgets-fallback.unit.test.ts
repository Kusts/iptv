import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentHarness } from "../src/harness.js";
import {
  EchoModelGateway,
  ModelGatewayError,
  isTransientGatewayError,
  runWithTimeout,
  type ModelCompletion,
  type ModelGatewayPort,
} from "../src/model-gateway.js";
import { InMemoryAgentReleaseStore } from "../src/release-store.js";
import { ToolRegistry } from "../src/tool-registry.js";
import type { AgentRunRequest, ContextBundle } from "../src/types.js";

function context(overrides: Partial<ContextBundle> = {}): ContextBundle {
  return {
    tenantId: "11111111-1111-4111-8111-111111111111",
    conversationId: "22222222-2222-4222-8222-222222222222",
    channel: "WHATSAPP",
    controlMode: "AI_CONTROL",
    personSummary: { personId: "33333333-3333-4333-8333-333333333333", canonicalName: "Lead", locale: "pt-BR" },
    recentMessages: [],
    policySummary: { allowAutonomous: false, notes: [] },
    suppressionsActive: false,
    openReviewCount: 0,
    ...overrides,
  };
}

function request(inboundText: string, overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  const ctx = context();
  return {
    tenantId: ctx.tenantId,
    conversationId: ctx.conversationId,
    releaseId: "customer-agent-v1",
    mode: "SHADOW",
    allowedTools: ["crm.lookup_person"],
    context: ctx,
    inboundText,
    ...overrides,
  };
}

function tools() {
  const registry = new ToolRegistry();
  registry.register({
    name: "crm.lookup_person",
    tenantScope: "tenant",
    riskClass: "R0",
    inputSchema: z.object({ personId: z.string().uuid() }),
    execute: async () => ({ ok: true, output: { canonicalName: "Lead" } }),
  });
  return registry;
}

function countingGateway(
  behavior: (call: number) => Promise<ModelCompletion>,
  name = "counting-stub",
): ModelGatewayPort & { calls: number } {
  const stub: ModelGatewayPort & { calls: number } = {
    name,
    calls: 0,
    async complete() {
      stub.calls += 1;
      return behavior(stub.calls);
    },
  };
  return stub;
}

const happy: ModelCompletion = { text: "tudo certo por aqui", label: "happy_reply", usage: { inputTokens: 10, outputTokens: 5 } };

describe("gateway error taxonomy", () => {
  it("classifies transient vs fatal deterministically", () => {
    expect(isTransientGatewayError(new ModelGatewayError("t", "TRANSIENT"))).toBe(true);
    expect(isTransientGatewayError(new ModelGatewayError("f", "FATAL"))).toBe(false);
    // Legacy plain Errors fail closed: no blind retry, no fallback.
    expect(isTransientGatewayError(new Error("boom"))).toBe(false);
    expect(isTransientGatewayError("boom")).toBe(false);
  });

  it("runWithTimeout rejects TRANSIENT on a real timeout", async () => {
    await expect(
      runWithTimeout(20, (signal) => new Promise<string>((resolve) => {
        const t = setTimeout(() => resolve("late"), 500);
        signal.addEventListener("abort", () => clearTimeout(t));
      })),
    ).rejects.toMatchObject({ name: "ModelGatewayError", kind: "TRANSIENT" });
  });

  it("echo gateway honors an aborted signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(new EchoModelGateway().complete([], { model: "m", maxTokens: 1, signal: ctrl.signal })).rejects.toMatchObject({
      kind: "TRANSIENT",
    });
  });
});

describe("harness budgets", () => {
  it("retries TRANSIENT once by default, then succeeds", async () => {
    const gateway = countingGateway(async (call) => {
      if (call === 1) {
        throw new ModelGatewayError("transport down", "TRANSIENT");
      }
      return happy;
    });
    const h = new AgentHarness({ gateway, releases: new InMemoryAgentReleaseStore(), tools: tools() });
    const result = await h.run(request("Olá"));
    expect(gateway.calls).toBe(2);
    expect(result.finishReason).toBe("proposal_ready");
    expect(result.trace.some((t) => t.includes("error:transient:attempt1"))).toBe(true);
  });

  it("never retries FATAL (empty/unsafe/4xx class)", async () => {
    const gateway = countingGateway(async () => {
      throw new ModelGatewayError("model output failed the safety post-check", "FATAL");
    });
    const h = new AgentHarness({ gateway, releases: new InMemoryAgentReleaseStore(), tools: tools() });
    await expect(h.run(request("Olá"))).rejects.toThrow(/safety post-check/);
    expect(gateway.calls).toBe(1);
  });

  it("rejects loudly after the attempt budget is exhausted (F07 preserved)", async () => {
    const gateway = countingGateway(async () => {
      throw new ModelGatewayError("model gateway call timed out after 10ms", "TRANSIENT");
    });
    const h = new AgentHarness({
      gateway,
      releases: new InMemoryAgentReleaseStore(),
      tools: tools(),
      budgets: { maxModelAttempts: 3 },
    });
    await expect(h.run(request("Olá"))).rejects.toThrow(/timed out/);
    expect(gateway.calls).toBe(3);
  });

  it("a real per-call timeout is TRANSIENT and bounded by maxModelAttempts: 1", async () => {
    const slow: ModelGatewayPort = {
      name: "slow-stub",
      async complete(_m, opts) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 500);
          opts.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new ModelGatewayError("aborted", "TRANSIENT"));
          });
        });
        return happy;
      },
    };
    const h = new AgentHarness({
      gateway: slow,
      releases: new InMemoryAgentReleaseStore(),
      tools: tools(),
      budgets: { perCallTimeoutMs: 20, maxModelAttempts: 1 },
    });
    const started = Date.now();
    await expect(h.run(request("Olá"))).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("skips the tool step when maxToolSteps is 0 (no open loop)", async () => {
    const h = new AgentHarness({
      gateway: new EchoModelGateway(),
      releases: new InMemoryAgentReleaseStore(),
      tools: tools(),
      budgets: { maxToolSteps: 0 },
    });
    const result = await h.run(request("quero ver meus dados cadastrais"));
    expect(result.toolCalls).toHaveLength(0);
    expect(result.trace).toContain("tool:crm.lookup_person:skipped:budget");
    expect(result.finishReason).toBe("proposal_ready");
  });

  it("marks a tool timeout as REVIEW_REQUIRED/UNKNOWN_EFFECT (never blind-retry)", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "crm.lookup_person",
      tenantScope: "tenant",
      riskClass: "R0",
      inputSchema: z.object({ personId: z.string().uuid() }),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { ok: true, output: {} };
      },
    });
    const h = new AgentHarness({
      gateway: new EchoModelGateway(),
      releases: new InMemoryAgentReleaseStore(),
      tools: registry,
      budgets: { toolTimeoutMs: 20 },
    });
    const result = await h.run(request("quero ver meus dados"));
    expect(result.toolCalls[0]).toMatchObject({ status: "REVIEW_REQUIRED", failureKind: "UNKNOWN_EFFECT" });
    expect(result.trace).toContain("tool:crm.lookup_person:TIMEOUT_EFFECT_UNKNOWN");
    expect(result.proposals).toHaveLength(1);
  });

  it("rebuilds context under input pressure and keeps the newest rows", async () => {
    const recentMessages = Array.from({ length: 8 }, (_, i) => ({
      direction: "INBOUND" as const,
      senderType: "PERSON",
      bodyText: `mensagem longa de contexto número ${i} `.repeat(50),
      occurredAt: new Date().toISOString(),
    }));
    const ctx = context({ recentMessages });
    const h = new AgentHarness({
      gateway: new EchoModelGateway(),
      releases: new InMemoryAgentReleaseStore(),
      tools: tools(),
      budgets: { maxInputTokens: 40 },
    });
    const result = await h.run(request("Olá", { context: ctx }));
    expect(result.trace.some((t) => t.startsWith("context:rebuilt:kept="))).toBe(true);
    expect(result.finishReason).toBe("proposal_ready");
  });

  it("escalates without calling the model when the pre-cost estimate exceeds the cap", async () => {
    const gateway = countingGateway(async () => happy);
    const h = new AgentHarness({
      gateway,
      releases: new InMemoryAgentReleaseStore(),
      tools: tools(),
      budgets: { maxEstimatedCostMicros: 0.0001 },
    });
    const result = await h.run(request("Olá"));
    expect(gateway.calls).toBe(0);
    expect(result.finishReason).toBe("escalated");
    expect(result.proposals[0]?.label).toBe("cost_budget_exceeded");
  });

  it("discards an over-cost completion to ESCALATE but preserves real usage", async () => {
    const pricey: ModelCompletion = { text: "ok", label: "happy_reply", usage: { inputTokens: 1_000_000, outputTokens: 500_000 } };
    const gateway = countingGateway(async () => pricey);
    // Cap above the pre-call estimate (~338 micros) but far below the
    // completion's real cost (~450k micros): pre-check passes, post-check fires.
    const h = new AgentHarness({
      gateway,
      releases: new InMemoryAgentReleaseStore(),
      tools: tools(),
      budgets: { maxEstimatedCostMicros: 1000 },
    });
    const result = await h.run(request("Olá"));
    expect(result.finishReason).toBe("escalated");
    expect(result.proposals[0]?.label).toBe("cost_budget_exceeded");
    expect(result.usage.inputTokens).toBe(1_000_000);
  });

  it("escalates deterministically when the total deadline is already spent", async () => {
    const gateway = countingGateway(async () => happy);
    const h = new AgentHarness({
      gateway,
      releases: new InMemoryAgentReleaseStore(),
      tools: tools(),
      budgets: { totalTimeoutMs: 0 },
    });
    const result = await h.run(request("Olá"));
    expect(gateway.calls).toBe(0);
    expect(result.finishReason).toBe("escalated");
    expect(result.proposals[0]?.label).toBe("run_deadline_exceeded");
  });

  it("honors a custom maxProposalChars", async () => {
    const long: ModelCompletion = { text: "abcdefghij".repeat(50), label: "happy_reply", usage: { inputTokens: 5, outputTokens: 5 } };
    const gateway = countingGateway(async () => long);
    const h = new AgentHarness({
      gateway,
      releases: new InMemoryAgentReleaseStore(),
      tools: tools(),
      budgets: { maxProposalChars: 10 },
    });
    const result = await h.run(request("Olá"));
    expect(result.proposals[0]?.text).toBe("abcdefghij");
  });

  it("lets non-timeout dispatcher throws propagate (no behavior change)", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "crm.lookup_person",
      tenantScope: "tenant",
      riskClass: "R0",
      inputSchema: z.object({ personId: z.string().uuid() }),
      execute: async () => {
        throw new Error("host dispatcher bug");
      },
    });
    const h = new AgentHarness({
      gateway: new EchoModelGateway(),
      releases: new InMemoryAgentReleaseStore(),
      tools: registry,
    });
    await expect(h.run(request("quero ver meus dados"))).rejects.toThrow(/host dispatcher bug/);
  });
});

describe("model fallback (honest direction)", () => {
  function harnessWith(primary: ModelGatewayPort & { calls: number }, fallback: ModelGatewayPort & { calls: number }) {
    return new AgentHarness({
      gateway: primary,
      fallback,
      releases: new InMemoryAgentReleaseStore(),
      tools: tools(),
      budgets: { maxModelAttempts: 2 },
    });
  }

  it("uses the fallback once after TRANSIENT exhaustion and traces it", async () => {
    const primary = countingGateway(async () => {
      throw new ModelGatewayError("HTTP 503", "TRANSIENT");
    }, "primary-stub");
    const secondary = countingGateway(async () => happy, "secondary-stub");
    const result = await harnessWith(primary, secondary).run(request("Olá"));
    expect(primary.calls).toBe(2);
    expect(secondary.calls).toBe(1);
    expect(result.finishReason).toBe("proposal_ready");
    expect(result.trace).toContain("model:fallback:secondary-stub:happy_reply");
  });

  it("never falls back on FATAL (a second model cannot fix a bad answer)", async () => {
    const primary = countingGateway(async () => {
      throw new ModelGatewayError("model output failed the safety post-check", "FATAL");
    }, "primary-stub");
    const secondary = countingGateway(async () => happy, "secondary-stub");
    await expect(harnessWith(primary, secondary).run(request("Olá"))).rejects.toThrow(/safety post-check/);
    expect(primary.calls).toBe(1);
    expect(secondary.calls).toBe(0);
  });

  it("rejects loudly when the fallback also fails (no fabricated resilience)", async () => {
    const primary = countingGateway(async () => {
      throw new ModelGatewayError("HTTP 503", "TRANSIENT");
    }, "primary-stub");
    const secondary = countingGateway(async () => {
      throw new ModelGatewayError("secondary down", "TRANSIENT");
    }, "secondary-stub");
    await expect(harnessWith(primary, secondary).run(request("Olá"))).rejects.toThrow(/secondary down/);
    expect(secondary.calls).toBe(1);
  });
});
