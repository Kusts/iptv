import { z } from "zod";
import { buildEnvelope } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type {
  AppTx,
  CommandBus,
  CommandHandlerContext,
  StoredReviewRequest,
} from "../commands/command-bus.js";

/**
 * Minimal HumanReview substrate (W1-07a) wired as the first real commands.
 *
 * - `human_review.request` creates a tenant-scoped `REQUESTED` row and NEVER
 *   executes the underlying action; refund execution stays human-required.
 * - `human_review.approve` / `human_review.reject` record an audited,
 *   append-only decision action and resolve the request — but only after
 *   STALE-APPROVAL REVALIDATION: the target preconditions are re-checked
 *   under current state (open-status optimistic check + pluggable target
 *   revalidator). Stale approvals are rejected (`precondition_failed`) and
 *   the request stays open for another reviewer.
 * - Only the owning context transitions its aggregate: these commands touch
 *   `agent.human_review_*` only, never the target entity itself.
 */

export const REVIEW_MODES = ["APPROVAL", "REVIEW", "GUIDANCE", "MANUAL_EXECUTION"] as const;
export const REVIEW_REASONS = [
  "SECURITY_CHALLENGE",
  "PROVIDER_EXCEPTION",
  "RISK_REVIEW",
  "FINANCIAL_REVIEW",
  "CONTENT_COMPLIANCE",
  "OTHER",
] as const;
export const REVIEW_RISK_CLASSES = ["R0", "R1", "R2", "R3", "R4"] as const;
export const REVIEW_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

/** Open queue (mirrors the `human_review_queue_idx` predicate). */
export const OPEN_REVIEW_STATUSES = ["REQUESTED", "QUEUED", "ACKNOWLEDGED", "IN_REVIEW"] as const;

export const requestReviewInput = z.object({
  resourceType: z.string().min(1).max(120),
  resourceId: z.string().uuid(),
  reviewMode: z.enum(REVIEW_MODES),
  reason: z.enum(REVIEW_REASONS),
  summary: z.string().trim().min(1).max(2000),
  riskClass: z.enum(REVIEW_RISK_CLASSES).default("R2"),
  priority: z.enum(REVIEW_PRIORITIES).default("NORMAL"),
  contextJson: z.record(z.string(), z.unknown()).default({}),
});

export type RequestReviewInput = z.infer<typeof requestReviewInput>;

export const decideReviewInput = z.object({
  requestId: z.string().uuid(),
  /**
   * Optimistic concurrency guard: the status the reviewer saw when opening
   * the queue item. Mismatch → stale → `precondition_failed`.
   */
  expectedStatus: z.enum(OPEN_REVIEW_STATUSES).optional(),
  note: z.string().trim().max(2000).optional(),
});

export type DecideReviewInput = z.infer<typeof decideReviewInput>;

/**
 * Target revalidation hook: re-check the underlying action's preconditions
 * under current state at decision time. Return a failure message to reject
 * the decision as stale, or null to accept. The request stays open on
 * rejection so another reviewer can decide later.
 */
export type TargetRevalidator = (
  ctx: CommandHandlerContext,
  request: StoredReviewRequest,
) => Promise<string | null>;

async function defaultRevalidator(): Promise<string | null> {
  return null;
}

async function emitAndEnqueue(
  ctx: CommandHandlerContext,
  input: {
    eventType: string;
    aggregateId: string;
    data: Record<string, unknown>;
  },
): Promise<void> {
  const version = await ctx.tx.nextAggregateVersion("human_review", input.aggregateId);
  const envelope = buildEnvelope({
    event_type: input.eventType,
    tenant_id: ctx.tenantId,
    aggregate_type: "human_review",
    aggregate_id: input.aggregateId,
    aggregate_version: version,
    data: input.data,
    actor: { type: ctx.actor.actorType, id: ctx.actor.userId },
    correlation_id: ctx.correlationId,
    causation_id: ctx.causationId,
  });
  const { domainEventId } = await ctx.tx.emitDomainEvent({ envelope });
  await ctx.tx.enqueueOutbox({
    domainEventId,
    topic: input.eventType,
    messageKey: input.aggregateId,
    payload: envelope,
    headers: { correlation_id: ctx.correlationId },
  });
}

