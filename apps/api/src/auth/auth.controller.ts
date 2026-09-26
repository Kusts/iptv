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
import type { FastifyRequest } from "fastify";
import { AuditService } from "../audit/audit.service.js";
import { AuthGuard } from "./auth.guard.js";
import { throwHttp } from "./http-errors.js";

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
  ) {}

  private requireAuth(): AuthInstance {
    if (this.auth === null) {
      throw new HttpException({ code: "UNAVAILABLE", message: "database is not configured" }, 503);
    }
    return this.auth;
  }

  @Post("register")
  async register(@Body() body: RegisterBody, @Req() req: FastifyRequest): Promise<{
    token: string;
    user: { id: string; email: string; displayName: string | null };
    activeTenantId: string | null;
  }> {
    const auth = this.requireAuth();
    try {
      const result = await auth.register({
        email: asString(body.email, "email"),
        password: asString(body.password, "password"),
        displayName: asOptionalString(body.displayName),
        tenantName: asOptionalString(body.tenantName),
      });
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
      };
    } catch (err) {
      throwHttp(err);
    }
  }

  @Post("login")
  @HttpCode(200)
  async login(@Body() body: LoginBody, @Req() req: FastifyRequest): Promise<{
    token: string;
    user: { id: string; email: string; displayName: string | null };
    activeTenantId: string | null;
  }> {
    const auth = this.requireAuth();
    try {
      const result = await auth.login({
        email: asString(body.email, "email"),
        password: asString(body.password, "password"),
      });
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
      memberships: info.memberships,
    };
  }
}
