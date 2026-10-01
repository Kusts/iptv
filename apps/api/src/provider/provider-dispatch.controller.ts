import { Body, Controller, HttpCode, HttpException, Inject, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
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

  private requirePlatformAdmin(req: FastifyRequest): void {
    const auth = req.auth as NonNullable<FastifyRequest["auth"]>;
    if (!auth.isPlatformAdmin) {
      throw new HttpException({ code: "FORBIDDEN", message: "platform admin only" }, 403);
    }
  }

  @Post("drain")
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async drain(
    @Body() body: { limit?: unknown },
    @Req() req: FastifyRequest,
  ): Promise<DispatchDrainSummary> {
    this.requirePlatformAdmin(req);
    const limit = typeof body.limit === "number" ? body.limit : 25;
    return this.dispatcher.drainOnce(limit);
  }

  @Post("recover")
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async recover(
    @Body() body: { limit?: unknown },
    @Req() req: FastifyRequest,
  ): Promise<DispatchRecoverSummary> {
    this.requirePlatformAdmin(req);
    const limit = typeof body.limit === "number" ? body.limit : 100;
    return this.dispatcher.recoverOnce(limit);
  }

  @Post("reconcile")
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async reconcile(
    @Body() body: { limit?: unknown },
    @Req() req: FastifyRequest,
  ): Promise<DispatchReconcileSummary> {
    this.requirePlatformAdmin(req);
    const limit = typeof body.limit === "number" ? body.limit : 100;
    return this.dispatcher.reconcileOnce(limit);
  }
}
