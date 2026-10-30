import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Kysely, Transaction } from "kysely";
import { withTenantTransaction, type Database } from "@iptv/database";
import { commandResultHttpStatus, type CommandResult } from "@iptv/domain";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import type { CapabilityStore } from "../capabilities/capability-registry.js";
import { CommandBus, commandActorFromRequestParts } from "../commands/command-bus.js";
import type { CommandActor } from "@iptv/domain";

/**
 * S1C1 Central de Integrações — read-only status (SPEC S1 §4, S1-DESIGN-R2).
 *
 * `GET /v1/integrations[/:provider]` sob `integration.read`. Projeção
 * sanitizada por construção: `secret_ref`, `settings_json`, payloads e
 * qualquer material de segredo NUNCA são selecionados — a resposta carrega
 * só `configured` + metadados de conexão. `capability_status` é DERIVADO do
 * registry (`platform.capabilities`) + certificação em runtime, nunca
 * persistido. S1c2 (SPEC S1 §4–§5): `POST /:provider/configure|test|disable`
 * sob `integration.manage` (configure/disable) / `integration.test`
 * (test), segredos server-side no vault (nunca na resposta), idempotência
 * via `Idempotency-Key` e auditoria automática.
 */
const INTEGRATION_PROVIDERS = ["asaas", "whatsapp", "cinevision"] as const;

type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

function isIntegrationProvider(value: string): value is IntegrationProvider {
  return (INTEGRATION_PROVIDERS as readonly string[]).includes(value);
}

type CapabilityStatus = "AVAILABLE" | "DEGRADED" | "UNAVAILABLE" | "UNCERTIFIED" | "UNKNOWN";

/**
 * Derivação fail-closed do registry real: sem linha → UNKNOWN (S3/S4 plugam
 * depois); UNAVAILABLE nega independente de certificação; sem certificação
 * nunca alega AVAILABLE. Espelha a disciplina do ActionGate (passo 1 nega
 * antes de qualquer detalhe de permissão) sem expor o motivo interno.
 */
function deriveCapabilityStatus(row: { availability: string; certification_status: string } | undefined): CapabilityStatus {
  if (row === undefined) {
    return "UNKNOWN";
  }
  if (row.availability === "UNAVAILABLE") {
    return "UNAVAILABLE";
  }
  if (row.certification_status === "UNCERTIFIED") {
    return "UNCERTIFIED";
  }
  return row.availability === "DEGRADED" ? "DEGRADED" : "AVAILABLE";
}

