import { describe, expect, it } from "vitest";
import {
  ForbiddenError,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  TENANT_OPERATOR_ROLE,
  TENANT_OWNER_ROLE,
  hasPermission,
  permissionsForRoles,
  requirePermission,
  resolveActor,
  type Actor,
  type MembershipLoader,
} from "../src/permissions.js";

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    isPlatformAdmin: false,
    tenantId: "22222222-2222-4222-8222-222222222222",
    roleKeys: [TENANT_OWNER_ROLE],
    permissions: [...(ROLE_PERMISSIONS[TENANT_OWNER_ROLE] ?? [])],
    ...overrides,
  };
}

describe("permissionsForRoles", () => {
  it("unions permissions across roles and ignores unknown keys", () => {
    const perms = permissionsForRoles([TENANT_OPERATOR_ROLE, "nope"]);
    expect([...perms].sort()).toEqual([
      "agent.review.request",
      "billing.charge.write",
      "billing.refund.request",
      "commerce.order.write",
      "conversation.reply",
      "crm.lead.write",
      "crm.person.read",
      "subscription.read",
      "support.ticket.write",
      "trial.read",
      "trial.write",
    ]);
  });

  it("owner has the full catalog", () => {
    expect(permissionsForRoles([TENANT_OWNER_ROLE]).size).toBe(PERMISSIONS.length);
  });
});

describe("hasPermission / requirePermission", () => {
  it("platform admin bypasses without membership", () => {
    const admin = actor({ isPlatformAdmin: true, tenantId: null, roleKeys: [], permissions: [] });
    expect(hasPermission(admin, "settings.manage")).toBe(true);
    expect(() =>
      requirePermission(admin, "22222222-2222-4222-8222-222222222222", "settings.manage"),
    ).not.toThrow();
  });

  it("owner passes a tenant permission", () => {
    expect(() =>
      requirePermission(actor(), "22222222-2222-4222-8222-222222222222", "settings.manage"),
    ).not.toThrow();
  });

  it("operator can request human review but cannot decide", () => {
    const op = actor({
      roleKeys: [TENANT_OPERATOR_ROLE],
      permissions: [...(ROLE_PERMISSIONS[TENANT_OPERATOR_ROLE] ?? [])],
    });
    expect(hasPermission(op, "agent.review.request")).toBe(true);
    expect(hasPermission(op, "agent.review.decide")).toBe(false);
    expect(() =>
      requirePermission(op, op.tenantId as string, "agent.review.decide"),
    ).toThrow(ForbiddenError);
  });
  it("operator runs trials but cannot resolve provider operations", () => {
    const op = actor({
      roleKeys: [TENANT_OPERATOR_ROLE],
      permissions: [...(ROLE_PERMISSIONS[TENANT_OPERATOR_ROLE] ?? [])],
    });
    expect(hasPermission(op, "trial.write")).toBe(true);
    expect(hasPermission(op, "provider.operation.write")).toBe(false);
    expect(() => requirePermission(op, op.tenantId as string, "provider.operation.write")).toThrow(ForbiddenError);
  });
  it("operator is denied settings.manage", () => {
    const op = actor({
      roleKeys: [TENANT_OPERATOR_ROLE],
      permissions: [...(ROLE_PERMISSIONS[TENANT_OPERATOR_ROLE] ?? [])],
    });
    expect(hasPermission(op, "settings.manage")).toBe(false);
    expect(() => requirePermission(op, op.tenantId as string, "settings.manage")).toThrow(ForbiddenError);
  });
  it("operator runs commerce/billing intake but cannot execute refunds or resolve exceptions", () => {
    const op = actor({
      roleKeys: [TENANT_OPERATOR_ROLE],
      permissions: [...(ROLE_PERMISSIONS[TENANT_OPERATOR_ROLE] ?? [])],
    });
    expect(hasPermission(op, "commerce.order.write")).toBe(true);
    expect(hasPermission(op, "billing.charge.write")).toBe(true);
    expect(hasPermission(op, "billing.refund.request")).toBe(true);
    expect(hasPermission(op, "billing.refund.execute")).toBe(false);
    expect(hasPermission(op, "billing.exception.resolve")).toBe(false);
    expect(() => requirePermission(op, op.tenantId as string, "billing.refund.execute")).toThrow(ForbiddenError);
  });

  it("denies cross-tenant access even with a valid role", () => {
    const a = actor();
    expect(() => requirePermission(a, "33333333-3333-4333-8333-333333333333", "crm.person.read")).toThrow(
      ForbiddenError,
    );
  });

  it("denies when tenant context is missing", () => {
    expect(() => requirePermission(actor({ tenantId: null }), "", "crm.person.read")).toThrow(
      ForbiddenError,
    );
  });
});

describe("resolveActor", () => {
  const loader: MembershipLoader = {
    findActiveMembership: async (userId: string, tenantId: string) => {
      if (userId === "u-op" && tenantId === "t-1") {
        return { id: "m-1", roleKey: TENANT_OPERATOR_ROLE };
      }
      return null;
    },
    listExtraRoleKeys: async (membershipId: string) => {
      if (membershipId === "m-1") {
        return [TENANT_OPERATOR_ROLE, "ghost-role"];
      }
      return [];
    },
  };

  it("resolves operator permissions and drops unknown extra roles", async () => {
    const resolved = await resolveActor(loader, {
      userId: "u-op",
      isPlatformAdmin: false,
      tenantId: "t-1",
    });
    expect(resolved.roleKeys).toEqual([TENANT_OPERATOR_ROLE, TENANT_OPERATOR_ROLE]);
    expect(resolved.permissions).toContain("conversation.reply");
    expect(resolved.permissions).not.toContain("settings.manage");
  });

  it("resolves to an empty actor without membership (tenant isolation)", async () => {
    const resolved = await resolveActor(loader, {
      userId: "u-stranger",
      isPlatformAdmin: false,
      tenantId: "t-1",
    });
    expect(resolved.tenantId).toBeNull();
    expect(resolved.permissions).toEqual([]);
  });

  it("platform admin resolves with full catalog without touching memberships", async () => {
    const failing: MembershipLoader = {
      findActiveMembership: async () => {
        throw new Error("must not be called");
      },
      listExtraRoleKeys: async () => {
        throw new Error("must not be called");
      },
    };
    const resolved = await resolveActor(failing, {
      userId: "u-admin",
      isPlatformAdmin: true,
      tenantId: "t-9",
    });
    expect(resolved.permissions).toHaveLength(PERMISSIONS.length);
  });
});
