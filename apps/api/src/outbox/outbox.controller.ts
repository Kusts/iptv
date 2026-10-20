import { Body, Controller, Get, HttpCode, HttpException, Inject, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard.js";
import { AuthRateLimit } from "../auth/rate-limit.js";
import { PlatformAdminGuard } from "../auth/platform-admin.guard.js";
import { RateLimitGuard } from "../auth/rate-limit.guard.js";
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
  @UseGuards(AuthGuard, PlatformAdminGuard)
  async drainState(): Promise<LegacyDrainState> {
    return this.drainer.getDrainState();
  }

  @Post("drain")
  @HttpCode(200)
  @AuthRateLimit("admin-outbox-drain")
  @UseGuards(AuthGuard, PlatformAdminGuard, RateLimitGuard)
  async drain(@Body() body: { limit?: unknown }): Promise<DrainResult> {
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
