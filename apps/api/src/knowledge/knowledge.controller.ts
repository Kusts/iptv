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
import { commandResultHttpStatus } from "@iptv/domain";
import type { CommandActor, CommandResult } from "@iptv/domain";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import { CommandBus, commandActorFromRequestParts } from "../commands/command-bus.js";
import { KNOWLEDGE_TYPES } from "./knowledge.commands.js";
import { rankSuggestions, tokenize } from "./knowledge-policy.js";

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

/**
 * Wave 8 minimal tenant-scoped knowledge surface.
 *
 * Writes go through the `CommandBus`; reads join the item to its
 * `current_version_id` row (the read model — old versions stay append-only
 * history). Search is plain ILIKE/tag matching over current versions
 * (pg_trgm/FTS deliberately deferred). `suggest_for_ticket` is a labeled
 * token-overlap heuristic, never a verified answer.
 */
@Controller("v1/knowledge")
export class KnowledgeController {
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

  private async run<T>(req: FastifyRequest, command: string, payload: unknown): Promise<T> {
    const result = await this.bus.execute<T>(actorFromRequest(req), command, payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("items")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("knowledge.write")
  async create(@Body() body: unknown, @Req() req: FastifyRequest) {
    return this.run(req, "knowledge.item.create", body);
  }

  @Post("items/:id/versions")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("knowledge.write")
  async update(@Param("id") id: string, @Body() body: Record<string, unknown>, @Req() req: FastifyRequest) {
    return this.run(req, "knowledge.item.update", { ...body, itemId: id });
  }

  @Post("items/:id/archive")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("knowledge.write")
  async archive(@Param("id") id: string, @Req() req: FastifyRequest) {
    return this.run(req, "knowledge.item.archive", { itemId: id });
  }

  @Get("items")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("knowledge.read")
  async list(
    @Query() query: { type?: string; status?: string; tag?: string; limit?: string },
    @Req() req: FastifyRequest,
  ) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    if (query.type !== undefined && !(KNOWLEDGE_TYPES as readonly string[]).includes(query.type)) {
      throw new HttpException({ code: "INVALID_TYPE", message: `unknown knowledge type: ${query.type}` }, 400);
    }
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    let select = this.requireDb()
      .selectFrom("knowledge.knowledge_items")
      .innerJoin("knowledge.knowledge_versions", (join) =>
        join
          .onRef("knowledge.knowledge_versions.id", "=", "knowledge.knowledge_items.current_version_id")
          .on("knowledge.knowledge_versions.tenant_id", "=", tenant.id),
      )
      .select([
        "knowledge.knowledge_items.id",
        "knowledge.knowledge_items.status",
        "knowledge.knowledge_items.knowledge_type",
        "knowledge.knowledge_items.canonical_key",
        "knowledge.knowledge_versions.version_no",
        "knowledge.knowledge_versions.content_text",
        "knowledge.knowledge_versions.structured_content_json",
        "knowledge.knowledge_items.updated_at",
      ])
      .where("knowledge.knowledge_items.tenant_id", "=", tenant.id)
      .orderBy("knowledge.knowledge_items.updated_at", "desc")
      .limit(limit);
    if (query.type !== undefined) {
      select = select.where("knowledge.knowledge_items.knowledge_type", "=", query.type);
    }
    if (query.status !== undefined) {
      select = select.where("knowledge.knowledge_items.status", "=", query.status);
    }
    const rows = await select.execute();
    // Tag matching over the current version's `structured_content.tags`
    // array (ILIKE/tag match only — pg_trgm/FTS deliberately deferred).
    const filtered =
      query.tag === undefined
        ? rows
        : rows.filter((r) => {
            const structured = r.structured_content_json as { tags?: unknown } | null;
            return (
              structured !== null &&
              typeof structured === "object" &&
              Array.isArray(structured.tags) &&
              (structured.tags as unknown[]).includes(query.tag)
            );
          });
    return {
      items: filtered.map((r) => ({
        id: r.id,
        status: r.status,
        knowledgeType: r.knowledge_type,
        canonicalKey: r.canonical_key,
        version: Number(r.version_no),
        contentText: r.content_text,
        updatedAt: r.updated_at.toISOString(),
      })),
    };
  }

  @Get("items/:id")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("knowledge.read")
  async get(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const row = await this.requireDb()
      .selectFrom("knowledge.knowledge_items")
      .innerJoin("knowledge.knowledge_versions", (join) =>
        join
          .onRef("knowledge.knowledge_versions.id", "=", "knowledge.knowledge_items.current_version_id")
          .on("knowledge.knowledge_versions.tenant_id", "=", tenant.id),
      )
      .select([
        "knowledge.knowledge_items.id",
        "knowledge.knowledge_items.status",
        "knowledge.knowledge_items.knowledge_type",
        "knowledge.knowledge_items.canonical_key",
        "knowledge.knowledge_versions.version_no",
        "knowledge.knowledge_versions.content_text",
        "knowledge.knowledge_versions.structured_content_json",
        "knowledge.knowledge_items.created_at",
        "knowledge.knowledge_items.updated_at",
      ])
      .where("knowledge.knowledge_items.tenant_id", "=", tenant.id)
      .where("knowledge.knowledge_items.id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "knowledge item not found in this tenant" }, 404);
    }
    return {
      item: {
        id: row.id,
        status: row.status,
        knowledgeType: row.knowledge_type,
        canonicalKey: row.canonical_key,
        version: Number(row.version_no),
        contentText: row.content_text,
        structuredContent: row.structured_content_json,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      },
    };
  }

  @Get("search")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("knowledge.read")
  async search(@Query() query: { q: string; limit?: string }, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const needle = query.q?.trim() ?? "";
    if (needle.length < 2) {
      throw new HttpException({ code: "QUERY_TOO_SHORT", message: "search query needs at least 2 characters" }, 400);
    }
    const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 100);
    const like = `%${needle}%`;
    const rows = await this.requireDb()
      .selectFrom("knowledge.knowledge_items")
      .innerJoin("knowledge.knowledge_versions", (join) =>
        join
          .onRef("knowledge.knowledge_versions.id", "=", "knowledge.knowledge_items.current_version_id")
          .on("knowledge.knowledge_versions.tenant_id", "=", tenant.id),
      )
      .select([
        "knowledge.knowledge_items.id",
        "knowledge.knowledge_items.status",
        "knowledge.knowledge_items.knowledge_type",
        "knowledge.knowledge_items.canonical_key",
        "knowledge.knowledge_versions.version_no",
        "knowledge.knowledge_versions.content_text",
      ])
      .where("knowledge.knowledge_items.tenant_id", "=", tenant.id)
      .where((eb) =>
        eb.or([
          eb("knowledge.knowledge_versions.content_text", "ilike", like),
          eb("knowledge.knowledge_items.canonical_key", "ilike", like),
        ]),
      )
      .where("knowledge.knowledge_items.status", "not in", ["DEPRECATED", "REJECTED"])
      .orderBy("knowledge.knowledge_items.updated_at", "desc")
      .limit(limit)
      .execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        status: r.status,
        knowledgeType: r.knowledge_type,
        canonicalKey: r.canonical_key,
        version: Number(r.version_no),
        contentText: r.content_text,
      })),
    };
  }

  @Get("suggest-for-ticket/:ticketId")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("knowledge.read")
  async suggestForTicket(@Param("ticketId") ticketId: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const db = this.requireDb();
    const ticket = await db
      .selectFrom("support.support_tickets")
      .select(["id", "summary", "category"])
      .where("tenant_id", "=", tenant.id)
      .where("id", "=", ticketId)
      .executeTakeFirst();
    if (ticket === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "ticket not found in this tenant" }, 404);
    }
    const problems = await db
      .selectFrom("support.ticket_problem_links")
      .innerJoin("support.problems", (join) =>
        join
          .onRef("support.problems.id", "=", "support.ticket_problem_links.problem_id")
          .on("support.problems.tenant_id", "=", tenant.id),
      )
      .select(["support.problems.title"])
      .where("support.ticket_problem_links.tenant_id", "=", tenant.id)
      .where("support.ticket_problem_links.support_ticket_id", "=", ticketId)
      .execute();
    const queryText = [ticket.summary, ticket.category ?? "", ...problems.map((p) => p.title)].join(" ");
    const terms = tokenize(queryText);
    const candidates = await db
      .selectFrom("knowledge.knowledge_items")
      .innerJoin("knowledge.knowledge_versions", (join) =>
        join
          .onRef("knowledge.knowledge_versions.id", "=", "knowledge.knowledge_items.current_version_id")
          .on("knowledge.knowledge_versions.tenant_id", "=", tenant.id),
      )
      .select([
        "knowledge.knowledge_items.id",
        "knowledge.knowledge_items.knowledge_type",
        "knowledge.knowledge_versions.content_text",
      ])
      .where("knowledge.knowledge_items.tenant_id", "=", tenant.id)
      .where("knowledge.knowledge_items.status", "not in", ["DEPRECATED", "REJECTED"])
      .orderBy("knowledge.knowledge_items.updated_at", "desc")
      .limit(200)
      .execute();
    const ranked = rankSuggestions(
      terms,
      candidates.map((c) => ({ id: c.id, text: `${c.content_text ?? ""}` })),
      5,
    );
    const byId = new Map(candidates.map((c) => [c.id, c]));
    return {
      heuristic: "token-overlap over current versions (suggest-only, not verified)",
      ticketId: ticket.id,
      suggestions: ranked.map((s) => ({
        itemId: s.id,
        knowledgeType: byId.get(s.id)?.knowledge_type ?? null,
        score: s.score,
        matchedTerms: s.matchedTerms,
      })),
    };
  }
}
