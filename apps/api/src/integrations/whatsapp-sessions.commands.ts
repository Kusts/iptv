import { HttpException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { parseIntegrationsPublicBaseUrl } from "@iptv/config";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { kyselyTrxOf } from "../crm/wave2-store.js";
import {
  resolveSecretsWriterPort,
  buildIntegrationSecretRef,
  SecretsError,
  type SecretsWriterPort,
} from "@iptv/secrets";
import { HttpWahaAdminPort, WahaAdminError, resolveWahaAdminPort } from "./waha-admin.port.js";
import { currentGateway, GatewayUnknownError, type SendTextResult } from "../communications/messaging-gateway.js";
import { bindSession } from "../communications/waha-sessions.js";
import {
  deriveWahaSessionName,
  ensureWahaChannel,
  getBoundWahaSession,
  sanitizeWahaStatus,
  saveWahaSessionBinding,
} from "../communications/waha-session-store.js";

/**
 * S3a WhatsApp session commands (SPEC S1 §6, etapas 1–5).
 *
 * `whatsapp.session_ensure` / `whatsapp.session_reconnect` /
 * `whatsapp.session_disconnect` sob `integration.manage`, com idempotência
 * via `CommandBus` (header `Idempotency-Key`) e auditoria automática
 * (`tenant_channel`, sem valores de segredo).
 *
 * Ordem de escrita SEGURA (espelha `integration.webhook_ensure`):
 *  1. resolve o port WAHA (env de plataforma; ausente → 503 fail-closed);
 *  2. resolve a base pública + linha de canal (tenant_key estável);
 *  3. `put` do token do webhook no vault ANTES de chamar o WAHA;
 *  4. `POST /api/sessions` (create) ou reuse (GET existente — SEM update de
 *     config no reuse: a semântica de merge do update WAHA não é confirmável
 *     e um PUT integral poderia apagar config de engine; o webhook converge
 *     no create);
 *  5. converge estado (STOPPED→start; FAILED→restart, o recovery
 *     documentado; demais estados intocados);
 *  6. persiste o vínculo + hash sha256 SOMENTE após o provider confirmar.
 *
 * Respostas sanitizadas por construção (nunca o token, nunca a admin key).
 */

export const WAHA_SECRET_ENV = "production";
export const WAHA_WEBHOOK_SECRET_KEY = "WAHA_WEBHOOK_SECRET";

const emptyInput = z.object({}).strict();

/**
 * S3c (#87) test-message input: E.164 estrito + texto curto. O `to` é o
 * ÚNICO destino permitido (anti-broadcast por construção: nenhum outro
 * endereço entra no comando) e o conteúdo NUNCA volta na resposta nem na
 * auditoria (só `to`/`textLength`/resultado).
 */
const testMessageInput = z
  .object({
    to: z.string().regex(/^\+[1-9]\d{7,14}$/),
    text: z.string().min(1).max(500),
  })
  .strict();

export interface WhatsappTestMessageResult {
  /** Destino E.164 confirmado (eco do input validado, nunca outro número). */
  to: string;
  /** Tamanho do texto enviado — o conteúdo NUNCA sai do servidor. */
  textLength: number;
  sessionName: string;
  providerMessageId: string;
}

export interface WhatsappSessionResult {
  sessionName: string;
  status: string;
  webhookUrl: string;
  hasWebhookSecret: true;
  reused: boolean;
}

function sanitizeResult(input: {
  sessionName: string;
  status: string;
  webhookUrl: string;
  reused: boolean;
}): WhatsappSessionResult {
  return {
    sessionName: input.sessionName,
    status: input.status,
    webhookUrl: input.webhookUrl,
    hasWebhookSecret: true,
    reused: input.reused,
  };
}

/** 503 fail-closed do vault/DB (falhas ambientais, nunca validação). */
function vaultUnavailable(): HttpException {
  return new HttpException(
    { code: "VAULT_UNAVAILABLE", message: "secret vault unavailable; binding untouched, retry later" },
    503,
  );
}

function wahaNotConfigured(): HttpException {
  return new HttpException(
    {
      code: "WAHA_NOT_CONFIGURED",
      message:
        "WAHA is not configured on this platform (set WAHA_BASE_URL and WAHA_API_KEY server-side); session provisioning is unavailable",
    },
    503,
  );
}

function webhookBaseMissing(tenantKey: string): HttpException {
  return new HttpException(
    {
      code: "WEBHOOK_BASE_URL_NOT_CONFIGURED",
      message:
        "public webhook base URL is not configured (set INTEGRATIONS_PUBLIC_BASE_URL, e.g. https://app.exemplo.com, and retry). " +
        `Manual mode: the session webhook must point at <base>/v1/webhooks/waha/${tenantKey} ` +
        "(path /v1/webhooks/waha/:tenantKey) with a static x-waha-secret header; " +
        "re-run whatsapp.session_ensure once the base URL is set to sync the channel binding.",
    },
    503,
  );
}

/** Token válido: 32–255 chars, sem whitespace (mesma regra do Asaas). */
function isValidWebhookToken(value: unknown): value is string {
  return (
    typeof value === "string" && value.length >= 32 && value.length <= 255 && !/\s/.test(value)
  );
}

function generateWebhookToken(): string {
  return randomBytes(48).toString("base64url");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Test seams (fakes injetados pela suite; produção resolve live).
// ---------------------------------------------------------------------------

interface WhatsappSessionTestDoubles {
  secretsWriter?: SecretsWriterPort;
  /**
   * Override explícito da base pública (`null` simula ausente para o teste
   * de manual-mode; `undefined` = sem override, lê o env real).
   */
  webhookBaseUrl?: string | null;
}

let testDoubles: WhatsappSessionTestDoubles | null = null;

/** Test-only: instala fakes de vault/base (chamado no beforeAll da suite). */
export function __setWhatsappSessionTestDoubles(doubles: WhatsappSessionTestDoubles): void {
  testDoubles = doubles;
}

/** Test-only: remove os fakes (chamado no afterAll da suite). */
export function __resetWhatsappSessionTestDoubles(): void {
  testDoubles = null;
}

function resolveWriter(): SecretsWriterPort {
  if (testDoubles?.secretsWriter !== undefined) {
    return testDoubles.secretsWriter;
  }
  return resolveSecretsWriterPort();
}

/**
 * Base pública canônica (origem `scheme://host[:port]`). Override de teste
 * primeiro; depois `INTEGRATIONS_PUBLIC_BASE_URL` validada pela mesma regra
 * do `loadConfig` (NUNCA host do cliente).
 */
export function resolveWhatsappPublicBaseUrl(): string | null {
  if (testDoubles?.webhookBaseUrl !== undefined) {
    return testDoubles.webhookBaseUrl;
  }
  return parseIntegrationsPublicBaseUrl(process.env["INTEGRATIONS_PUBLIC_BASE_URL"]);
}

function requireTrx(ctx: CommandHandlerContext) {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("whatsapp session commands require a database transaction");
  }
  return trx;
}

function requireWahaPort(): HttpWahaAdminPort {
  const port = resolveWahaAdminPort();
  if (port === null) {
    throw wahaNotConfigured();
  }
  return port;
}

function throwWaha(mapped: WahaAdminError): HttpException | CommandResult<WhatsappSessionResult> {
  switch (mapped.code) {
    case "NOT_FOUND":
      return {
        ok: false,
        code: "not_found",
        message: "waha session not found at the provider (it may have been deleted there; re-run ensure to reprovision)",
      };
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
    case "TIMEOUT":
    case "UNAVAILABLE":
    case "BAD_RESPONSE":
    case "CONFLICT":
      throw new HttpException(
        { code: "PROVIDER_UNAVAILABLE", message: "waha unavailable; retry later" },
        503,
      );
  }
}

async function resolveWebhookToken(
  ctx: CommandHandlerContext,
): Promise<{ token: string; ref: string }> {
  const writer = resolveWriter();
  const target = {
    tenantId: ctx.tenantId,
    provider: "whatsapp" as const,
    environment: WAHA_SECRET_ENV,
    key: WAHA_WEBHOOK_SECRET_KEY,
  };
  const ref = buildIntegrationSecretRef(target);
  try {
    const current = await writer.getSecret(ref);
    if (isValidWebhookToken(current)) {
      return { token: current, ref };
    }
  } catch (err) {
    if (!(err instanceof SecretsError) || err.code !== "NOT_FOUND") {
      if (err instanceof SecretsError) {
        throw vaultUnavailable();
      }
      throw err;
    }
  }
  const fresh = generateWebhookToken();
  try {
    await writer.putSecret({ ...target, value: fresh, requestId: ctx.commandId });
  } catch (err) {
    if (err instanceof SecretsError) {
      throw vaultUnavailable();
    }
    throw err;
  }
  return { token: fresh, ref };
}

async function handleEnsure(
  ctx: CommandHandlerContext,
): Promise<CommandResult<WhatsappSessionResult>> {
  const trx = requireTrx(ctx);
  const port = requireWahaPort();
  const channel = await ensureWahaChannel(trx, ctx.tenantId);
  const base = resolveWhatsappPublicBaseUrl();
  if (base === null) {
    throw webhookBaseMissing(channel.tenantKey);
  }
  const webhookUrl = `${base}/v1/webhooks/waha/${channel.tenantKey}`;
  const sessionName = deriveWahaSessionName(ctx.tenantId);

  // Token no vault ANTES de chamar o WAHA (o retry reutiliza o mesmo valor).
  const { token } = await resolveWebhookToken(ctx);

  let status: string;
  let reused: boolean;
  try {
    const existing = await port.getSession(sessionName);
    if (existing === null) {
      const created = await port.createSession(sessionName, { url: webhookUrl, secret: token });
      status = created.status;
      reused = false;
    } else {
      // Reuse: converge APENAS o estado de execução, nunca a config (merge
      // do update WAHA não confirmável — ver waha-admin.port.ts).
      status = existing.status;
      reused = true;
    }
    if (status === "STOPPED") {
      status = (await port.startSession(sessionName)).status;
    } else if (status === "FAILED") {
      status = (await port.restartSession(sessionName)).status;
    }
  } catch (err) {
    if (err instanceof WahaAdminError) {
      const mapped = throwWaha(err);
      if (mapped instanceof HttpException) {
        throw mapped;
      }
      return mapped;
    }
    throw err;
  }

  const observed = sanitizeWahaStatus(status) ?? status;
  try {
    await saveWahaSessionBinding(trx, ctx.tenantId, {
      sessionName,
      status: observed,
      webhookSecretHash: sha256Hex(token),
    });
  } catch {
    throw vaultUnavailable();
  }
  bindSession(ctx.tenantId, sessionName);
  return { ok: true, data: sanitizeResult({ sessionName, status: observed, webhookUrl, reused }) };
}

async function handleReconnect(
  ctx: CommandHandlerContext,
): Promise<CommandResult<WhatsappSessionResult>> {
  const trx = requireTrx(ctx);
  const port = requireWahaPort();
  const channel = await ensureWahaChannel(trx, ctx.tenantId);
  const base = resolveWhatsappPublicBaseUrl();
  if (base === null) {
    throw webhookBaseMissing(channel.tenantKey);
  }
  const bound = await getBoundWahaSession(trx, ctx.tenantId);
  if (bound === null) {
    return { ok: false, code: "not_found", message: "no whatsapp session bound in this tenant" };
  }
  let status: string;
  try {
    const current = await port.getSession(bound.sessionName);
    if (current === null) {
      const mapped = throwWaha(new WahaAdminError("NOT_FOUND", "gone", 404));
      if (mapped instanceof HttpException) {
        throw mapped;
      }
      return mapped;
    }
    status =
      current.status === "STOPPED"
        ? (await port.startSession(bound.sessionName)).status
        : (await port.restartSession(bound.sessionName)).status;
  } catch (err) {
    if (err instanceof WahaAdminError) {
      const mapped = throwWaha(err);
      if (mapped instanceof HttpException) {
        throw mapped;
      }
      return mapped;
    }
    throw err;
  }
  const observed = sanitizeWahaStatus(status) ?? status;
  try {
    await saveWahaSessionBinding(trx, ctx.tenantId, { sessionName: bound.sessionName, status: observed });
  } catch {
    throw vaultUnavailable();
  }
  bindSession(ctx.tenantId, bound.sessionName);
  return {
    ok: true,
    data: sanitizeResult({
      sessionName: bound.sessionName,
      status: observed,
      webhookUrl: `${base}/v1/webhooks/waha/${channel.tenantKey}`,
      reused: true,
    }),
  };
}

async function handleDisconnect(
  ctx: CommandHandlerContext,
): Promise<CommandResult<WhatsappSessionResult>> {
  const trx = requireTrx(ctx);
  const port = requireWahaPort();
  const channel = await ensureWahaChannel(trx, ctx.tenantId);
  const base = resolveWhatsappPublicBaseUrl();
  if (base === null) {
    throw webhookBaseMissing(channel.tenantKey);
  }
  const bound = await getBoundWahaSession(trx, ctx.tenantId);
  if (bound === null) {
    return { ok: false, code: "not_found", message: "no whatsapp session bound in this tenant" };
  }
  let status: string;
  try {
    const current = await port.getSession(bound.sessionName);
    if (current === null) {
      const mapped = throwWaha(new WahaAdminError("NOT_FOUND", "gone", 404));
      if (mapped instanceof HttpException) {
        throw mapped;
      }
      return mapped;
    }
    // Parada idempotente: STOPPED continua STOPPED; histórico e vínculo
    // preservados (nunca delete, nunca clear).
    status = (await port.stopSession(bound.sessionName)).status;
  } catch (err) {
    if (err instanceof WahaAdminError) {
      const mapped = throwWaha(err);
      if (mapped instanceof HttpException) {
        throw mapped;
      }
      return mapped;
    }
    throw err;
  }
  const observed = sanitizeWahaStatus(status) ?? status;
  try {
    await saveWahaSessionBinding(trx, ctx.tenantId, { sessionName: bound.sessionName, status: observed });
  } catch {
    throw vaultUnavailable();
  }
  bindSession(ctx.tenantId, bound.sessionName);
  return {
    ok: true,
    data: sanitizeResult({
      sessionName: bound.sessionName,
      status: observed,
      webhookUrl: `${base}/v1/webhooks/waha/${channel.tenantKey}`,
      reused: true,
    }),
  };
}

/**
 * S3c (#87) test-message: envia UM texto curto ao `to` confirmado via o
 * send path EXISTENTE (`currentGateway().sendText` — nenhum outro sender).
 *
 * Fail-closed em camadas (espelha o S3a):
 *  1. sem vínculo → 404 `not_found` (nunca a sessão `default` compartilhada);
 *  2. sessão sumida no provider → 404 (reprovisionar via `session_ensure`);
 *  3. status vivo ≠ WORKING → 409 `precondition_failed` (`SESSION_NOT_READY`);
 *  4. destino roteável derivado SÓ do `to` validado (`+E.164` → `<digits>@c.us`,
 *     nunca broadcast, nunca outro número);
 *  5. sessão SEMPRE a vinculada do tenant (espelhada no Map legado antes do
 *     envio para o guard síncrono do adapter aplicar o mesmo valor);
 *  6. resultado do provider mapeado honestamente: `CAPPED` → 429, recusa →
 *     503 `PROVIDER_UNAVAILABLE`, confirmação inconclusiva → 503
 *     `UNKNOWN_EFFECT` (pode ter aplicado — verificar antes de retentar).
 *
 * Sem persistência de mensagem CRM (teste não é conversa) e sem conteúdo em
 * resposta/auditoria: a auditoria automática do `CommandBus` registra só
 * `{ command, command_id, result }` e o `resourceId` é nulo (o resultado não
 * carrega `id`) — o corpo do texto nunca toca `platform.audit_log`.
 * Anti-duplo-envio em retry: `Idempotency-Key` (replay do bus, sem reenviar)
 * + backstop por origem no `RateLimitGuard` (`whatsapp-test-message`).
 */
async function handleTestMessage(
  ctx: CommandHandlerContext,
  rawInput: unknown,
): Promise<CommandResult<WhatsappTestMessageResult>> {
  const input = rawInput as z.infer<typeof testMessageInput>;
  const trx = requireTrx(ctx);
  const port = requireWahaPort();
  const bound = await getBoundWahaSession(trx, ctx.tenantId);
  if (bound === null) {
    return { ok: false, code: "not_found", message: "no whatsapp session bound in this tenant" };
  }
  let liveStatus: string;
  try {
    const live = await port.getSession(bound.sessionName);
    if (live === null) {
      return {
        ok: false,
        code: "not_found",
        message: "waha session not found at the provider (it may have been deleted there; re-run ensure to reprovision)",
      };
    }
    liveStatus = live.status;
  } catch (err) {
    if (err instanceof WahaAdminError) {
      // Mesmo mapeamento do `throwWaha` S3a, com o tipo do próprio resultado
      // (o helper é tipado para `WhatsappSessionResult`).
      if (err.code === "NOT_FOUND") {
        return {
          ok: false,
          code: "not_found",
          message: "waha session not found at the provider (it may have been deleted there; re-run ensure to reprovision)",
        };
      }
      if (err.code === "UNAUTHORIZED") {
        throw new HttpException(
          { code: "WAHA_UNAUTHORIZED", message: "waha rejected the platform admin credential; retry later" },
          503,
        );
      }
      if (err.code === "RATE_LIMITED") {
        throw new HttpException(
          { code: "CAPPED", message: "waha rate-limited the request (restriction surfaced, not retried)" },
          429,
        );
      }
      throw new HttpException({ code: "PROVIDER_UNAVAILABLE", message: "waha unavailable; retry later" }, 503);
    }
    throw err;
  }
  if (liveStatus.toUpperCase() !== "WORKING") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `SESSION_NOT_READY: whatsapp session ${bound.sessionName} is ${liveStatus} (test message requires WORKING)`,
    };
  }
  bindSession(ctx.tenantId, bound.sessionName);
  // `conversationId` é exigido pelo port mas ignorado no HTTP do adapter (só
  // `tenantId`/`to`/`text`/`session` viajam); o teste NÃO persiste conversa
  // nem mensagem — o marcador só identifica a chamada na telemetria.
  const chatId = `${input.to.slice(1)}@c.us`;
  let receipt: SendTextResult;
  try {
    receipt = await currentGateway().sendText({
      tenantId: ctx.tenantId,
      conversationId: "whatsapp-test-message",
      to: chatId,
      text: input.text,
      session: bound.sessionName,
    });
  } catch (err) {
    if (err instanceof GatewayUnknownError) {
      throw new HttpException(
        {
          code: "UNKNOWN_EFFECT",
          message: "waha send confirmation inconclusive: the test message may have been applied; verify before retrying",
        },
        503,
      );
    }
    throw err;
  }
  const result = receipt;
  if (!result.ok) {
    if (result.code === "CAPPED") {
      throw new HttpException(
        { code: "CAPPED", message: "waha rate-limited the test send (restriction surfaced, not retried)" },
        429,
      );
    }
    if (result.code === "SESSION_MISMATCH") {
      return {
        ok: false,
        code: "precondition_failed",
        message: `SESSION_MISMATCH: refusing to send through an unexpected session (${result.message})`,
      };
    }
    throw new HttpException({ code: "PROVIDER_UNAVAILABLE", message: "waha unavailable; retry later" }, 503);
  }
  return {
    ok: true,
    data: {
      to: input.to,
      textLength: input.text.length,
      sessionName: bound.sessionName,
      providerMessageId: result.providerMessageId,
    },
  };
}

