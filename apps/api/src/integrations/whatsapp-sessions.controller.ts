import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import { withTenantTransaction, type Database } from "@iptv/database";
import { commandResultHttpStatus, type CommandResult } from "@iptv/domain";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import { AuthRateLimit } from "../auth/rate-limit.js";
import { RateLimitGuard } from "../auth/rate-limit.guard.js";
import { CommandBus } from "../commands/command-bus.js";
import { commandActorFromRequestParts } from "../commands/command-bus.js";
import type { CommandActor } from "@iptv/domain";
import {
  getBoundWahaSession,
  saveWahaSessionBinding,
} from "../communications/waha-session-store.js";
import { WahaAdminError, resolveWahaAdminPort } from "./waha-admin.port.js";
import type { WhatsappSessionResult, WhatsappTestMessageResult } from "./whatsapp-sessions.commands.js";

/**
 * S3a WhatsApp session onboarding (SPEC S1 §6, etapas 1–5).
 *
 * `POST /v1/integrations/whatsapp/session|reconnect|disconnect` sob
 * `integration.manage` (via `CommandBus`, com `Idempotency-Key` e auditoria
 * automática); `GET …/session|qr` sob `integration.read`. Respostas
 * sanitizadas por construção (só metadados do vínculo + estado verbatim do
 * provider; o token do webhook e a admin key do WAHA nunca saem do
 * servidor). Ausência de vínculo → 404 fail-closed (nunca a sessão
 * `default` compartilhada de outro tenant). O QR é um proxy de bytes
 * (`image/png`, `no-store`, sem persistência); restrição/timelock NÃO vira
 * "desconectado genérico" — o estado real do provider é exposto verbatim.
 *
 * S3c (#87): `POST …/test-message` sob `integration.manage` (+ backstop por
 * origem `whatsapp-test-message`) e `lastInbound` no `GET …/session`.
 */
