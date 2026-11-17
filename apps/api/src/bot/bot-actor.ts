import type { CommandActor } from "@iptv/domain";

/**
 * @internal Synthetic principal. Its broad billing permission is mitigated by
 * the fixed command allowlist in streammax-bot-adapter; never execute the bus directly.
 */
export function botActor(tenantId: string): CommandActor {
  return {
    userId: `streammax-bot:${tenantId}`,
    isPlatformAdmin: false,
    tenantId,
    roleKeys: [],
    // M2 commerce writes and M3 ticket opening are constrained by adapter call paths.
    permissions: ["crm.lead.write", "conversation.reply", "commerce.order.write", "billing.charge.write", "support.ticket.write"],
    actorType: "external",
  };
}
