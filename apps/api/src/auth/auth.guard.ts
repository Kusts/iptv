import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from "@nestjs/common";
import type { AuthInstance } from "@iptv/auth";
import type { FastifyRequest } from "fastify";
import { extractSessionToken } from "./auth-context.js";

/**
 * Resolves the opaque session token (Bearer header or `iptv_session`
 * cookie) into `request.auth`. Public routes opt out by not using it.
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
      isPlatformAdmin: session.user.isPlatformAdmin,
      email: session.user.email,
    };
    return true;
  }
}
