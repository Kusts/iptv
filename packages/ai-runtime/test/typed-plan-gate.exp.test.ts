/**
 * BOUNDED EXPERIMENT #1 (DISCOVERY-RESEARCH) — typed plan validated before tool.
 *
 * Scope: local-only fixture. No provider/model swap (no gateway import, no
 * network), no harness/budget/policy change, no schema migration. All helpers
 * live in this file; production code is untouched.
 *
 * Fixture: 1 hallucinated action (crm.delete_everything, never registered)
 * + 1 write-tool (billing.issue_refund, R2, experiment-local only).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { estimateCostMicros, estimateTokensForChars } from "../src/budgets.js";
import { ToolRegistry, type ToolDispatcher } from "../src/tool-registry.js";

const PlanStepSchema = z.object({
  tool: z.string().min(1).max(120),
  input: z.unknown(),
});
const TypedPlanSchema = z.object({
  steps: z.array(PlanStepSchema).length(1),
});
type TypedPlan = z.infer<typeof TypedPlanSchema>;

type GateOk = { ok: true; tool: string; input: unknown };
type GateReject = { ok: false; code: string; message: string };
type GateResult = GateOk | GateReject;

/**
 * Experiment-local gate: validate a single-step typed plan against the
 * registry BEFORE any dispatch. Write tools (riskClass !== "R0") park for
 * human approval and never dispatch here.
 */
function validateTypedPlan(
  raw: unknown,
  registry: ToolRegistry,
  allowedTools: string[],
): GateResult {
  const parsed = TypedPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: "PLAN_SCHEMA_INVALID", message: "plan shape rejected" };
  }
  const step = parsed.data.steps[0] as TypedPlan["steps"][number];
  const descriptor = registry.get(step.tool);
  if (descriptor === null) {
    return { ok: false, code: "UNKNOWN_TOOL", message: `hallucinated action rejected: ${step.tool}` };
  }
  if (!allowedTools.includes(descriptor.name)) {
    return { ok: false, code: "TOOL_NOT_ALLOWED", message: `tool not in allowlist: ${descriptor.name}` };
  }
  const inputParsed = (descriptor.inputSchema as z.ZodType<unknown>).safeParse(step.input);
  if (!inputParsed.success) {
    return { ok: false, code: "TOOL_INPUT_INVALID", message: `invalid input for ${descriptor.name}` };
  }
  if (descriptor.riskClass !== "R0") {
    return { ok: false, code: "WRITE_REQUIRES_APPROVAL", message: `write tool parked: ${descriptor.name}` };
  }
  return { ok: true, tool: descriptor.name, input: inputParsed.data };
}

function experimentRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "crm.lookup_person",
    tenantScope: "tenant",
    riskClass: "R0",
    inputSchema: z.object({ personId: z.string().uuid() }),
    execute: async () => ({ ok: true, output: { canonicalName: "Lead" } }),
  });
  // Experiment-local write tool only: never registered in prod harness.
  registry.register({
    name: "billing.issue_refund",
    tenantScope: "tenant",
    riskClass: "R2",
    inputSchema: z.object({
      chargeId: z.string().uuid(),
      amountCents: z.number().int().positive().max(1_000_00),
    }),
    execute: async () => ({ ok: true, output: { refunded: true } }),
  });
  return registry;
}

const PERSON_ID = "33333333-3333-4333-8333-333333333333";
const CHARGE_ID = "44444444-4444-4444-8444-444444444444";

