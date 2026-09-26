import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Kysely } from "kysely";
import { requirePermission, resolveActor } from "@iptv/auth";
import type { Database } from "@iptv/database";
import type { FastifyRequest } from "fastify";

export const PERMISSION_KEY = "requiredPermission";

/** Declare a route-level permission, enforced server-side after auth. */
export const RequirePermission = (permission: string): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_KEY, permission);

/**
 * Builds the request-scoped tenant context from the session's active tenant
 * (never from the request body) and enforces the route permission, if any.
 * Tenant isolation: no ACTIVE membership (and no platform bypass) → 403.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    // Explicit token: esbuild/vitest emits no `design:paramtypes`.
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.db === null) {
      throw new HttpException({ code: "UNAVAILABLE", message: "database is not configured" }, 503);
    }
    const db = this.db;
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const auth = req.auth;
    if (auth === undefined) {
      throw new HttpException({ code: "UNAUTHENTICATED", message: "authentication required" }, 401);
    }
    const tenantId = auth.activeTenantId;
    if (tenantId === null) {
      throw new HttpException({ code: "NO_ACTIVE_TENANT", message: "no active tenant selected" }, 403);
    }
    const actor = await resolveActor(
      {
        findActiveMembership: async (userId: string, tid: string) => {
          const row = await db
            .selectFrom("control.tenant_memberships")
            .select(["id", "role_key"])
            .where("user_id", "=", userId)
            .where("tenant_id", "=", tid)
            .where("status", "=", "ACTIVE")
            .executeTakeFirst();
          if (row === undefined) {
            return null;
          }
          return { id: row.id, roleKey: row.role_key };
        },
        listExtraRoleKeys: async (membershipId: string) => {
          const rows = await db
            .selectFrom("control.membership_roles")
            .select(["role_key"])
            .where("membership_id", "=", membershipId)
            .where("tenant_id", "=", tenantId)
            .execute();
          return rows.map((r) => r.role_key);
        },
      },
      { userId: auth.userId, isPlatformAdmin: auth.isPlatformAdmin, tenantId },
    );
    if (actor.tenantId === null && !auth.isPlatformAdmin) {
      // Resolved empty: no ACTIVE membership → deny without leaking why.
      throw new HttpException(
        { code: "TENANT_FORBIDDEN", message: "no active membership in this tenant" },
        403,
      );
    }
    const required = this.reflector.getAllAndOverride<string | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required !== undefined) {
      try {
        requirePermission(actor, tenantId, required);
      } catch {
        throw new HttpException(
          { code: "FORBIDDEN", message: `missing permission: ${required}` },
          403,
        );
      }
    }
    req.tenant = { id: tenantId, roleKeys: actor.roleKeys, permissions: [...actor.permissions] };
    return true;
  }
}
