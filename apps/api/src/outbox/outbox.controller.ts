import { Body, Controller, HttpCode, HttpException, Inject, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { OutboxDrainer, type DrainResult } from "./outbox-drainer.js";

/**
 * Platform-ops outbox drain (tenant-agnostic, platform-admin-only).
 * Tests and operators trigger delivery explicitly in Wave 1; scheduling
 * (Hatchet cron) arrives behind the same drainer later.
 */
@Controller("v1/admin/outbox")
export class OutboxController {
  constructor(@Inject(OutboxDrainer) private readonly drainer: OutboxDrainer) {}

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
    return this.drainer.drain(limit);
  }
}