describe("EXP#1 typed plan gate (bounded, offline)", () => {
  it("rejects the hallucinated action before any dispatch (red→green)", async () => {
    const registry = experimentRegistry();
    let dispatchCalls = 0;
    const dispatch: ToolDispatcher = async () => {
      dispatchCalls += 1;
      return { ok: true, output: {} };
    };
    const gate = validateTypedPlan(
      { steps: [{ tool: "crm.delete_everything", input: {} }] },
      registry,
      ["crm.lookup_person", "billing.issue_refund"],
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe("UNKNOWN_TOOL");
    }
    // Gate closed: dispatch never runs for a rejected plan.
    if (gate.ok) {
      await dispatch(
        { tenantId: "t", actorType: "agent", actorId: "exp", conversationId: "c" },
        gate.tool,
        gate.input,
      );
    }
    expect(dispatchCalls).toBe(0);
  });

  it("parks the write-tool even with valid input (no execution without approval)", async () => {
    const registry = experimentRegistry();
    let dispatchCalls = 0;
    const dispatch: ToolDispatcher = async () => {
      dispatchCalls += 1;
      return { ok: true, output: { refunded: true } };
    };
    const gate = validateTypedPlan(
      { steps: [{ tool: "billing.issue_refund", input: { chargeId: CHARGE_ID, amountCents: 1000 } }] },
      registry,
      ["crm.lookup_person", "billing.issue_refund"],
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe("WRITE_REQUIRES_APPROVAL");
    }
    // Same conditional dispatch flow as the read scenario: dispatch only on gate.ok.
    if (gate.ok) {
      await dispatch(
        { tenantId: "t", actorType: "agent", actorId: "exp", conversationId: "c" },
        gate.tool,
        gate.input,
      );
    }
    expect(dispatchCalls).toBe(0);
  });

  it("rejects a multi-step plan: experiment is single-step only", async () => {
    const registry = experimentRegistry();
    let dispatchCalls = 0;
    const dispatch: ToolDispatcher = async () => {
      dispatchCalls += 1;
      return { ok: true, output: {} };
    };
    const gate = validateTypedPlan(
      {
        steps: [
          { tool: "crm.lookup_person", input: { personId: PERSON_ID } },
          { tool: "billing.issue_refund", input: { chargeId: CHARGE_ID, amountCents: 1000 } },
        ],
      },
      registry,
      ["crm.lookup_person", "billing.issue_refund"],
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe("PLAN_SCHEMA_INVALID");
    }
    // Same conditional dispatch flow: rejected plan never dispatches.
    if (gate.ok) {
      await dispatch(
        { tenantId: "t", actorType: "agent", actorId: "exp", conversationId: "c" },
        gate.tool,
        gate.input,
      );
    }
    expect(dispatchCalls).toBe(0);
  });

  it("accepts the valid read plan and reports local cost/latency (zero external cost)", async () => {
    const registry = experimentRegistry();
    let dispatchCalls = 0;
    const dispatch: ToolDispatcher = async () => {
      dispatchCalls += 1;
      return { ok: true, output: { canonicalName: "Lead" } };
    };
    const raw = { steps: [{ tool: "crm.lookup_person", input: { personId: PERSON_ID } }] };
    const startedAt = performance.now();
    const gate = validateTypedPlan(raw, registry, ["crm.lookup_person", "billing.issue_refund"]);
    const latencyMs = performance.now() - startedAt;
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      const res = await dispatch(
        { tenantId: "t", actorType: "agent", actorId: "exp", conversationId: "c" },
        gate.tool,
        gate.input,
      );
      expect(res.ok).toBe(true);
    }
    expect(dispatchCalls).toBe(1);
    // Local-only measurement: no model call, so zero provider tokens/cost.
    const planChars = JSON.stringify(raw).length;
    const costMicros = estimateCostMicros(estimateTokensForChars(planChars), 0, {
      inputMicrosPerToken: 0.15,
      outputMicrosPerToken: 0.6,
    });
    expect(costMicros).toBeGreaterThanOrEqual(0);
    expect(latencyMs).toBeLessThan(50);
    console.log(`[EXP#1] planChars=${planChars} latencyMs=${latencyMs.toFixed(2)} heuristicCostMicros=${costMicros.toFixed(2)} modelCalls=0`);
  });
});