export interface WhatsappSessionStatus {
  sessionName: string;
  status: string;
  /**
   * Último inbound WHATSAPP do tenant (1 query, sem join): `{ occurredAt,
   * preview }` com os primeiros 80 chars do corpo (ou `[anexo]` quando só há
   * mídia) — `null` quando a linha ainda não recebeu nada. Leitura sob
   * `integration.read`, mesmos dados do próprio tenant.
   */
  lastInbound: { occurredAt: string; preview: string } | null;
}
@Controller("v1/integrations/whatsapp")
export class WhatsappSessionsController {
  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject(CommandBus) private readonly bus: CommandBus,
  ) {}

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new HttpException({ code: "UNAVAILABLE", message: "database is not configured" }, 503);
    }
    return this.db;
  }

  private wahaNotConfigured(): HttpException {
    return new HttpException(
      {
        code: "WAHA_NOT_CONFIGURED",
        message:
          "WAHA is not configured on this platform (set WAHA_BASE_URL and WAHA_API_KEY server-side)",
      },
      503,
    );
  }

  private throwWaha(err: WahaAdminError): never {
    switch (err.code) {
      case "NOT_FOUND":
        throw new HttpException(
          { code: "SESSION_NOT_FOUND_AT_PROVIDER", message: "session not found at the WAHA provider" },
          404,
        );
      case "UNAUTHORIZED":
        throw new HttpException(
          { code: "WAHA_UNAUTHORIZED", message: "waha rejected the platform admin credential; retry later" },
          503,
        );
      case "RATE_LIMITED":
        throw new HttpException(
          { code: "CAPPED", message: "waha rate-limited the request (restriction surfaced, not retried)" },
          429,
        );
      default:
        throw new HttpException(
          { code: "PROVIDER_UNAVAILABLE", message: "waha unavailable; retry later" },
          503,
        );
    }
  }

  @Post("session")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("integration.manage")
  async ensure(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<WhatsappSessionResult> {
    const payload = body !== null && typeof body === "object" && !Array.isArray(body) ? body : {};
    const result = await this.bus.execute<WhatsappSessionResult>(
      actorFromRequest(req),
      "whatsapp.session_ensure",
      payload,
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    const data = send(result);
    res.statusCode = data.reused ? 200 : 201;
    return data;
  }

  @Get("session")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("integration.read")
  async status(@Req() req: FastifyRequest): Promise<WhatsappSessionStatus> {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const port = resolveWahaAdminPort();
    if (port === null) {
      throw this.wahaNotConfigured();
    }
    return withTenantTransaction(this.requireDb(), tenant.id, async (trx) => {
      const bound = await getBoundWahaSession(trx, tenant.id);
      if (bound === null) {
        throw new HttpException(
          { code: "NO_SESSION", message: "no whatsapp session bound in this tenant" },
          404,
        );
      }
      let status: string;
      try {
        const live = await port.getSession(bound.sessionName);
        if (live === null) {
          throw new WahaAdminError("NOT_FOUND", "gone", 404);
        }
        status = live.status;
      } catch (err) {
        if (err instanceof WahaAdminError) {
          this.throwWaha(err);
        }
        throw err;
      }
      // Refresh do último estado observado (fail-closed: a escrita é na
      // própria linha do tenant, sob o mesmo contexto RLS).
      await saveWahaSessionBinding(trx, tenant.id, { sessionName: bound.sessionName, status });
      // S3c: último inbound do tenant em 1 query (preview curto, sem join).
      // Nunca inventado: ausente → null (linha ainda sem inbound).
      const lastInboundRow = await trx
        .selectFrom("communication.messages")
        .select(["occurred_at", "body_text"])
        .where("tenant_id", "=", tenant.id)
        .where("channel", "=", "WHATSAPP")
        .where("direction", "=", "INBOUND")
        .orderBy("occurred_at", "desc")
        .executeTakeFirst();
      const lastInbound =
        lastInboundRow === undefined
          ? null
          : {
              occurredAt: lastInboundRow.occurred_at.toISOString(),
              preview:
                typeof lastInboundRow.body_text === "string" && lastInboundRow.body_text.length > 0
                  ? lastInboundRow.body_text.slice(0, 80)
                  : "[anexo]",
            };
      return { sessionName: bound.sessionName, status, lastInbound };
    });
  }

  @Get("qr")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("integration.read")
  async qr(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply): Promise<void> {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const port = resolveWahaAdminPort();
    if (port === null) {
      throw this.wahaNotConfigured();
    }
    const bound = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      getBoundWahaSession(trx, tenant.id),
    );
    if (bound === null) {
      throw new HttpException(
        { code: "NO_SESSION", message: "no whatsapp session bound in this tenant" },
        404,
      );
    }
    let image: { bytes: Uint8Array; contentType: string } | null;
    try {
      image = await port.fetchQrPng(bound.sessionName);
    } catch (err) {
      if (err instanceof WahaAdminError) {
        this.throwWaha(err);
      }
      throw err;
    }
    if (image === null) {
      throw new HttpException(
        {
          code: "QR_NOT_READY",
          message: "no QR available for this session state (already paired, stopped, or expired — check the session status)",
        },
        404,
      );
    }
    // Proxy de bytes, sem persistência e sem cache (o QR expira em segundos).
    res
      .header("content-type", image.contentType)
      .header("cache-control", "no-store, max-age=0")
      .send(Buffer.from(image.bytes));
  }

  @Post("reconnect")
  @HttpCode(200)
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("integration.manage")
  async reconnect(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<WhatsappSessionResult> {
    const payload = body !== null && typeof body === "object" && !Array.isArray(body) ? body : {};
    const result = await this.bus.execute<WhatsappSessionResult>(
      actorFromRequest(req),
      "whatsapp.session_reconnect",
      payload,
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  @Post("disconnect")
  @HttpCode(200)
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("integration.manage")
  async disconnect(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<WhatsappSessionResult> {
    const payload = body !== null && typeof body === "object" && !Array.isArray(body) ? body : {};
    const result = await this.bus.execute<WhatsappSessionResult>(
      actorFromRequest(req),
      "whatsapp.session_disconnect",
      payload,
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  /**
   * S3c (#87) mensagem de teste: `POST .../test-message` sob
   * `integration.manage` (envio é efeito) + backstop por origem
   * (`whatsapp-test-message`: 30 envios / 5 min; o anti-duplo-envio em retry
   * é o `Idempotency-Key`, com replay do `CommandBus` sem reenviar).
   *
   * Contrato: Zod `{ to: ^\+[1-9]\d{7,14}$ (E.164), text: 1..500 }` (400 em
   * inválido); sem vínculo → 404 `NO_SESSION`; vínculo sem sessão viva no
   * provider → 404 `SESSION_NOT_FOUND_AT_PROVIDER`; status vivo ≠ WORKING →
   * 409 `SESSION_NOT_READY`; recusa do provider → 503/429 honestos. Resposta
   * sanitizada `{ to, textLength, sessionName, providerMessageId }` — o
   * conteúdo NUNCA volta (nem na auditoria automática, que registra só
   * `command`/`command_id`/`result`).
   */
  @Post("test-message")
  @HttpCode(200)
  @AuthRateLimit("whatsapp-test-message")
  @UseGuards(AuthGuard, PermissionsGuard, RateLimitGuard)
  @RequirePermission("integration.manage")
  async testMessage(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<WhatsappTestMessageResult> {
    const payload = body !== null && typeof body === "object" && !Array.isArray(body) ? body : {};
    const result = await this.bus.execute<WhatsappTestMessageResult>(
      actorFromRequest(req),
      "whatsapp.test_message",
      payload,
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    if (!result.ok) {
      if (result.code === "not_found") {
        // `not_found` do bus vira o vocabulário do endpoint: sem vínculo →
        // NO_SESSION; sessão sumida no provider → SESSION_NOT_FOUND_AT_PROVIDER.
        const noSession = result.message.startsWith("no whatsapp session bound");
        throw new HttpException(
          {
            code: noSession ? "NO_SESSION" : "SESSION_NOT_FOUND_AT_PROVIDER",
            message: result.message,
          },
          404,
        );
      }
      if (result.code === "precondition_failed" && result.message.startsWith("SESSION_NOT_READY")) {
        throw new HttpException({ code: "SESSION_NOT_READY", message: result.message }, 409);
      }
      if (result.code === "precondition_failed" && result.message.startsWith("SESSION_MISMATCH")) {
        throw new HttpException({ code: "SESSION_MISMATCH", message: result.message }, 409);
      }
    }
    return send(result);
  }
}

function actorFromRequest(req: FastifyRequest): CommandActor {
  const auth = req.auth as NonNullable<FastifyRequest["auth"]>;
  const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
  return commandActorFromRequestParts({
    userId: auth.userId,
    isPlatformAdmin: auth.isPlatformAdmin,
    tenantId: tenant.id,
    roleKeys: tenant.roleKeys,
    permissions: tenant.permissions,
    actorType: "human",
  });
}

function send<T>(result: CommandResult<T>): T {
  if (result.ok) {
    return result.data;
  }
  throw new HttpException(
    { code: result.code.toUpperCase(), message: result.message },
    commandResultHttpStatus(result),
  );
}

function idempotencyKeyOf(req: FastifyRequest): string | undefined {
  const header = req.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}
