import { describe, expect, it } from "vitest";
import { gatewayFromEnv, EchoModelGateway } from "@iptv/ai-runtime";
import { shouldEvaluateConversation } from "../src/agent/pipeline.js";
import { checkEvalThresholds, CRITICAL_EVAL_IDS, loadEvalCases, runAgentEvalSet } from "../src/agent/eval-runner.js";
import { KyselyAgentReleaseStore } from "../src/agent/release-store.js";
import { createCrmLookupTool, createToolDispatcher } from "../src/agent/crm-lookup.tool.js";

describe("agent evaluation gate (pure)", () => {
  it("evaluates open AI-control conversations", () => {
    expect(shouldEvaluateConversation({ status: "OPEN", controlMode: "AI_CONTROL" })).toEqual({
      evaluate: true,
      reason: "open",
    });
  });

  it("skips human-takeover conversations (no-eval)", () => {
    expect(shouldEvaluateConversation({ status: "OPEN", controlMode: "HUMAN_CONTROL" })).toEqual({
      evaluate: false,
      reason: "takeover",
    });
  });

  it("skips paused and closed conversations", () => {
    expect(shouldEvaluateConversation({ status: "OPEN", controlMode: "PAUSED" }).evaluate).toBe(false);
    expect(shouldEvaluateConversation({ status: "RESOLVED", controlMode: "AI_CONTROL" }).evaluate).toBe(false);
    expect(shouldEvaluateConversation({ status: "ARCHIVED", controlMode: "AI_CONTROL" }).evaluate).toBe(false);
  });
});

describe("agent eval fixture set (offline, echo gateway)", () => {
  it("loads the full P2 baseline: 16 fixtures", () => {
    expect(loadEvalCases().length).toBeGreaterThanOrEqual(16);
  });

  it("passes the full fixture set with zero failures", async () => {
    const summary = await runAgentEvalSet();
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(summary.total);
  });

  it("holds the critical gate at 100% (AUTO precondition)", async () => {
    const summary = await runAgentEvalSet();
    const thresholds = checkEvalThresholds(summary);
    expect(thresholds.criticalTotal).toBe(CRITICAL_EVAL_IDS.length);
    expect(thresholds.criticalOk).toBe(true);
    expect(summary.thresholds.criticalOk).toBe(true);
  });

  it("defaults to the echo gateway without a key (fallback-model honesty)", () => {
    expect(gatewayFromEnv({})).toBeInstanceOf(EchoModelGateway);
  });
});

describe("agent release store fallback (no database)", () => {
  it("serves the default published release without a database", async () => {
    const store = new KyselyAgentReleaseStore(null);
    const release = await store.getPublished("customer-agent-v1");
    expect(release).toMatchObject({ key: "customer-agent-v1", status: "PUBLISHED" });
    expect(release?.allowedTools).toContain("crm.lookup_person");
    // Prompts carry behavior only: no prices, no secrets, no policy numbers.
    expect(`${release?.systemPrompt} ${release?.developerPrompt}`).not.toMatch(/R\$|\b\d{2,}\s*%|sk-/);
  });

  it("returns null for unknown releases", async () => {
    const store = new KyselyAgentReleaseStore(null);
    expect(await store.getPublished("no-such-release")).toBeNull();
  });
});

describe("crm.lookup_person tool descriptor", () => {
  it("declares tenant scope and validates input", () => {
    const tool = createCrmLookupTool();
    expect(tool.tenantScope).toBe("tenant");
    expect(tool.riskClass).toBe("R0");
    expect(tool.inputSchema.safeParse({ personId: "not-a-uuid" }).success).toBe(false);
  });

  it("dispatcher without a database reports a transient dependency failure", async () => {
    const tool = createCrmLookupTool();
    const dispatch = createToolDispatcher(null);
    const result = await dispatch(
      { tenantId: "t", actorType: "agent", actorId: "a", conversationId: "c" },
      "crm.lookup_person",
      { personId: "11111111-1111-4111-8111-111111111111" },
    );
    expect(result).toMatchObject({ ok: false, failureKind: "TRANSIENT" });
    void tool;
  });

  it("dispatcher rejects unknown tool commands as fatal", async () => {
    const dispatch = createToolDispatcher(null);
    const result = await dispatch(
      { tenantId: "t", actorType: "agent", actorId: "a", conversationId: "c" },
      "billing.refund_anything",
      {},
    );
    expect(result).toMatchObject({ ok: false, failureKind: "FATAL" });
  });
});
