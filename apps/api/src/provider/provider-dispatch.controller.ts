import { Body, Controller, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard.js";
import { AuthRateLimit } from "../auth/rate-limit.js";
import { PlatformAdminGuard } from "../auth/platform-admin.guard.js";
import { RateLimitGuard } from "../auth/rate-limit.guard.js";
import {
  ProviderDispatcherService,
  type DispatchDrainSummary,
  type DispatchReconcileSummary,
  type DispatchRecoverSummary,
} from "./provider-dispatcher.service.js";

/**
 * Platform-ops durable provider dispatch (CV-DSP-01, migration 045).
 *
 * Tenant-agnostic, platform-admin-only manual triggers mirroring
 * `OutboxController`: `drain` claims REQUESTED secret-branch operations and
 * executes them through the leased dispatcher; `recover` releases expired
 * pre-send leases to REQUESTED and parks expired post-send leases in
 * VERIFYING/UNKNOWN for readback (never re-executes); `reconcile` resolves
 * VERIFYING secret-required `trial.provision` rows through the bounded
 * readback+postcondition+binding gate (FASE5-FIX4-N1, outside any
 * transaction, CAS-fenced — the executor behind the `provider.reconcile`
 * scheduling response).
 */
@Controller("v1/admin/provider-dispatch")
export class ProviderDispatchController {
  constructor(@Inject(ProviderDispatcherService) private readonly dispatcher: ProviderDispatcherService) {}

  @Post("drain")
  @HttpCode(200)
  @AuthRateLimit("admin-provider-dispatch")
  @UseGuards(AuthGuard, PlatformAdminGuard, RateLimitGuard)
  async drain(@Body() body: { limit?: unknown }): Promise<DispatchDrainSummary> {
    const limit = typeof body.limit === "number" ? body.limit : 25;
    return this.dispatcher.drainOnce(limit);
  }

  @Post("recover")
  @HttpCode(200)
  @AuthRateLimit("admin-provider-dispatch")
  @UseGuards(AuthGuard, PlatformAdminGuard, RateLimitGuard)
  async recover(@Body() body: { limit?: unknown }): Promise<DispatchRecoverSummary> {
    const limit = typeof body.limit === "number" ? body.limit : 100;
    return this.dispatcher.recoverOnce(limit);
  }

  @Post("reconcile")
  @HttpCode(200)
  @AuthRateLimit("admin-provider-dispatch")
  @UseGuards(AuthGuard, PlatformAdminGuard, RateLimitGuard)
  async reconcile(@Body() body: { limit?: unknown }): Promise<DispatchReconcileSummary> {
    const limit = typeof body.limit === "number" ? body.limit : 100;
    return this.dispatcher.reconcileOnce(limit);
  }
}
