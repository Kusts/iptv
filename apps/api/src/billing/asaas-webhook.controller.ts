import { Body, Controller, HttpCode, HttpException, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { recordWebhookReceived, withSpan } from "@iptv/observability";
import { AsaasWebhookService } from "./asaas-webhook.service.js";
import { normalizeAsaasPayload } from "./asaas-normalizer.js";

/**
 * Public Asaas webhook ingress. No session auth: the shared-secret header
 * authenticates the provider, and the `:tenantKey` path segment maps to the
 * tenant via `billing.tenant_channels` (never from payload content).
 *
 * Pipeline: verify → durable inbox (insert-once on provider event id) →
 * 202 fast ack → async normalize (`charge.webhook_confirm` /
 * `payment.record_chargeback`). `?defer=1` skips inline processing so a
 * worker/test can poll via `drainPending`.
 */
@Controller("v1/webhooks")
export class AsaasWebhookController {
  constructor(@Inject(AsaasWebhookService) private readonly webhooks: AsaasWebhookService) {}

  @Post("asaas/:tenantKey")
  @HttpCode(202)
  async receive(
    @Param("tenantKey") tenantKey: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Query("defer") defer?: string,
  ): Promise<{ accepted: boolean; deduped: boolean }> {
    return withSpan("webhook.asaas.receive", { provider: "asaas" }, async () => {
    const channel = await this.webhooks.resolveChannel(tenantKey);
    if (channel === null) {
      recordWebhookReceived("asaas", "unknown_tenant");
      throw new HttpException({ code: "NOT_FOUND", message: "unknown webhook endpoint" }, 404);
    }
    const header = req.headers["x-asaas-secret"];
    const presented = Array.isArray(header) ? header[0] : header;
    const auth = this.webhooks.verifySecret(channel, presented);
    if (!auth.ok) {
      recordWebhookReceived("asaas", "unauthorized");
      const status = auth.code === "not_configured" ? 503 : 401;
      throw new HttpException({ code: "UNAUTHORIZED", message: "webhook authentication failed" }, status);
    }
    const normalized = normalizeAsaasPayload(body, body);
    const externalEventId =
      normalized.kind === "unknown"
        ? `asaas-unknown:${createHash("sha256").update(JSON.stringify(body ?? null), "utf8").digest("hex").slice(0, 24)}`
        : normalized.externalEventId;
    const accepted = await this.webhooks.acceptRaw({
      tenantId: channel.tenantId,
      externalEventId,
      payload: body,
    });
    if (!accepted.inserted) {
      recordWebhookReceived("asaas", "duplicate");
      return { accepted: true, deduped: true };
    }
    if (defer !== "1") {
      await this.webhooks.processRow(channel.tenantId, accepted.inboxId, body);
    }
    recordWebhookReceived("asaas", "accepted");
    return { accepted: true, deduped: false };
    });
  }
}
