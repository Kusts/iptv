import { z } from "zod";
import { newId, now } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { emitAndEnqueue, kyselyTrxOf } from "../crm/wave2-store.js";
import { OPEN_REVIEW_STATUSES } from "./human-review.commands.js";

/**
 * Wave 8 `human_review.claim` (HITL center assignment).
 *
 * Claims an OPEN review for the calling user: sets `assigned_to_user_id`
 * (the 010 column + membership FK — only an ACTIVE member of the same
 * tenant can hold it), moves REQUESTED/QUEUED → ACKNOWLEDGED, records the
 * append-only ACKNOWLEDGE action, and emits registry-listed
 * `hitl.review_acknowledged.v1`. Decisions stay on approve/reject
 * (`agent.review.decide`); claiming needs only `agent.review.request`.
 *
 * Rules: already claimed by ANOTHER user → `precondition_failed` (no
 * stealing; release is a future explicit command). Re-claim by the same
 * user is idempotent (`already: true`).
 */

export const claimReviewInput = z.object({ requestId: z.string().uuid() });
export type ClaimReviewInput = z.infer<typeof claimReviewInput>;

async function handleClaim(
  ctx: CommandHandlerContext,
  input: ClaimReviewInput,
): Promise<CommandResult<{ id: string; assigneeUserId: string; already: boolean }>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    return { ok: false, code: "precondition_failed", message: "claim requires a database transaction" };
  }
  const row = await trx
    .selectFrom("agent.human_review_requests")
    .select(["id", "status", "assigned_to_user_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.requestId)
    .executeTakeFirst();
  if (row === undefined) {
    return { ok: false, code: "not_found", message: "human review request not found" };
  }
  if (!(OPEN_REVIEW_STATUSES as readonly string[]).includes(row.status)) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `review is already ${row.status}; only open reviews can be claimed`,
    };
  }
  if (row.assigned_to_user_id !== null && row.assigned_to_user_id !== ctx.actor.userId) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "review is already claimed by another member",
    };
  }
  const membership = await trx
    .selectFrom("control.tenant_memberships")
    .select("id")
    .where("tenant_id", "=", ctx.tenantId)
    .where("user_id", "=", ctx.actor.userId)
    .where("status", "=", "ACTIVE")
    .executeTakeFirst();
  if (membership === undefined) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "claimer has no active membership in this tenant",
    };
  }
  if (row.assigned_to_user_id === ctx.actor.userId && row.status === "ACKNOWLEDGED") {
    return { ok: true, data: { id: row.id, assigneeUserId: ctx.actor.userId, already: true } };
  }
  const nextStatus = row.status === "REQUESTED" || row.status === "QUEUED" ? "ACKNOWLEDGED" : row.status;
  const updated = await trx
    .updateTable("agent.human_review_requests")
    .set({ assigned_to_user_id: ctx.actor.userId, status: nextStatus })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", row.id)
    .where("status", "=", row.status)
    .returning("id")
    .executeTakeFirst();
  if (updated === undefined) {
    return { ok: false, code: "precondition_failed", message: "review changed concurrently" };
  }
  await trx
    .insertInto("agent.human_review_actions")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      human_review_request_id: row.id,
      action_type: "ACKNOWLEDGE",
      actor_user_id: ctx.actor.userId,
      content_json: { previous_status: row.status, claimed: true },
      created_at: now(),
    })
    .execute();
  await emitAndEnqueue(ctx, {
    eventType: "hitl.review_acknowledged.v1",
    aggregateType: "human_review",
    aggregateId: row.id,
    data: { review_id: row.id, claimed_by: ctx.actor.userId, from_status: row.status },
  });
  return { ok: true, data: { id: row.id, assigneeUserId: ctx.actor.userId, already: false } };
}

export function registerClaimCommands(bus: CommandBus): void {
  bus.register<ClaimReviewInput, { id: string; assigneeUserId: string; already: boolean }>({
    name: "human_review.claim",
    permission: "agent.review.request",
    auditAction: "human_review.claim",
    auditResource: "human_review_request",
    input: claimReviewInput,
    handler: handleClaim,
  });
}
