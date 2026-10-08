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
import type { Database } from "@iptv/database";
import { withTenantTransaction } from "@iptv/database";
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

function pagination(query: { limit?: string; offset?: string }): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 100);
  const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
  return { limit, offset };
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
 * Wave 2 Communications surface. Manual replies / takeover / return / close
 * go through the `CommandBus` as HUMAN actions (`conversation.reply`).
 * Reads are plain tenant-scoped selects inside `withTenantTransaction`
 * (actor tenant): `communication.*` tables are RLS-enrolled (migration 042,
 * fail-closed when `app.tenant_id` is unset), so pool-level selects under
 * `iptv_app` would return empty silently. The explicit `tenant_id =`
 * predicates stay as defense-in-depth alongside the RLS policy.
 */
@Controller("v1/communications")
export class CommunicationsController {
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

  @Post("conversations")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("conversation.reply")
  async startManual(@Body() body: unknown, @Req() req: FastifyRequest): Promise<{ id: string }> {
    const result = await this.bus.execute<{ id: string }>(actorFromRequest(req), "conversation.start_manual", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Get("conversations")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("conversation.reply")
  async listConversations(@Req() req: FastifyRequest, @Query() query: { limit?: string; offset?: string; status?: string }) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const { limit, offset } = pagination(query);
    const status = query.status;
    return withTenantTransaction(this.requireDb(), tenant.id, async (trx) => {
      let qb = trx
        .selectFrom("communication.conversations")
        .select(["id", "person_id", "channel", "status", "control_mode", "last_message_at", "created_at"])
        .where("tenant_id", "=", tenant.id)
        .orderBy("last_message_at", "desc")
        .limit(limit)
        .offset(offset);
      if (status !== undefined) {
        qb = qb.where("status", "=", status);
      }
      const rows = await qb.execute();
      return {
        conversations: rows.map((r) => ({
          id: r.id,
          personId: r.person_id,
          channel: r.channel,
          status: r.status,
          controlMode: r.control_mode,
          lastMessageAt: r.last_message_at?.toISOString() ?? null,
          createdAt: r.created_at.toISOString(),
        })),
      };
    });
  }

  @Get("conversations/:id")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("conversation.reply")
  async getConversation(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    return withTenantTransaction(this.requireDb(), tenant.id, async (trx) => {
      const row = await trx
        .selectFrom("communication.conversations")
        .select(["id", "person_id", "channel", "external_thread_id", "status", "control_mode", "last_message_at", "created_at"])
        .where("tenant_id", "=", tenant.id)
        .where("id", "=", id)
        .executeTakeFirst();
      if (row === undefined) {
        throw new HttpException({ code: "NOT_FOUND", message: "conversation not found" }, 404);
      }
      const last = await trx
        .selectFrom("communication.messages")
        .select(["id", "direction", "sender_type", "body_text", "occurred_at"])
        .where("tenant_id", "=", tenant.id)
        .where("conversation_id", "=", id)
        .orderBy("occurred_at", "desc")
        .limit(1)
        .executeTakeFirst();
      return {
        id: row.id,
        personId: row.person_id,
        channel: row.channel,
        externalThreadId: row.external_thread_id,
        status: row.status,
        controlMode: row.control_mode,
        lastMessageAt: row.last_message_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
        lastMessage: last
          ? {
              id: last.id,
              direction: last.direction,
              senderType: last.sender_type,
              bodyText: last.body_text,
              occurredAt: last.occurred_at.toISOString(),
            }
          : null,
      };
    });
  }

  @Get("conversations/:id/messages")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("conversation.reply")
  async listMessages(
    @Param("id") id: string,
    @Req() req: FastifyRequest,
    @Query() query: { limit?: string; offset?: string },
  ) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const { limit, offset } = pagination(query);
    return withTenantTransaction(this.requireDb(), tenant.id, async (trx) => {
      const conv = await trx
        .selectFrom("communication.conversations")
        .select(["id"])
        .where("tenant_id", "=", tenant.id)
        .where("id", "=", id)
        .executeTakeFirst();
      if (conv === undefined) {
        throw new HttpException({ code: "NOT_FOUND", message: "conversation not found" }, 404);
      }
      const rows = await trx
        .selectFrom("communication.messages")
        .select(["id", "direction", "sender_type", "content_type", "body_text", "external_message_id", "occurred_at"])
        .where("tenant_id", "=", tenant.id)
        .where("conversation_id", "=", id)
        .orderBy("occurred_at", "asc")
        .limit(limit)
        .offset(offset)
        .execute();
    // Latest delivery attempt per message (ordered by attempt_no DESC), or
    // null when no delivery exists. Tenant-scoped: never exposes another
    // tenant's deliveries. Additive field matching the OpenAPI Message
    // `deliveryStatus` concept (`string | null`).
    const latestByMessage = new Map<string, string>();
    if (rows.length > 0) {
      const deliveries = await trx
        .selectFrom("communication.message_deliveries")
        .select(["message_id", "status", "attempt_no"])
        .where("tenant_id", "=", tenant.id)
        .where(
          "message_id",
          "in",
          rows.map((r) => r.id),
        )
        .orderBy("attempt_no", "desc")
        .execute();
      for (const delivery of deliveries) {
        if (!latestByMessage.has(delivery.message_id)) {
          latestByMessage.set(delivery.message_id, delivery.status);
        }
      }
    }
    return {
      messages: rows.map((r) => ({
        id: r.id,
        direction: r.direction,
        senderType: r.sender_type,
        contentType: r.content_type,
        bodyText: r.body_text,
        externalMessageId: r.external_message_id,
        occurredAt: r.occurred_at.toISOString(),
        deliveryStatus: latestByMessage.get(r.id) ?? null,
      })),
    };
    });
  }

