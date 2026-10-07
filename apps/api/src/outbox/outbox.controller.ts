import { Body, Controller, Get, HttpCode, HttpException, Inject, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { LegacyOutboxDrainDisabledError, OutboxDrainer, type DrainResult, type LegacyDrainState } from "./outbox-drainer.js";

/**
 * Platform-ops outbox drain (tenant-agnostic, platform-admin-only).
 * Tests and operators trigger delivery explicitly in Wave 1; scheduling
 * (Hatchet cron) arrives behind the same drainer later.
 */
@Controller("v1/admin/outbox")
export class OutboxController {
  constructor(@Inject(OutboxDrainer) private readonly drainer: OutboxDrainer) {}

  @Get("drain-state")
  @UseGuards(AuthGuard)
  async drainState(@Req() req: FastifyRequest): Promise<LegacyDrainState> {
    const auth = req.auth as NonNullable<FastifyRequest["auth"]>;
    if (!auth.isPlatformAdmin) {
      throw new HttpException({ code: "FORBIDDEN", message: "platform admin only" }, 403);
    }
    return this.drainer.getDrainState();
  }

  @Post("drain")
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async drain(
    @Body() body: { limit?: unknown },
    @Req() req: FastifyRequest,
  ): Promise<DrainResult> {
    const auth = req.auth as NonNullable<FastifyRequest["auth"]>;
    if (!auth.isPlatformAdmin) {
      throw new HttpException({ code: "FORBIDDEN", message: "platform admin only" }, 403);
    }
    const limit = typeof body.limit === "number" ? body.limit : 50;
    try {
      return await this.drainer.drain(limit);
    } catch (err) {
      if (err instanceof LegacyOutboxDrainDisabledError) {
        throw new HttpException({ code: "LEGACY_DRAIN_DISABLED", message: err.message }, 409);
      }
      throw err;
    }
  }
}
