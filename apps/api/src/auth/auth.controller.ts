import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { AuthInstance } from "@iptv/auth";
import type { AppConfig } from "@iptv/config";
import type { FastifyRequest } from "fastify";
import { AuditService } from "../audit/audit.service.js";
import { AuthGuard } from "./auth.guard.js";
import { throwHttp } from "./http-errors.js";
import { AuthRateLimit } from "./rate-limit.js";
import { RateLimitGuard } from "./rate-limit.guard.js";
import { RateLimitService } from "./rate-limit.service.js";

interface RegisterBody {
  email?: unknown;
  password?: unknown;
  displayName?: unknown;
  tenantName?: unknown;
}

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

function asOptionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpException({ code: "INVALID_BODY", message: "expected string fields" }, 400);
  }
  return value;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpException({ code: "INVALID_BODY", message: `missing field: ${field}` }, 400);
  }
  return value;
}

@Controller("v1/auth")
export class AuthController {
  constructor(
    @Inject("AUTH") private readonly auth: AuthInstance | null,
    // Explicit token: vitest transforms TS with esbuild, which does not
    // emit `design:paramtypes` metadata, so type-inferred DI would resolve
    // to `undefined` at test runtime. Never rely on inferred injection here.
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
    // Canonical runtime config (fail-closed `AUTH_REGISTER_CLOSED` flag).
    // Read from the injected `APP_CONFIG` provider — never `process.env`.
    @Inject("APP_CONFIG") private readonly config: AppConfig,
  ) {}

  private requireAuth(): AuthInstance {
    if (this.auth === null) {
      throw new HttpException({ code: "UNAVAILABLE", message: "database is not configured" }, 503);
    }
    return this.auth;
  }

  @Post("register")
  @AuthRateLimit("register")
  @UseGuards(RateLimitGuard)
  async register(@Body() body: RegisterBody, @Req() req: FastifyRequest): Promise<{
    token: string;
    user: { id: string; email: string; displayName: string | null };
    activeTenantId: string | null;
    tenantContextRevision: string;
  }> {
    // Fail-closed public-signup gate: checked FIRST, before any body
    // validation, DB access, user/tenant/session creation or audit write, so
    // a closed registration leaves zero side effects. The `RateLimitGuard`
    // above still runs (and its origin/identity budgets are still charged and
    // never reset on this path), so the limiter keeps throttling flood
    // sources exactly as when open. No bypass exists: the flag comes from the
    // injected boot-validated config, not from any request input.
    if (this.config.AUTH_REGISTER_CLOSED !== "0") {
      throw new HttpException(
        { code: "REGISTER_CLOSED", message: "public registration is closed" },
        403,
      );
    }
    const auth = this.requireAuth();
    try {
      const email = asString(body.email, "email");
      const result = await auth.register({
        email,
        password: asString(body.password, "password"),
        displayName: asOptionalString(body.displayName),
        tenantName: asOptionalString(body.tenantName),
      });
      // A completed registration clears this identity's attempt budget so a
      // legitimate first-time signup is not carried toward a throttle.
      this.rateLimit.resetIdentity("register", email);
      if (result.activeTenantId !== null) {
        await this.audit.write({
          tenantId: result.activeTenantId,
          actorType: "human",
          actorId: result.user.id,
          action: "auth.register",
          resourceType: "user",
          resourceId: result.user.id,
          correlationId: req.id,
          metadata: { after: { email: result.user.email } },
        });
      }
      return {
        token: result.token,
        user: { id: result.user.id, email: result.user.email, displayName: result.user.displayName },
        activeTenantId: result.activeTenantId,
        tenantContextRevision: result.tenantContextRevision,
      };
    } catch (err) {
      throwHttp(err);
    }
  }

  @Post("login")
  @HttpCode(200)
  @AuthRateLimit("login")
  @UseGuards(RateLimitGuard)
  async login(@Body() body: LoginBody, @Req() req: FastifyRequest): Promise<{
    token: string;
    user: { id: string; email: string; displayName: string | null };
    activeTenantId: string | null;
    tenantContextRevision: string;
  }> {
    const auth = this.requireAuth();
    try {
      const email = asString(body.email, "email");
      const result = await auth.login({
        email,
        password: asString(body.password, "password"),
      });
      // Successful credential: reset THIS identity's failure budget so a few
      // mistypes never carry a legitimate user toward a lock-out, and so the
      // success key differs from the failure key. The per-origin backstop is
      // intentionally left intact.
      this.rateLimit.resetIdentity("login", email);
      if (result.activeTenantId !== null) {
        await this.audit.write({
          tenantId: result.activeTenantId,
          actorType: "human",
          actorId: result.user.id,
          action: "auth.login",
          resourceType: "user",
          resourceId: result.user.id,
          correlationId: req.id,
          metadata: { after: { email: result.user.email } },
        });
      }
      return {
        token: result.token,
        user: { id: result.user.id, email: result.user.email, displayName: result.user.displayName },
        activeTenantId: result.activeTenantId,
        tenantContextRevision: result.tenantContextRevision,
      };
    } catch (err) {
      throwHttp(err);
    }
  }

  @Post("logout")
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async logout(@Req() req: FastifyRequest): Promise<{ ok: true }> {
    const auth = this.requireAuth();
    const session = req.auth as NonNullable<FastifyRequest["auth"]>;
    try {
      await auth.logout({ token: session.token });
      if (session.activeTenantId !== null) {
        await this.audit.write({
          tenantId: session.activeTenantId,
          actorType: "human",
          actorId: session.userId,
          action: "auth.logout",
          resourceType: "session",
          resourceId: session.sessionId,
          correlationId: req.id,
          metadata: {},
        });
      }
      return { ok: true };
    } catch (err) {
      throwHttp(err);
    }
  }

  @Get("session")
  @UseGuards(AuthGuard)
  async session(@Req() req: FastifyRequest): Promise<{
    user: { id: string; email: string; displayName: string | null };
    activeTenantId: string | null;
    tenantContextRevision: string;
    memberships: { tenantId: string; tenantSlug: string; tenantName: string; roleKey: string; status: string }[];
  }> {
    const auth = this.requireAuth();
    const token = (req.auth as NonNullable<FastifyRequest["auth"]>).token;
    const info = await auth.resolveSession({ token });
    if (info === null) {
      throw new HttpException({ code: "UNAUTHENTICATED", message: "session is invalid or expired" }, 401);
    }
    return {
      user: { id: info.user.id, email: info.user.email, displayName: info.user.displayName },
      activeTenantId: info.activeTenantId,
      tenantContextRevision: info.tenantContextRevision,
      memberships: info.memberships,
    };
  }
}