async function handleRequest(
  ctx: CommandHandlerContext,
  input: RequestReviewInput,
): Promise<CommandResult<{ id: string }>> {
  const stored = await ctx.tx.createReviewRequest({
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    reviewMode: input.reviewMode,
    reason: input.reason,
    riskClass: input.riskClass,
    priority: input.priority,
    summary: input.summary,
    contextJson: input.contextJson,
    requestedByType: ctx.actor.actorType,
    requestedById: ctx.actor.userId,
  });
  await emitAndEnqueue(ctx, {
    eventType: "hitl.review_requested.v1",
    aggregateId: stored.id,
    data: {
      review_id: stored.id,
      review_mode: stored.reviewMode,
      reason: stored.reason,
      resource_type: stored.resourceType,
      resource_id: stored.resourceId,
      risk_class: stored.riskClass,
    },
  });
  return { ok: true, data: { id: stored.id } };
}

function decideHandler(resolution: "APPROVED" | "REJECTED", actionType: "APPROVE" | "REJECT", revalidate: TargetRevalidator) {
  return async (
    ctx: CommandHandlerContext,
    input: DecideReviewInput,
  ): Promise<CommandResult<{ id: string; resolution: string }>> => {
    const request = await ctx.tx.getReviewRequest(input.requestId);
    if (request === null) {
      return { ok: false, code: "not_found", message: "human review request not found" };
    }
    if (!(OPEN_REVIEW_STATUSES as readonly string[]).includes(request.status)) {
      return {
        ok: false,
        code: "precondition_failed",
        message: `stale decision rejected: review is already ${request.status}`,
      };
    }
    if (input.expectedStatus !== undefined && input.expectedStatus !== request.status) {
      return {
        ok: false,
        code: "precondition_failed",
        message: `stale approval rejected: expected ${input.expectedStatus}, current ${request.status}`,
      };
    }
    const targetFailure = await revalidate(ctx, request);
    if (targetFailure !== null) {
      return { ok: false, code: "precondition_failed", message: `stale approval rejected: ${targetFailure}` };
    }
    await ctx.tx.createReviewAction(request.id, actionType, ctx.actor.userId, {
      note: input.note ?? null,
      previous_status: request.status,
      resolution,
    });
    const resolved = await ctx.tx.resolveReviewRequest(request.id);
    if (resolved === null) {
      return { ok: false, code: "precondition_failed", message: "review was resolved concurrently" };
    }
    await emitAndEnqueue(ctx, {
      eventType: "hitl.review_resolved.v1",
      aggregateId: request.id,
      data: { review_id: request.id, resolution },
    });
    return { ok: true, data: { id: request.id, resolution } };
  };
}

export function registerHumanReviewCommands(
  bus: CommandBus,
  opts: { revalidate?: TargetRevalidator } = {},
): void {
  const revalidate = opts.revalidate ?? defaultRevalidator;
  bus.register<RequestReviewInput, { id: string }>({
    name: "human_review.request",
    permission: "agent.review.request",
    auditAction: "human_review.request",
    auditResource: "human_review_request",
    input: requestReviewInput,
    handler: handleRequest,
  });
  bus.register<DecideReviewInput, { id: string; resolution: string }>({
    name: "human_review.approve",
    permission: "agent.review.decide",
    auditAction: "human_review.approve",
    auditResource: "human_review_request",
    input: decideReviewInput,
    handler: decideHandler("APPROVED", "APPROVE", revalidate),
  });
  bus.register<DecideReviewInput, { id: string; resolution: string }>({
    name: "human_review.reject",
    permission: "agent.review.decide",
    auditAction: "human_review.reject",
    auditResource: "human_review_request",
    input: decideReviewInput,
    handler: decideHandler("REJECTED", "REJECT", revalidate),
  });
}

/** Re-export for tests wiring a custom revalidator. */
export type { AppTx, StoredReviewRequest };