interface IntegrationStatus {
  provider: IntegrationProvider;
  environment: string;
  connection_status: string;
  capability_status: CapabilityStatus;
  last_checked_at: string | null;
  last_error_code: string | null;
  configured: boolean;
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

function requestBodyOf(body: unknown): Record<string, unknown> {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

@Controller("v1/integrations")
export class IntegrationsController {
  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject("CAPABILITY_STORE") private readonly capabilities: CapabilityStore,
    @Inject(CommandBus) private readonly bus: CommandBus,
  ) {}

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new HttpException({ code: "UNAVAILABLE", message: "database is not configured" }, 503);
    }
    return this.db;
  }

  private async statusOf(
    trx: Transaction<Database>,
    tenantId: string,
    provider: IntegrationProvider,
  ): Promise<IntegrationStatus> {
    // Único binding vivo (DISABLED é histórico — 065): o mais recente manda.
    // O SELECT nunca inclui secret_ref/settings_json (sanitização no SELECT,
    // não por ausência de dado).
    const binding = await trx
      .selectFrom("provider.provider_accounts")
      .innerJoin(
        "provider.providers",
        "provider.providers.id",
        "provider.provider_accounts.provider_id",
      )
      .select([
        "provider.provider_accounts.environment",
        "provider.provider_accounts.connection_status",
        "provider.provider_accounts.last_checked_at",
        "provider.provider_accounts.last_error_code",
      ])
      .where("provider.provider_accounts.tenant_id", "=", tenantId)
      .where("provider.providers.provider_key", "=", provider)
      .where("provider.provider_accounts.connection_status", "<>", "DISABLED")
      .orderBy("provider.provider_accounts.updated_at", "desc")
      .executeTakeFirst();
    const capability = await this.capabilities.get(`provider.${provider}`);
    const capability_status = deriveCapabilityStatus(
      capability === null
        ? undefined
        : { availability: capability.availability, certification_status: capability.certificationStatus },
    );
    if (binding === undefined) {
      // Conta inexistente: fail-closed SANDBOX, nunca alegar conectado.
      return {
        provider,
        environment: "SANDBOX",
        connection_status: "NOT_CONFIGURED",
        capability_status,
        last_checked_at: null,
        last_error_code: null,
        configured: false,
      };
    }
    return {
      provider,
      environment: binding.environment,
      connection_status: binding.connection_status,
      capability_status,
      last_checked_at: binding.last_checked_at?.toISOString() ?? null,
      last_error_code: binding.last_error_code,
      configured: true,
    };
  }

  @Get()
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("integration.read")
  async list(@Req() req: FastifyRequest): Promise<{ integrations: IntegrationStatus[] }> {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const integrations = await withTenantTransaction(this.requireDb(), tenant.id, async (trx) => {
      const out: IntegrationStatus[] = [];
      for (const provider of INTEGRATION_PROVIDERS) {
        out.push(await this.statusOf(trx, tenant.id, provider));
      }
      return out;
    });
    return { integrations };
  }

  @Get(":provider")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("integration.read")
  async get(@Param("provider") provider: string, @Req() req: FastifyRequest): Promise<IntegrationStatus> {
    const normalized = provider.toLowerCase();
    if (!isIntegrationProvider(normalized)) {
      throw new HttpException({ code: "NOT_FOUND", message: `integration not found: ${provider}` }, 404);
    }
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    return withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      this.statusOf(trx, tenant.id, normalized),
    );
  }

  /**
   * S1C2 write surface (SPEC S1 §4–§5): configure/test/disable sob
   * `integration.manage` (configure/disable) e `integration.test` (test),
   * com idempotência via header `Idempotency-Key` e auditoria automática.
   * Respostas sanitizadas por construção (só metadados do binding).
   * WhatsApp recusa 501 `CAPABILITY_UNCERTIFIED` antes do bus — sem linha,
   * sem vault (S3 certifica).
   */
  private resolveWritableProvider(raw: string): IntegrationProvider {
    const normalized = raw.toLowerCase();
    if (normalized === "whatsapp") {
      throw new HttpException(
        {
          code: "CAPABILITY_UNCERTIFIED",
          message: "whatsapp integration is uncertified (disponível em S3)",
        },
        501,
      );
    }
    if (!isIntegrationProvider(normalized)) {
      throw new HttpException({ code: "NOT_FOUND", message: `integration not found: ${raw}` }, 404);
    }
    return normalized;
  }

  @Post(":provider/configure")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("integration.manage")
  async configure(
    @Param("provider") provider: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const normalized = this.resolveWritableProvider(provider);
    const result = await this.bus.execute(
      actorFromRequest(req),
      "integration.configure",
      { ...requestBodyOf(body), provider: normalized },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  @Post(":provider/test")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("integration.test")
  async test(@Param("provider") provider: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const normalized = this.resolveWritableProvider(provider);
    const result = await this.bus.execute(
      actorFromRequest(req),
      "integration.test",
      { ...requestBodyOf(body), provider: normalized },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  @Post(":provider/disable")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("integration.manage")
  async disable(
    @Param("provider") provider: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const normalized = this.resolveWritableProvider(provider);
    const result = await this.bus.execute(
      actorFromRequest(req),
      "integration.disable",
      { ...requestBodyOf(body), provider: normalized },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }
}
