import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  RATE_LIMIT_POLICY_KEY,
  type AuthRateLimitKind,
} from "./rate-limit.js";
import { RateLimitService } from "./rate-limit.service.js";

/** Read the raw parsed body's `email` without assuming pipes already ran. */
function readBodyEmail(req: FastifyRequest): unknown {
  const body: unknown = (req as { body?: unknown }).body;
  if (body !== null && typeof body === "object") {
    return (body as { email?: unknown }).email;
  }
  return undefined;
}

/**
 * Gates the public auth routes BEFORE the (expensive) controller body runs —
 * i.e. before any password hash, e-mail lookup or external call. The decision
 * is made and the budgets charged synchronously and atomically (see
 * RateLimitService), then either the request proceeds or it is rejected with a
 * `429 RATE_LIMITED` error in the API's shared `{ code, message }` error schema,
 * carrying a `Retry-After` header in whole seconds.
 *
 * Fail-open availability: if the limiter itself throws (internal bug), the
 * request is ADMITTED and the error is logged loudly — never swallowed. See
 * RateLimitService for the rationale.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    // Explicit token: esbuild/vitest emits no `design:paramtypes`, so
    // type-inferred DI would resolve to `undefined` at test runtime.
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = this.reflector.getAllAndOverride<AuthRateLimitKind | undefined>(
      RATE_LIMIT_POLICY_KEY,
      [context.getHandler(), context.getClass()],
    );
    // Not a rate-limited route: nothing to enforce.
    if (kind === undefined) {
      return true;
    }

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();

    // Default is fail-open-safe and only overwritten on the success path below.
    let decision: { allowed: boolean; retryAfterSeconds: number } = {
      allowed: true,
      retryAfterSeconds: 0,
    };
    try {
      decision = this.rateLimit.acquire(kind, req, readBodyEmail(req));
    } catch (err) {
      // Fail-open, but loud: an in-memory limiter bug must not become an auth
      // outage (which would let a non-security bug be weaponized into a global
      // DoS). Logged for operators; never silently swallowed.
      this.logger.error(
        { requestId: req.id, kind, error: err instanceof Error ? err.message : String(err) },
        "auth rate limiter unavailable — admitting request (fail-open)",
      );
      return true;
    }

    if (!decision.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterSeconds));
      reply.header("Retry-After", String(retryAfterSeconds));
      throw new HttpException(
        { code: "RATE_LIMITED", message: "too many attempts; please retry later" },
        429,
      );
    }

    return true;
  }
}