export function registerWhatsappSessionCommands(bus: CommandBus): void {
  bus.register<z.infer<typeof emptyInput>, WhatsappSessionResult>({
    name: "whatsapp.session_ensure",
    permission: "integration.manage",
    auditAction: "whatsapp.session_ensure",
    auditResource: "tenant_channel",
    input: emptyInput,
    handler: handleEnsure,
  });
  bus.register<z.infer<typeof emptyInput>, WhatsappSessionResult>({
    name: "whatsapp.session_reconnect",
    permission: "integration.manage",
    auditAction: "whatsapp.session_reconnect",
    auditResource: "tenant_channel",
    input: emptyInput,
    handler: handleReconnect,
  });
  bus.register<z.infer<typeof emptyInput>, WhatsappSessionResult>({
    name: "whatsapp.session_disconnect",
    permission: "integration.manage",
    auditAction: "whatsapp.session_disconnect",
    auditResource: "tenant_channel",
    input: emptyInput,
    handler: handleDisconnect,
  });
  bus.register<z.infer<typeof testMessageInput>, WhatsappTestMessageResult>({
    name: "whatsapp.test_message",
    permission: "integration.manage",
    auditAction: "whatsapp.test_message",
    auditResource: "tenant_channel",
    input: testMessageInput,
    handler: handleTestMessage,
  });
}
