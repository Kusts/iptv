import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import { withTenantTransaction, type Database } from "@iptv/database";
import {
  AgentHarness,
  ToolRegistry,
  gatewayFromEnv,
  type AgentRunResult,
} from "@iptv/ai-runtime";
import type { CommandActor } from "@iptv/domain";
import { newId, now } from "@iptv/domain";
import { CommandBus } from "../commands/command-bus.js";
import { ActionGate, type CapabilityStore } from "../capabilities/capability-registry.js";
import { ContextBuilder } from "./context-builder.js";
import { KyselyAgentReleaseStore } from "./release-store.js";
import { createCrmLookupTool, createToolDispatcher } from "./crm-lookup.tool.js";

const DEFAULT_RELEASE_KEY = "customer-agent-v1";
const AUTONOMY_CAPABILITY_KEY = "ai.reply_autonomous";
const CLOSED_STATUSES = ["RESOLVED", "ARCHIVED"];

/** Pure evaluation gate shared by the pipeline and the eval runner (unit-honest). */
export function shouldEvaluateConversation(conv: { status: string; controlMode: string }):
  | { evaluate: true; reason: "open" }
  | { evaluate: false; reason: "closed" | "takeover" | "paused" } {
  if (CLOSED_STATUSES.includes(conv.status)) {
    return { evaluate: false, reason: "closed" };
  }
  if (conv.controlMode === "HUMAN_CONTROL") {
    return { evaluate: false, reason: "takeover" };
  }
  if (conv.controlMode === "PAUSED") {
    return { evaluate: false, reason: "paused" };
  }
  return { evaluate: true, reason: "open" };
}

export type EvaluateOutcome =
  | { evaluated: false; reason: "not_found" | "closed" | "takeover" | "paused" | "no_db" }
  | { evaluated: true; runId: string; mode: "SHADOW" | "LIVE"; reviewId: string | null; sent: boolean };

function agentActor(tenantId: string, permissions: string[]): CommandActor {
  return {
    userId: "agent-pipeline",
    isPlatformAdmin: false,
    tenantId,
    roleKeys: [],
    permissions,
    actorType: "agent",
  };
}

/**
 * Wave 3 agent pipeline: inbound message → evaluation → approval → send.
 *
 * - SHADOW is the default: the harness proposes, the proposal is persisted
 *   as an `agent_runs` row, and a `human_review.request` (APPROVAL) carries
 *   the proposed reply. Shadow runs NEVER send.
 * - LIVE (direct send) happens ONLY when every AUTO condition holds:
 *   capability `ai.reply_autonomous` is AVAILABLE + CERTIFIED, the
 *   ActionGate resolves AUTO, AND tenant `agent` policy explicitly allows
 *   autonomous send. Anything else downgrades to APPROVAL (downgrade-only:
 *   the pipeline never upgrades a gate/policy denial).
 * - Resume: human approve → revalidate conversation state → `message.send_manual`
 *   (the SAME command the frontend uses); reject → discard logged.
 * - Direct reads/writes on RLS-enrolled tables (`communication.*`,
 *   `agent.agent_runs`/`agent.agent_tasks`) run inside
 *   `withTenantTransaction` (actor tenant); bus-owned writes stay in-tx
 *   under the bus itself. `agent.agent_releases` is a GLOBAL catalog read
 *   (no RLS by design) and stays unwrapped.
 */
