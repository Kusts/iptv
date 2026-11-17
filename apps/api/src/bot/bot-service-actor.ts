import type { CommandActor } from "@iptv/domain";
import type { BotServiceRequest } from "./bot-service.guard.js";

/**
 * Synthetic service principal. Tenant is credential-derived, never body-derived.
 * Actual command containment is enforced by the botExecute adapter.
 */
export function botServiceActor(botService: BotServiceRequest): CommandActor {
  return {
    userId: `streammax-bot:${botService.credentialId}`,
    tenantId: botService.tenantId,
    actorType: "external",
    isPlatformAdmin: false,
    roleKeys: [],
    permissions: ["crm.lead.write", "conversation.reply", "commerce.order.write", "billing.charge.write", "support.ticket.write"],
  };
}
