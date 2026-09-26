import { Controller, Get, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

export const API_VERSION = "0.1.0";

@Controller("v1")
export class HealthController {
  @Get("health")
  health(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): {
    status: string;
    version: string;
    requestId: string;
  } {
    // Single request id from the HTTP boundary (Fastify `request.id`,
    // also mirrored to logs and the `x-request-id` response header).
    const requestId = req.id;
    res.header("x-request-id", requestId);
    return { status: "ok", version: API_VERSION, requestId };
  }
}