@Injectable()
export class AgentPipeline {
  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject(CommandBus) private readonly bus: CommandBus,
    @Inject(ContextBuilder) private readonly contexts: ContextBuilder,
    @Inject(KyselyAgentReleaseStore) private readonly releases: KyselyAgentReleaseStore,
    @Inject("CAPABILITY_STORE") private readonly capabilities: CapabilityStore,
    @Inject(ActionGate) private readonly gate: ActionGate,
  ) {}

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new Error("database is not configured");
    }
    return this.db;
  }

  async evaluateInbound(input: {
    tenantId: string;
    conversationId: string;
    inboundText: string;
    correlationId?: string;
  }): Promise<EvaluateOutcome> {
    if (this.db === null) {
      return { evaluated: false, reason: "no_db" };
    }
    const db = this.requireDb();
    // RLS-enrolled read (042): `communication.conversations` fail-closes
    // without `app.tenant_id`, so the pre-check runs inside
    // `withTenantTransaction` (actor tenant). Predicate stays as
    // defense-in-depth.
    const conv = await withTenantTransaction(db, input.tenantId, (trx) =>
      trx
        .selectFrom("communication.conversations")
        .select(["id", "status", "control_mode"])
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.conversationId)
        .executeTakeFirst(),
    );
    if (conv === undefined) {
      return { evaluated: false, reason: "not_found" };
    }
    const gate = shouldEvaluateConversation({ status: conv.status, controlMode: conv.control_mode });
    if (!gate.evaluate) {
      return { evaluated: false, reason: gate.reason };
    }

    const context = await this.contexts.build(input.tenantId, input.conversationId);
    if (context === null) {
      return { evaluated: false, reason: "not_found" };
    }

    const capability = await this.capabilities.get(AUTONOMY_CAPABILITY_KEY);
    const resolution = await this.gate.resolve(capability, agentActor(input.tenantId, ["conversation.reply"]), {
      tenantId: input.tenantId,
    });
    // Downgrade-only AUTO: certified + available + gate AUTO + explicit
    // tenant policy allow. The default (UNCERTIFIED/UNAVAILABLE) always
    // lands in SHADOW → APPROVAL.
    const autoEligible =
      capability !== null &&
      capability.availability === "AVAILABLE" &&
      capability.certificationStatus === "CERTIFIED" &&
      resolution.action === "AUTO" &&
      context.policySummary.allowAutonomous;
    const mode = autoEligible ? "LIVE" : "SHADOW";

    const tools = new ToolRegistry();
    tools.register(createCrmLookupTool());
    const harness = new AgentHarness({
      gateway: gatewayFromEnv(),
      releases: this.releases,
      tools,
      dispatch: createToolDispatcher(this.db),
    });
    const result: AgentRunResult = await harness.run({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      releaseId: DEFAULT_RELEASE_KEY,
      mode,
      allowedTools: ["crm.lookup_person"],
      context,
      inboundText: input.inboundText,
    });
    const proposal = result.proposals[0];
    if (proposal === undefined) {
      throw new Error("harness returned no proposal");
    }

    const runId = newId();
    const release = await this.releases.getPublished(DEFAULT_RELEASE_KEY);
    // RLS-enrolled writes (057): `agent.agent_runs` / `agent.agent_tasks`
    // fail-closed (WITH CHECK) without `app.tenant_id`, so the run + its
    // task rows persist atomically inside one `withTenantTransaction`
    // (actor tenant). Predicates/values unchanged — same rows as before.
    await withTenantTransaction(db, input.tenantId, async (trx) => {
      await trx
        .insertInto("agent.agent_runs")
        .values({
          id: runId,
          tenant_id: input.tenantId,
          conversation_id: input.conversationId,
          release_key: DEFAULT_RELEASE_KEY,
          release_version: release?.version ?? 1,
          mode,
          model: result.usage.model,
          status: "PROPOSED",
          proposal_kind: proposal.kind,
          proposal_label: proposal.label,
          proposal_text: proposal.text,
          tool_calls_json: JSON.stringify(result.toolCalls),
          usage_json: JSON.stringify(result.usage),
          trace_json: JSON.stringify(result.trace),
          human_review_request_id: null,
          created_at: now(),
          decided_at: null,
        })
        .execute();
      for (const call of result.toolCalls) {
        await trx
          .insertInto("agent.agent_tasks")
          .values({
            id: newId(),
            tenant_id: input.tenantId,
            run_id: runId,
            kind: "specialist_tool",
            tool_name: call.name,
            status: call.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
            input_json: JSON.stringify({ conversation_id: input.conversationId }),
            output_json: JSON.stringify({ status: call.status, failure_kind: call.failureKind }),
            created_at: now(),
            completed_at: now(),
          })
          .execute();
      }
    });

    if (mode === "LIVE") {
      // Certified autonomous path only: send through the SAME command the
      // frontend uses (still recorded + audited by the bus).
      const sent = await this.bus.execute<{
        messageId: string;
        deliveryStatus: string;
        providerMessageId: string | null;
      }>(
        agentActor(input.tenantId, ["conversation.reply"]),
        "message.send_manual",
        { conversationId: input.conversationId, text: proposal.text },
        { correlationId: input.correlationId ?? newId(), causationId: null },
      );
      if (!sent.ok) {
        await this.markRun(input.tenantId, runId, "FAILED");
        return { evaluated: true, runId, mode, reviewId: null, sent: false };
      }
      await this.markRun(input.tenantId, runId, "SENT");
      return { evaluated: true, runId, mode, reviewId: null, sent: true };
    }

    // SHADOW: propose only — NEVER send. The proposal goes to HumanReview.
    const review = await this.bus.execute<{ id: string }>(
      agentActor(input.tenantId, ["agent.review.request"]),
      "human_review.request",
      {
        resourceType: "agent_proposal",
        resourceId: runId,
        reviewMode: "APPROVAL",
        reason: "RISK_REVIEW",
        riskClass: "R1",
        priority: "NORMAL",
        summary: proposal.text.slice(0, 1500),
        contextJson: {
          agent_run_id: runId,
          conversation_id: input.conversationId,
          proposal_kind: proposal.kind,
          proposal_label: proposal.label,
          mode,
        },
      },
      { correlationId: input.correlationId ?? newId(), causationId: null },
    );
    if (!review.ok) {
      await this.markRun(input.tenantId, runId, "FAILED");
      return { evaluated: true, runId, mode, reviewId: null, sent: false };
    }
    await withTenantTransaction(db, input.tenantId, (trx) =>
      trx
        .updateTable("agent.agent_runs")
        .set({ human_review_request_id: review.data.id })
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", runId)
        .execute(),
    );
    return { evaluated: true, runId, mode, reviewId: review.data.id, sent: false };
  }

  /**
   * Resume path: human approves the review → revalidate conversation state
   * (open + not under takeover; stale approvals become SUPERSEDED) →
   * `message.send_manual` with the human approver as actor.
   */
  async resumeApproved(input: { tenantId: string; reviewId: string; actor: CommandActor }): Promise<
    | { ok: true; sent: boolean; messageId: string | null }
    | { ok: false; code: "not_found" | "forbidden" | "validation_failed" | "precondition_failed"; message: string }
  > {
    const db = this.requireDb();
    // RLS-enrolled reads (057 run lookup + 042 conversation revalidation):
    // both fail-close without `app.tenant_id`, so they run together inside
    // one `withTenantTransaction` (actor tenant). Predicates unchanged.
    const { run, conv } = await withTenantTransaction(db, input.tenantId, async (trx) => {
      const run = await trx
        .selectFrom("agent.agent_runs")
        .select(["id", "conversation_id", "status", "proposal_kind", "proposal_text"])
        .where("tenant_id", "=", input.tenantId)
        .where("human_review_request_id", "=", input.reviewId)
        .executeTakeFirst();
      const conv =
        run === undefined || run.conversation_id === null
          ? undefined
          : await trx
              .selectFrom("communication.conversations")
              .select(["id", "status", "control_mode"])
              .where("tenant_id", "=", input.tenantId)
              .where("id", "=", run.conversation_id)
              .executeTakeFirst();
      return { run, conv };
    });
    if (run === undefined || run.conversation_id === null) {
      return { ok: false, code: "not_found", message: "agent run not found for this review" };
    }
    if (run.status !== "PROPOSED") {
      return { ok: false, code: "precondition_failed", message: `agent run is already ${run.status}` };
    }
    // Stale-approval revalidation under current state.
    if (conv === undefined || CLOSED_STATUSES.includes(conv.status)) {
      await this.markRun(input.tenantId, run.id, "SUPERSEDED");
      return { ok: false, code: "precondition_failed", message: "stale approval: conversation is closed" };
    }
    if (conv.control_mode === "HUMAN_CONTROL") {
      await this.markRun(input.tenantId, run.id, "SUPERSEDED");
      return { ok: false, code: "precondition_failed", message: "stale approval: conversation under human takeover" };
    }

    const approved = await this.bus.execute<{ id: string; resolution: string }>(input.actor, "human_review.approve", {
      requestId: input.reviewId,
    });
    if (!approved.ok) {
      return { ok: false, code: approved.code, message: approved.message };
    }
    if (run.proposal_kind !== "REPLY" || run.proposal_text === null) {
      // Approving a refusal/escalation acknowledges it — nothing to send.
      await this.markRun(input.tenantId, run.id, "DISCARDED");
      return { ok: true, sent: false, messageId: null };
    }
    const sent = await this.bus.execute<{
      messageId: string;
      deliveryStatus: string;
      providerMessageId: string | null;
    }>(input.actor, "message.send_manual", { conversationId: run.conversation_id, text: run.proposal_text });
    if (!sent.ok) {
      await this.markRun(input.tenantId, run.id, "FAILED");
      return { ok: false, code: sent.code, message: sent.message };
    }
    await this.markRun(input.tenantId, run.id, "SENT");
    return { ok: true, sent: true, messageId: sent.data.messageId };
  }

  /** Reject path: human rejects → decision logged, proposal discarded, nothing sent. */
  async resumeRejected(input: {
    tenantId: string;
    reviewId: string;
    actor: CommandActor;
    note?: string;
  }): Promise<
    | { ok: true }
    | { ok: false; code: "not_found" | "forbidden" | "validation_failed" | "precondition_failed"; message: string }
  > {
    const db = this.requireDb();
    const rejected = await this.bus.execute(input.actor, "human_review.reject", {
      requestId: input.reviewId,
      note: input.note,
    });
    if (!rejected.ok) {
      return { ok: false, code: rejected.code, message: rejected.message };
    }
    await withTenantTransaction(db, input.tenantId, (trx) =>
      trx
        .updateTable("agent.agent_runs")
        .set({ status: "DISCARDED", decided_at: now() })
        .where("tenant_id", "=", input.tenantId)
        .where("human_review_request_id", "=", input.reviewId)
        .where("status", "=", "PROPOSED")
        .execute(),
    );
    return { ok: true };
  }

  private async markRun(tenantId: string, runId: string, status: "SENT" | "DISCARDED" | "FAILED" | "SUPERSEDED"): Promise<void> {
    // RLS-enrolled write (057): `agent.agent_runs` WITH CHECK fail-closes
    // without `app.tenant_id`.
    await withTenantTransaction(this.requireDb(), tenantId, (trx) =>
      trx
        .updateTable("agent.agent_runs")
        .set({ status, decided_at: now() })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", runId)
        .execute(),
    );
  }
}
