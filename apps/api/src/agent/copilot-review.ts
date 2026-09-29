import type { CommandHandlerContext, StoredReviewRequest } from "../commands/command-bus.js";

/**
 * Copilot-aware HumanReview target revalidator (Wave 14-COPILOT fix).
 *
 * Reviews with resourceType `copilot_command` authorize exactly one
 * privileged Copilot execution, so two invariants hold at DECISION time:
 *
 * - NO SELF-APPROVAL: the requester (persisted `requestedById` at
 *   `human_review.request` time, never client input) cannot APPROVE their
 *   own review. They may still REJECT/withdraw it. Non-copilot reviews
 *   pass through untouched (another revalidator owns them).
 * - COPILOT BINDING: the review context must carry the Copilot marker
 *   (`copilotCommand`); a `copilot_command` review without it is stale.
 *
 * Single-use is enforced separately at EXECUTION time
 * (`CopilotService.executeApproved` claims
 * `agent.copilot_review_consumptions`): the revalidator below cannot burn
 * the approval because a rejected-then-reapproved review must stay usable.
 */

export const COPILOT_REVIEW_RESOURCE = "copilot_command";

export async function copilotTargetRevalidator(
  ctx: CommandHandlerContext,
  request: StoredReviewRequest,
  decision?: "APPROVED" | "REJECTED",
): Promise<string | null> {
  if (request.resourceType !== COPILOT_REVIEW_RESOURCE) {
    return null;
  }
  const context = request.contextJson;
  const marker =
    context !== null && typeof context === "object" && !Array.isArray(context)
      ? (context as Record<string, unknown>)["copilotCommand"]
      : undefined;
  if (typeof marker !== "string" || marker.length === 0) {
    return "copilot review context is missing its command binding";
  }
  if (
    decision === "APPROVED" &&
    request.requestedById !== null &&
    ctx.actor.userId === request.requestedById
  ) {
    return "self-approval forbidden: the requester cannot approve their own copilot action";
  }
  return null;
}
