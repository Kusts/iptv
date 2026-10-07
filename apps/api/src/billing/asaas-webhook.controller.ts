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
 * Pipeline: resolve (pre-context, ACTIVE row for the secret check) → local
 * timing-safe verify → ATOMIC accept (`billing.accept_asaas_delivery`
 * re-locks the routing row FOR UPDATE, revalidates ACTIVE, and inserts the
 * inbox row in the same transaction, closing the resolve-then-insert TOCTOU)
 * → 202 fast ack → async normalize (`charge.webhook_confirm` /
 * `payment.record_chargeback`). A mid-flight DISABLE (or a routing key
 * re-pointed to another tenant) refuses the accept and 404s like an unknown
 * endpoint. `?defer=1` skips inline processing so a worker/test can poll
 * via `drainPending`.
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
    const canonicalHeader = req.headers["asaas-access-token"];
    const legacyHeader = req.headers["x-asaas-secret"];
    const first = (value: string | string[] | undefined): string | undefined =>
      Array.isArray(value) ? value[0] : value;
    // Canonical `asaas-access-token` (official Asaas authToken header) wins;
    // `x-asaas-secret` remains as a backward-compatible alias only.
    const canonical = first(canonicalHeader);
    const presented = canonical !== undefined ? canonical : first(legacyHeader);
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
      tenantKey,
      externalEventId,
      payload: body,
    });
    if (accepted === null) {
      // Routing changed mid-flight (DISABLED or re-pointed after the secret
      // check): fail closed exactly like an unknown endpoint, with zero
      // inbox rows written.
      recordWebhookReceived("asaas", "unknown_tenant");
      throw new HttpException({ code: "NOT_FOUND", message: "unknown webhook endpoint" }, 404);
    }
    if (!accepted.inserted) {
      recordWebhookReceived("asaas", "duplicate");
      return { accepted: true, deduped: true };
    }
    if (defer !== "1") {
      // Inline claims the row first (054 `inbox_claim_by_id`): when the
      // scheduler drain already owns it, the claim returns zero rows and the
      // inline path skips `processRow`, acking idempotently -- exactly one
      // processor ever owns a row, never double-processing.
      const inline = await this.webhooks.processInline(channel.tenantId, accepted.inboxId, body, "inline:asaas");
      if (!inline.claimed) {
        recordWebhookReceived("asaas", "duplicate");
        return { accepted: true, deduped: true };
      }
    }
    recordWebhookReceived("asaas", "accepted");
    return { accepted: true, deduped: false };
    });
  }
}
