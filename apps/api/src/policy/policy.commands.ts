import { z } from "zod";
import { POLICY_CLASSES, POLICY_SCOPES, scopeMatchesClass } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";

/**
 * Policy publish command (W1-09).
 *
 * - Tenant admins (permission `settings.manage`) publish TENANT drafts/versions.
 * - Platform admins publish PLATFORM and PARTNER documents.
 * - Publishing a new version = a new row with version+1; no domain event is
 *   emitted (families stay generic jsonb; concrete families land in later
 *   waves). The bus audit covers the mutation.
 */

export const publishPolicyInput = z.object({
  family: z.string().trim().min(1).max(120),
  scope: z.enum(POLICY_SCOPES),
  class: z.enum(POLICY_CLASSES),
  document: z.record(z.string(), z.unknown()),
  status: z.enum(["DRAFT", "PUBLISHED"]).default("PUBLISHED"),
  /** PARTNER scope target tenant (defaults to the actor's tenant). */
  partnerTenantId: z.string().uuid().optional(),
});

export type PublishPolicyInput = z.infer<typeof publishPolicyInput>;

async function handlePublish(
  ctx: CommandHandlerContext,
  input: PublishPolicyInput,
): Promise<CommandResult<{ id: string; version: number }>> {
  if (!scopeMatchesClass(input.scope, input.class)) {
    return {
      ok: false,
      code: "validation_failed",
      message: `scope ${input.scope} does not match class ${input.class}`,
    };
  }
  const platformScoped = input.scope === "PLATFORM" || input.scope === "PARTNER";
  if (platformScoped && !ctx.actor.isPlatformAdmin) {
    return { ok: false, code: "forbidden", message: "only platform admins publish PLATFORM/PARTNER policy" };
  }
  const targetTenant =
    input.scope === "PLATFORM" ? null : (input.partnerTenantId ?? ctx.tenantId);
  if (input.partnerTenantId !== undefined && input.scope !== "PARTNER") {
    // An explicit cross-tenant target is only meaningful for PARTNER scope:
    // TENANT publishes always bind the actor's tenant, PLATFORM rows carry
    // no tenant. Fail closed instead of silently ignoring the target.
    return {
      ok: false,
      code: "validation_failed",
      message: "partnerTenantId is only allowed with PARTNER scope",
    };
  }
  const version = await ctx.tx.nextPolicyVersion(input.family, input.scope, targetTenant);
  const stored = await ctx.tx.createPolicyDocument({
    tenantId: targetTenant,
    family: input.family,
    scope: input.scope,
    class: input.class,
    version,
    status: input.status,
    document: input.document,
    publishedAt: input.status === "PUBLISHED" ? new Date() : null,
  });
  return { ok: true, data: { id: stored.id, version: stored.version } };
}

export function registerPolicyCommands(bus: CommandBus): void {
  bus.register<PublishPolicyInput, { id: string; version: number }>({
    name: "policy.publish",
    permission: "settings.manage",
    auditAction: "policy.publish",
    auditResource: "policy_document",
    input: publishPolicyInput,
    handler: handlePublish,
  });
}
