import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AgentHarness,
  EchoModelGateway,
  InMemoryAgentReleaseStore,
  ToolRegistry,
  type ToolFailureKind,
} from "@iptv/ai-runtime";
import { shouldEvaluateConversation } from "./pipeline.js";

/**
 * Offline eval runner (Wave 3 skeleton): every fixture under
 * `test/fixtures/agent-evals/*.json` runs through the deterministic echo
 * gateway + real harness, and the labelled output is compared to the
 * expected label/kind. CI-testable without credentials; the eval endpoint
 * (`POST /v1/agent/evals/run`) always uses echo, never a live model.
 */

export interface AgentEvalCase {
  id: string;
  description?: string;
  inbound: string;
  suppressionsActive?: boolean;
  controlMode?: string;
  /** When set, the lookup tool returns this failure instead of succeeding. */
  toolFailure?: ToolFailureKind;
  expectedLabel: string;
  expectedKind?: "REPLY" | "REFUSE" | "ESCALATE";
  /** Takeover-style cases expect NO evaluation at all. */
  expectEval?: boolean;
  expectedToolStatus?: string;
}

export interface AgentEvalCaseResult {
  id: string;
  expected: string;
  actual: string;
  pass: boolean;
  detail?: string;
}

export interface AgentEvalSummary {
  total: number;
  passed: number;
  failed: number;
  cases: AgentEvalCaseResult[];
}

const EVAL_TENANT = "00000000-0000-4000-8000-000000000001";

export function evalFixturesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "test", "fixtures", "agent-evals");
}

export function loadEvalCases(dir: string = evalFixturesDir()): AgentEvalCase[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.map((file) => {
    const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as AgentEvalCase;
    if (typeof parsed.id !== "string" || typeof parsed.inbound !== "string" || typeof parsed.expectedLabel !== "string") {
      throw new Error(`invalid eval fixture: ${file}`);
    }
    return parsed;
  });
}

export async function runAgentEvalSet(cases: AgentEvalCase[] = loadEvalCases()): Promise<AgentEvalSummary> {
  const results: AgentEvalCaseResult[] = [];
  for (const fixture of cases) {
    // Takeover-underway cases assert the pipeline gate, not the model.
    if (fixture.expectEval === false) {
      const gate = shouldEvaluateConversation({
        status: "OPEN",
        controlMode: fixture.controlMode ?? "HUMAN_CONTROL",
      });
      const pass = gate.evaluate === false;
      results.push({
        id: fixture.id,
        expected: "no_eval",
        actual: gate.evaluate ? "evaluated" : "no_eval",
        pass,
        detail: pass ? undefined : `expected no evaluation, gate said evaluate (${gate.reason})`,
      });
      continue;
    }

    const tools = new ToolRegistry();
    const failure = fixture.toolFailure;
    tools.register({
      name: "crm.lookup_person",
      tenantScope: "tenant",
      riskClass: "R0",
      inputSchema: z.object({ personId: z.string().uuid() }),
      execute: async () =>
        failure !== undefined
          ? { ok: false as const, code: "EVAL_TOOL_FAILURE", message: "eval-injected tool failure", failureKind: failure }
          : { ok: true as const, output: { person_id: "eval" } },
    });
    const harness = new AgentHarness({
      gateway: new EchoModelGateway(),
      releases: new InMemoryAgentReleaseStore(),
      tools,
    });
    const conversationId = "00000000-0000-4000-8000-000000000002";
    const result = await harness.run({
      tenantId: EVAL_TENANT,
      conversationId,
      releaseId: "customer-agent-v1",
      mode: "SHADOW",
      allowedTools: ["crm.lookup_person"],
      context: {
        tenantId: EVAL_TENANT,
        conversationId,
        channel: "WHATSAPP",
        controlMode: "AI_CONTROL",
        personSummary: { personId: "00000000-0000-4000-8000-000000000003", canonicalName: "Eval Person", locale: "pt-BR" },
        recentMessages: [{ direction: "INBOUND", senderType: "PERSON", bodyText: fixture.inbound, occurredAt: new Date().toISOString() }],
        policySummary: { allowAutonomous: false, notes: [] },
        suppressionsActive: fixture.suppressionsActive ?? false,
        openReviewCount: 0,
      },
      inboundText: fixture.inbound,
    });
    const proposal = result.proposals[0];
    if (proposal === undefined) {
      results.push({ id: fixture.id, expected: fixture.expectedLabel, actual: "none", pass: false, detail: "no proposal" });
      continue;
    }
    const labelOk = proposal.label === fixture.expectedLabel;
    const kindOk = fixture.expectedKind === undefined || proposal.kind === fixture.expectedKind;
    let toolOk = true;
    let toolDetail: string | undefined;
    if (fixture.expectedToolStatus !== undefined) {
      const call = result.toolCalls.find((c) => c.name === "crm.lookup_person");
      toolOk = call?.status === fixture.expectedToolStatus;
      if (!toolOk) {
        toolDetail = `expected tool status ${fixture.expectedToolStatus}, got ${call?.status ?? "no call"}`;
      }
    }
    const pass = labelOk && kindOk && toolOk;
    results.push({
      id: fixture.id,
      expected: `${fixture.expectedLabel}${fixture.expectedKind ? `/${fixture.expectedKind}` : ""}`,
      actual: `${proposal.label}/${proposal.kind}`,
      pass,
      detail: pass ? undefined : [labelOk ? null : "label mismatch", kindOk ? null : "kind mismatch", toolDetail ?? null].filter(Boolean).join("; "),
    });
  }
  const passed = results.filter((r) => r.pass).length;
  return { total: results.length, passed, failed: results.length - passed, cases: results };
}
