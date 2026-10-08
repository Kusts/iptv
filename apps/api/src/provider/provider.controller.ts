import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import { withTenantTransaction, type Database } from "@iptv/database";
import { commandResultHttpStatus } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import { CommandBus, commandActorFromRequestParts } from "../commands/command-bus.js";
import type { CommandActor } from "@iptv/domain";

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

/**
 * Allowlist única da superfície de leitura de operações de provider
 * (lista e detalhe compartilham exatamente estas colunas, por construção).
 * `requested_payload_json`, `result_summary_json`, `secret_ref`,
 * `correlation_id`, `idempotency_key`, evidência do provider e
 * `trace_ref` NUNCA são selecionadas nem expostas.
 */
const PROVIDER_OPERATION_SANITIZED_COLUMNS = [
  "id",
  "provider_account_id",
  "action",
  "entity_type",
  "entity_id",
  "status",
  "effect_certainty",
  "execution_channel",
  "adapter_version",
  "requested_at",
  "started_at",
  "completed_at",
] as const;

interface ProviderOperationSanitizedRow {
  id: string;
  provider_account_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  status: string;
  effect_certainty: string;
  execution_channel: string | null;
  adapter_version: string | null;
  requested_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

/** Projeção sanitizada compartilhada por lista e detalhe (paridade exata). */
function sanitizeProviderOperation(row: ProviderOperationSanitizedRow) {
  return {
    id: row.id,
    providerAccountId: row.provider_account_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    status: row.status,
    effectCertainty: row.effect_certainty,
    executionChannel: row.execution_channel,
    adapterVersion: row.adapter_version,
    requestedAt: row.requested_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

/** Paginação da fila: default 20, teto 50 (toda linha é sanitizada). */
function pagination(query: { limit?: string; offset?: string }): { limit: number; offset: number } {
  // Strict integer parse: `Number("2.7")`/`Number("1e3")`/`Number("")` would
  // otherwise sneak fractional or exponential values past the bounds.
  const parseBounded = (raw: string | undefined, fallback: number, min: number, max: number): number => {
    if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
    return Math.min(Math.max(Number(raw), min), max);
  };
  return {
    limit: parseBounded(query.limit, 20, 1, 50),
    offset: parseBounded(query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function idempotencyKeyOf(req: FastifyRequest): string | undefined {
  const header = req.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

/**
 * Wave 4 Provider surface. The provider operator resolves or reconciles
 * operations here; trial-linked outcomes resume the trial flow inside the
 * same command transaction.
 */
@Controller("v1/provider")
export class ProviderController {
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

  @Post("operations")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("provider.operation.write")
  async request(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "provider.request_operation", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("operations/:id/resolve")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("provider.operation.write")
  async resolve(@Param("id") id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), operationId: id }
        : { operationId: id };
    const result = await this.bus.execute(actorFromRequest(req), "provider.resolve_operation", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("operations/:id/reconcile")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("provider.operation.write")
  async reconcile(@Param("id") id: string, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(
      actorFromRequest(req),
      "provider.reconcile",
      { operationId: id },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  /**
   * Fila autoritativa de operações de provider do tenant corrente
   * (`provider.operation.read`). Mesmo allowlist e mesma disciplina de
   * sanitização do detalhe: nada de payload, resumo, segredo, correlação,
   * evidência ou trace. `tenant_id` vem do contexto autenticado, nunca de
   * input. `requested_at DESC, id DESC` dá ordem estável entre operações
   * com o mesmo timestamp.
   *
   * P1-exit (P1.3 FIX1 mirror): leituras dentro da transação do tenant do
   * request — selects diretos falham-fechados sob `iptv_app`.
   */
  @Get("operations")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("provider.operation.read")
  async list(
    @Query() query: { limit?: string; offset?: string; status?: string },
    @Req() req: FastifyRequest,
  ) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const { limit, offset } = pagination(query);
    const { rows, counts } = await withTenantTransaction(this.requireDb(), tenant.id, async (trx) => {
    let select = trx
      .selectFrom("provider.provider_operations")
      .select([...PROVIDER_OPERATION_SANITIZED_COLUMNS])
      .where("tenant_id", "=", tenant.id)
      .orderBy("requested_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .offset(offset);
    // Filtro opcional por status exato do domínio; valor desconhecido não é
    // normalizado — devolve lista vazia em vez de ampliar o filtro.
    if (typeof query.status === "string" && query.status.length > 0) {
      select = select.where("status", "=", query.status);
    }
    const rows = await select.execute();
    // Contagem de tentativas da página, tenant-scoped: apenas o número, sem
    // as linhas de tentativa (o detalhe entrega as attempts sanitizadas).
    const counts = new Map<string, number>();
    if (rows.length > 0) {
      const counted = await trx
        .selectFrom("provider.provider_operation_attempts")
        .select(["provider_operation_id", (eb) => eb.fn.countAll<number>().as("attempts")])
        .where("tenant_id", "=", tenant.id)
        .where(
          "provider_operation_id",
          "in",
          rows.map((r) => r.id),
        )
        .groupBy("provider_operation_id")
        .execute();
      for (const c of counted) {
        counts.set(c.provider_operation_id, Number(c.attempts));
      }
    }
    return { rows, counts };
    });
    return {
      operations: rows.map((row) => ({
        ...sanitizeProviderOperation(row),
        attempts: counts.get(row.id) ?? 0,
      })),
      limit,
      offset,
    };
  }

  @Get("operations/:id")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("provider.operation.read")
  async get(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const bundled = await withTenantTransaction(this.requireDb(), tenant.id, async (trx) => {
    const row = await trx
      .selectFrom("provider.provider_operations")
      .select([...PROVIDER_OPERATION_SANITIZED_COLUMNS])
      .where("tenant_id", "=", tenant.id)
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "provider operation not found" }, 404);
    }
    const attempts = await trx
      .selectFrom("provider.provider_operation_attempts")
      .select(["attempt_no", "status", "error_code", "started_at"])
      .where("tenant_id", "=", tenant.id)
      .where("provider_operation_id", "=", id)
      .orderBy("attempt_no", "asc")
      .execute();
    return { row, attempts };
    });
    const { row, attempts } = bundled;
    return {
      ...sanitizeProviderOperation(row),
      attempts: attempts.map((a) => ({
        attemptNo: Number(a.attempt_no),
        status: a.status,
        errorCode: a.error_code,
        startedAt: a.started_at.toISOString(),
      })),
    };
  }
}
