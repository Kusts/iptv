import { CanActivate, ExecutionContext, HttpException, Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

/**
 * Platform-admin authorization gate for tenant-agnostic ops drains.
 *
 * Runs BETWEEN authentication (`AuthGuard`, which resolves `request.auth`)
 * and rate limiting (`RateLimitGuard`, which charges the origin budget), so
 * a non-admin caller is rejected with 403 BEFORE any budget is consumed.
 * Without this ordering, every rejected non-admin attempt would burn one
 * unit of the shared per-origin budget and let an unprivileged caller
 * exhaust an operator's drain allowance.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const auth = req.auth;
    if (auth === undefined) {
      throw new HttpException({ code: "UNAUTHENTICATED", message: "authentication required" }, 401);
    }
    if (!auth.isPlatformAdmin) {
      throw new HttpException({ code: "FORBIDDEN", message: "platform admin only" }, 403);
    }
    return true;
  }
}
