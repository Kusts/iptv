import { Controller, Get, Inject, Optional, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SchedulerService } from "./scheduler/scheduler.service.js";

export const API_VERSION = "0.1.0";

@Controller("v1")
export class HealthController {
  constructor(@Optional() @Inject(SchedulerService) private readonly scheduler?: SchedulerService | null) {}

  @Get("health")
  health(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): {
    status: string;
    version: string;
    requestId: string;
    scheduler: string;
    tickSeconds: number;
  } {
    // Single request id from the HTTP boundary (Fastify `request.id`,
    // also mirrored to logs and the `x-request-id` response header).
    const requestId = req.id;
    res.header("x-request-id", requestId);
    const enabled = this.scheduler?.isEnabled() ?? false;
    return {
      status: "ok",
      version: API_VERSION,
      requestId,
      scheduler: enabled ? "enabled" : "disabled",
      tickSeconds: this.scheduler?.tickSeconds() ?? 60,
    };
  }
}
