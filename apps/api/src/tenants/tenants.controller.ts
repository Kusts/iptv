import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import type { AuthInstance } from "@iptv/auth";
import type { Database } from "@iptv/database";
import { newId, now } from "@iptv/domain";
import type { FastifyRequest } from "fastify";
import { AuditService } from "../audit/audit.service.js";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import { throwHttp } from "../auth/http-errors.js";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  // Random tail, not the UUIDv7 timestamp head (see packages/auth slugify).
  const suffix = newId().replace(/-/g, "").slice(-8);
  return `${base.length > 0 ? base : "tenant"}-${suffix}`;
}

@Controller("v1")
export class TenantsController {
  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject("AUTH") private readonly auth: AuthInstance | null,
    // Explicit token (see AuthController): esbuild/vitest emits no
    // `design:paramtypes`, so inferred injection would be `undefined`.
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new HttpException({ code: "UNAVAILABLE", message: "database is not configured" }, 503);
    }
    return this.db;
  }

  private requireAuth(): AuthInstance {
    if (this.auth === null) {
      throw new HttpException({ code: "UNAVAILABLE", message: "database is not configured" }, 503);
    }
    return this.auth;
  }

  @Get("tenants")
  @UseGuards(AuthGuard)
  async list(@Req() req: FastifyRequest): Promise<{
    memberships: { tenantId: string; tenantSlug: string; tenantName: string; roleKey: string; status: string }[];
    activeTenantId: string | null;
  }> {
    const auth = this.requireAuth();
    const token = (req.auth as NonNullable<FastifyRequest["auth"]>).token;
    const info = await auth.resolveSession({ token });
    if (info === null) {
      throw new HttpException({ code: "UNAUTHENTICATED", message: "session is invalid or expired" }, 401);
    }
    return { memberships: info.memberships, activeTenantId: info.activeTenantId };
  }

  @Post("tenants")
  @UseGuards(AuthGuard)
  async create(
    @Body() body: { name?: unknown; slug?: unknown },
    @Req() req: FastifyRequest,
  ): Promise<{ tenant: { id: string; slug: string; name: string } }> {
    const db = this.requireDb();
    const session = req.auth as NonNullable<FastifyRequest["auth"]>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length === 0) {
      throw new HttpException({ code: "INVALID_BODY", message: "missing field: name" }, 400);
    }
    let slug: string;
    if (body.slug === undefined) {
      slug = slugify(name);
    } else if (typeof body.slug === "string" && SLUG_RE.test(body.slug)) {
      slug = body.slug;
    } else {
      throw new HttpException({ code: "INVALID_SLUG", message: "invalid slug" }, 400);
    }
    try {
      const tenant = await db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto("control.tenants")
          .values({
            id: newId(),
            slug,
            name,
            status: "ACTIVE",
            default_currency: "BRL",
            timezone: "America/Sao_Paulo",
            created_at: now(),
            updated_at: now(),
          })
          .returning(["id", "slug", "name"])
          .executeTakeFirstOrThrow();
        await trx
          .insertInto("control.tenant_memberships")
          .values({
            id: newId(),
            tenant_id: created.id,
            user_id: session.userId,
            role_key: "tenant_owner",
            status: "ACTIVE",
            created_at: now(),
            updated_at: now(),
          })
          .execute();
        return created;
      });
      await this.audit.write({
        tenantId: tenant.id,
        actorType: "human",
        actorId: session.userId,
        action: "tenant.create",
        resourceType: "tenant",
        resourceId: tenant.id,
        correlationId: req.id,
        metadata: { after: { slug: tenant.slug, name: tenant.name } },
      });
      return { tenant };
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (/duplicate key|unique/i.test(message)) {
        throw new HttpException({ code: "SLUG_TAKEN", message: "tenant slug is taken" }, 409);
      }
      throw err;
    }
  }

  @Post("tenants/:id/switch")
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async switch(
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ): Promise<{ activeTenantId: string }> {
    const auth = this.requireAuth();
    const session = req.auth as NonNullable<FastifyRequest["auth"]>;
    try {
      const result = await auth.setActiveTenant({ token: session.token, tenantId: id });
      await this.audit.write({
        tenantId: result.activeTenantId,
        actorType: "human",
        actorId: session.userId,
        action: "tenant.switch",
        resourceType: "tenant",
        resourceId: result.activeTenantId,
        correlationId: req.id,
        metadata: { after: { activeTenantId: result.activeTenantId } },
      });
      return result;
    } catch (err) {
      throwHttp(err);
    }
  }

  /**
   * Tenant-scoped proof of the full chain: session → active tenant →
   * membership → roles → permissions.
   */
  @Get("me")
  @UseGuards(AuthGuard, PermissionsGuard)
  async me(@Req() req: FastifyRequest): Promise<{
    user: { id: string; email: string };
    activeTenant: { id: string };
    roleKeys: string[];
    permissions: string[];
  }> {
    const session = req.auth as NonNullable<FastifyRequest["auth"]>;
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    return {
      user: { id: session.userId, email: session.email },
      activeTenant: { id: tenant.id },
      roleKeys: tenant.roleKeys,
      permissions: tenant.permissions,
    };
  }

  /** Guarded demo route: requires `settings.manage` (operator gets 403). */
  @Get("settings")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("settings.manage")
  async settings(@Req() req: FastifyRequest): Promise<{
    tenantId: string;
    managed: true;
  }> {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    return { tenantId: tenant.id, managed: true };
  }
}