  @Post("conversations/:id/send-manual")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("conversation.reply")
  async sendManual(
    @Param("id") id: string,
    @Body() body: { text?: unknown },
    @Req() req: FastifyRequest,
  ): Promise<{ messageId: string; deliveryStatus: string; providerMessageId: string | null }> {
    const result = await this.bus.execute<{
      messageId: string;
      deliveryStatus: string;
      providerMessageId: string | null;
    }>(actorFromRequest(req), "message.send_manual", { conversationId: id, text: body.text }, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("conversations/:id/assign")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("conversation.reply")
  async assign(
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ): Promise<{ id: string; controlMode: string; already: boolean }> {
    const result = await this.bus.execute<{ id: string; controlMode: string; already: boolean }>(
      actorFromRequest(req),
      "conversation.assign",
      { conversationId: id },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  @Post("conversations/:id/release")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("conversation.reply")
  async release(
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ): Promise<{ id: string; controlMode: string; already: boolean }> {
    const result = await this.bus.execute<{ id: string; controlMode: string; already: boolean }>(
      actorFromRequest(req),
      "conversation.release",
      { conversationId: id },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  @Post("conversations/:id/close")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("conversation.reply")
  async close(@Param("id") id: string, @Req() req: FastifyRequest): Promise<{ id: string; status: string }> {
    const result = await this.bus.execute<{ id: string; status: string }>(
      actorFromRequest(req),
      "conversation.close",
      { conversationId: id },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  @Get("exceptions")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("conversation.reply")
  async listExceptions(@Req() req: FastifyRequest, @Query() query: { limit?: string; offset?: string; status?: string }) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const { limit, offset } = pagination(query);
    const status = query.status ?? "OPEN";
    return withTenantTransaction(this.requireDb(), tenant.id, async (trx) => {
      const rows = await trx
        .selectFrom("communication.exceptions")
        .select(["id", "kind", "status", "channel", "external_message_id", "from_address", "reason", "created_at"])
        .where("tenant_id", "=", tenant.id)
        .where("status", "=", status)
        .orderBy("created_at", "desc")
        .limit(limit)
        .offset(offset)
        .execute();
      return {
        exceptions: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          channel: r.channel,
          externalMessageId: r.external_message_id,
          fromAddress: r.from_address,
          reason: r.reason,
          createdAt: r.created_at.toISOString(),
        })),
      };
    });
  }

  @Post("exceptions/:id/resolve")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("conversation.reply")
  async resolveException(
    @Param("id") id: string,
    @Body() body: { action?: unknown; personId?: unknown; reason?: unknown },
    @Req() req: FastifyRequest,
  ): Promise<{ id: string; status: string; conversationId: string | null }> {
    const result = await this.bus.execute<{ id: string; status: string; conversationId: string | null }>(
      actorFromRequest(req),
      "exception.resolve",
      { exceptionId: id, action: body.action, personId: body.personId, reason: body.reason },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }
}
