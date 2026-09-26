import { Body, Controller, HttpCode, HttpException, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { WahaWebhookService } from "./waha-webhook.service.js";
import { normalizeWahaPayload } from "./waha-normalizer.js";
import { createHash } from "node:crypto";

/**
 * Public WAHA webhook ingress. No session auth: the shared-secret header
 * authenticates the provider, and the `:tenantKey` path segment maps to the
 * tenant via `communication.tenant_channels` (never from payload content).
 *
 * Pipeline: verify → durable inbox (insert-once) → 202 fast ack → async
 * normalize (`message.ingest`). Wave 2 runs the normalize stage inline in
 * this process (local DB work only, no slow provider calls); `?defer=1`
 * skips inline processing so a worker/test can poll via `drainPending`.
 * A Hatchet worker handoff replaces the inline stage in a later wave.
 */
@Controller("v1/webhooks")
export class WahaWebhookController {
  constructor(@Inject(WahaWebhookService) private readonly webhooks: WahaWebhookService) {}

  @Post("waha/:tenantKey")
  @HttpCode(202)
  async receive(
    @Param("tenantKey") tenantKey: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Query("defer") defer?: string,
  ): Promise<{ accepted: boolean; deduped: boolean }> {
    const channel = await this.webhooks.resolveChannel(tenantKey);
    if (channel === null) {
      throw new HttpException({ code: "NOT_FOUND", message: "unknown webhook endpoint" }, 404);
    }
    const header = req.headers["x-waha-secret"];
    const presented = Array.isArray(header) ? header[0] : header;
    const auth = this.webhooks.verifySecret(channel, presented);
    if (!auth.ok) {
      // Rejected and auditable upstream; never expose which check failed
      // beyond the status (secret value itself is never logged).
      const status = auth.code === "not_configured" ? 503 : 401;
      throw new HttpException({ code: "UNAUTHORIZED", message: "webhook authentication failed" }, status);
    }
    const normalized = normalizeWahaPayload(body);
    const externalEventId =
      normalized.kind === "message"
        ? `waha:${normalized.externalId}`
        : `waha-unknown:${createHash("sha256").update(JSON.stringify(body ?? null), "utf8").digest("hex").slice(0, 24)}`;
    const accepted = await this.webhooks.acceptRaw({
      tenantId: channel.tenantId,
      channel: channel.channel,
      externalEventId,
      payload: body,
    });
    if (!accepted.inserted) {
      return { accepted: true, deduped: true };
    }
    if (defer !== "1") {
      await this.webhooks.processRow(channel.tenantId, accepted.inboxId, body);
    }
    return { accepted: true, deduped: false };
  }
}
