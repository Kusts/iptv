import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from "@nestjs/common";
import type { AuthInstance } from "@iptv/auth";
import type { FastifyRequest } from "fastify";
import {
  TENANT_CONTEXT_REVISION_HEADER,
  extractSessionToken,
  isTenantContextExempt,
  parseTenantContextRevision,
} from "./auth-context.js";

/**
 * Resolves the opaque session token (Bearer header or `iptv_session`
 * cookie) into `request.auth`. Public routes opt out by not using it.
 *
 * Tenant-context staleness gate: every protected route except the session
 * bootstrap (`GET /v1/auth/session`) and `POST /v1/auth/logout` requires a
 * syntactically valid `x-tenant-context-revision` header matching the
 * session's authoritative revision. Missing/malformed/stale preconditions
 * fail closed with 409 `TENANT_CONTEXT_CONFLICT` before any controller or
 * permissions side effect — and without invalidating the session token.
 * The header never selects the tenant: `request.auth` always carries the
 * server-side snapshot.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject("AUTH") private readonly auth: AuthInstance | null) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.auth === null) {
      throw new HttpException({ code: "UNAVAILABLE", message: "database is not configured" }, 503);
    }
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const token = extractSessionToken(req);
    if (token === null) {
      throw new HttpException({ code: "UNAUTHENTICATED", message: "missing session token" }, 401);
    }
    const session = await this.auth.resolveSession({ token });
    if (session === null) {
      throw new HttpException({ code: "UNAUTHENTICATED", message: "session is invalid or expired" }, 401);
    }
    req.auth = {
      userId: session.user.id,
      sessionId: session.sessionId,
      token,
      activeTenantId: session.activeTenantId,
      tenantContextRevision: session.tenantContextRevision,
      isPlatformAdmin: session.user.isPlatformAdmin,
      email: session.user.email,
    };
    if (!isTenantContextExempt(req)) {
      const raw = req.headers[TENANT_CONTEXT_REVISION_HEADER];
      const requested = parseTenantContextRevision(Array.isArray(raw) ? raw[0] : raw);
      if (requested === null || requested !== session.tenantContextRevision) {
        throw new HttpException(
          {
            code: "TENANT_CONTEXT_CONFLICT",
            message: "tenant context is stale; refresh session and retry",
          },
          409,
        );
      }
    }
    return true;
  }
}
