/**
 * RBAC permission model (mirrors migration 012 seeds).
 *
 * - `User` here is the authenticated SaaS user (Identity context), never a
 *   CRM `Person`.
 * - Role catalog is global; tenant scoping lives in the assignments
 *   (`tenant_memberships.role_key` + `membership_roles`).
 * - Platform-role bypass applies ONLY to platform admins.
 */

/** Minimal seeded permission catalog (small but real). */
export const PERMISSIONS = [
  "crm.person.read",
  "crm.lead.write",
  "conversation.reply",
  "settings.manage",
  "tenant.member.manage",
  "billing.read",
  "audit.read",
  "support.ticket.read",
  "support.ticket.write",
  "support.incident.write",
  "knowledge.read",
  "knowledge.write",
  "agent.review.request",
  "agent.review.decide",
  "agent.eval.run",
  "trial.read",
  "trial.write",
  "provider.operation.read",
  "provider.operation.write",
  "commerce.order.write",
  "billing.charge.write",
  "billing.refund.request",
  "billing.refund.execute",
  "billing.exception.resolve",
  "subscription.read",
  "subscription.write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PLATFORM_ADMIN_ROLE = "platform_admin";
export const TENANT_OWNER_ROLE = "tenant_owner";
export const TENANT_ADMIN_ROLE = "tenant_admin";
export const TENANT_OPERATOR_ROLE = "tenant_operator";

/** Role -> permissions mapping; must stay in sync with migration 012 + 021 seeds. */
export const ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  [PLATFORM_ADMIN_ROLE]: [...PERMISSIONS],
  [TENANT_OWNER_ROLE]: [...PERMISSIONS],
  [TENANT_ADMIN_ROLE]: [
    "crm.person.read",
    "crm.lead.write",
    "conversation.reply",
    "settings.manage",
    "tenant.member.manage",
    "billing.read",
    "support.ticket.read",
    "support.ticket.write",
    "support.incident.write",
    "knowledge.read",
    "knowledge.write",
    "agent.review.request",
    "agent.review.decide",
    "agent.eval.run",
    "trial.read",
    "trial.write",
    "provider.operation.read",
    "provider.operation.write",
    "commerce.order.write",
    "billing.charge.write",
    "billing.refund.request",
    "billing.refund.execute",
    "billing.exception.resolve",
    "subscription.read",
    "subscription.write",
  ],
  [TENANT_OPERATOR_ROLE]: [
    "crm.person.read",
    "crm.lead.write",
    "conversation.reply",
    "support.ticket.read",
    "support.ticket.write",
    "knowledge.read",
    "agent.review.request",
    "trial.read",
    "trial.write",
    "commerce.order.write",
    "billing.charge.write",
    "billing.refund.request",
    "subscription.read",
  ],
};

export function isKnownPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function permissionsForRoles(roleKeys: readonly string[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const key of roleKeys) {
    const perms = ROLE_PERMISSIONS[key];
    if (perms === undefined) {
      continue;
    }
    for (const perm of perms) {
      out.add(perm);
    }
  }
  return out;
}

/** Resolved actor within one tenant context. */
export interface Actor {
  userId: string;
  isPlatformAdmin: boolean;
  /** Active tenant for this check; null only before a tenant is selected. */
  tenantId: string | null;
  roleKeys: string[];
  permissions: Permission[];
}

export class ForbiddenError extends Error {
  readonly statusCode = 403;
  readonly code = "FORBIDDEN";
  constructor(message = "forbidden") {
    super(message);
  }
}

export function hasPermission(actor: Actor, permission: string): boolean {
  if (actor.isPlatformAdmin) {
    return true;
  }
  return actor.permissions.includes(permission as Permission);
}

/**
 * Enforce a permission server-side. Platform admins bypass; everyone else
 * needs an ACTIVE membership in `tenantId` (resolved into the actor) plus
 * the permission in their role set. Tenant isolation: an actor resolved for
 * another tenant (or none) is denied — never fall back to request input.
 */
export function requirePermission(actor: Actor, tenantId: string, permission: string): void {
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new ForbiddenError("tenant context is required");
  }
  if (actor.isPlatformAdmin) {
    return;
  }
  if (actor.tenantId === null || actor.tenantId !== tenantId) {
    throw new ForbiddenError("no active membership in this tenant");
  }
  if (!hasPermission(actor, permission)) {
    throw new ForbiddenError(`missing permission: ${permission}`);
  }
}

/** Minimal membership loader port (Kysely-backed in the API, faked in tests). */
export interface MembershipLoader {
  findActiveMembership(
    userId: string,
    tenantId: string,
  ): Promise<{ id: string; roleKey: string } | null>;
  listExtraRoleKeys(membershipId: string): Promise<string[]>;
}

export async function resolveActor(
  loader: MembershipLoader,
  input: { userId: string; isPlatformAdmin: boolean; tenantId: string | null },
): Promise<Actor> {
  if (input.isPlatformAdmin) {
    return {
      userId: input.userId,
      isPlatformAdmin: true,
      tenantId: input.tenantId,
      roleKeys: [PLATFORM_ADMIN_ROLE],
      permissions: [...PERMISSIONS],
    };
  }
  if (input.tenantId === null) {
    return {
      userId: input.userId,
      isPlatformAdmin: false,
      tenantId: null,
      roleKeys: [],
      permissions: [],
    };
  }
  const membership = await loader.findActiveMembership(input.userId, input.tenantId);
  if (membership === null) {
    return {
      userId: input.userId,
      isPlatformAdmin: false,
      tenantId: null,
      roleKeys: [],
      permissions: [],
    };
  }
  const extra = await loader.listExtraRoleKeys(membership.id);
  const roleKeys = [membership.roleKey, ...extra].filter((k) => ROLE_PERMISSIONS[k] !== undefined);
  return {
    userId: input.userId,
    isPlatformAdmin: false,
    tenantId: input.tenantId,
    roleKeys,
    permissions: [...permissionsForRoles(roleKeys)],
  };
}
