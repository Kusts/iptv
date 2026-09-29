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
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "@iptv/database";
import { commandResultHttpStatus } from "@iptv/domain";
import type { CommandResult, CommandActor } from "@iptv/domain";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import { CommandBus, commandActorFromRequestParts } from "../commands/command-bus.js";

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

interface AccountRow {
  id: string;
  display_name: string;
  account_type: string;
  status: string;
  linked_tenant_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function toPublicAccount(row: AccountRow): Record<string, unknown> {
  return {
    id: row.id,
    displayName: row.display_name,
    accountType: row.account_type,
    status: row.status,
    linkedTenantId: row.linked_tenant_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Wave 13 Partners/Resellers surface. Writes go through the `CommandBus`
 * (owning context for accounts, direct-edge hierarchy, prepaid credit,
 * orders and Academy gates); reads are plain tenant-scoped selects
 * shaped to the OpenAPI contract.
 *
 * Permission reuse (no new keys, no migration in this slice):
 * B2B-lifecycle writes/reads reuse `crm.lead.write` / `crm.person.read`
 * (same acquisition family as the referral slice); money writes
 * (topup/reserve/release/orders/price-books) reuse
 * `commerce.order.write` (same procurement-money family as the
 * supplier-credit slice).
 *
 * Direct-edge rule: management writes carry the acting parent; network
 * aggregates expose DIRECT children only (ancestors aggregate, never
 * manage — G15).
 *
 * Partner scope derives from auth (`partners.partner_memberships`):
 * every management/financial/Academy write requires the caller's
 * membership in the affected account — the acting parent is derived
 * from the live edge when the body omits it, never trusted blindly.
 *
 * Reservations exist only inside the order transaction: there is no
 * standalone reserve endpoint (release survives for pre-existing holds).
 */
@Controller("v1")
export class PartnersController {
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

  private async requireAccount(tenantId: string, accountId: string): Promise<AccountRow> {
    const row = await this.requireDb()
      .selectFrom("partners.partner_accounts")
      .select(["id", "display_name", "account_type", "status", "linked_tenant_id", "created_at", "updated_at"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", accountId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "partner account not found" }, 404);
    }
    return row;
  }

  @Post("partners")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async createAccount(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "partners.create_account", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Get("partners")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async listAccounts(@Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const rows = await this.requireDb()
      .selectFrom("partners.partner_accounts")
      .select(["id", "display_name", "account_type", "status", "linked_tenant_id", "created_at", "updated_at"])
      .where("tenant_id", "=", tenant.id)
      .orderBy("created_at", "asc")
      .limit(200)
      .execute();
    return { items: rows.map(toPublicAccount) };
  }

  @Get("partners/:id")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async getAccount(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    return toPublicAccount(await this.requireAccount(tenant.id, id));
  }

  @Post("partners/:id/children")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async createChild(@Param("id") id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), parentAccountId: id }
        : { parentAccountId: id };
    const result = await this.bus.execute(actorFromRequest(req), "partners.create_direct_relationship", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("partners/:id/capabilities")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async setCapability(@Param("id") id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), partnerAccountId: id }
        : { partnerAccountId: id };
    const result = await this.bus.execute(actorFromRequest(req), "partners.set_capability", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("partners/:id/activate")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async activate(@Param("id") id: string, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(
      actorFromRequest(req),
      "partners.activate",
      { partnerAccountId: id },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  private async creditBalance(tenantId: string, accountId: string): Promise<{ currency: string; ledgerMinor: string; reservedMinor: string; availableMinor: string }[]> {
    const db = this.requireDb();
    const ledger = await sql<{ currency: string; total: string }>`
      SELECT currency, COALESCE(SUM(amount_minor), 0)::text AS total
      FROM partners.reseller_credit_entries
      WHERE tenant_id = ${tenantId}::uuid AND partner_account_id = ${accountId}::uuid
      GROUP BY currency`.execute(db);
    const reserved = await sql<{ currency: string; total: string }>`
      SELECT currency, COALESCE(SUM(amount_minor), 0)::text AS total
      FROM partners.reseller_credit_reservations
      WHERE tenant_id = ${tenantId}::uuid AND partner_account_id = ${accountId}::uuid
        AND status = 'RESERVED'
      GROUP BY currency`.execute(db);
    const byCurrency = new Map<string, { ledger: string; reserved: string }>();
    for (const row of ledger.rows) {
      byCurrency.set(row.currency, { ledger: row.total, reserved: "0" });
    }
    for (const row of reserved.rows) {
      const current = byCurrency.get(row.currency) ?? { ledger: "0", reserved: "0" };
      current.reserved = row.total;
      byCurrency.set(row.currency, current);
    }
    return [...byCurrency.entries()].map(([currency, amounts]) => ({
      currency,
      ledgerMinor: amounts.ledger,
      reservedMinor: amounts.reserved,
      availableMinor: (BigInt(amounts.ledger) - BigInt(amounts.reserved)).toString(),
    }));
  }

  @Post("partners/:id/credits/topup")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("commerce.order.write")
  async topupCredit(@Param("id") id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), partnerAccountId: id }
        : { partnerAccountId: id };
    const result = await this.bus.execute(actorFromRequest(req), "partners.topup_credit", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("partners/credit-reservations/:reservationId/release")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("commerce.order.write")
  async releaseCredit(@Param("reservationId") reservationId: string, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(
      actorFromRequest(req),
      "partners.release_credit",
      { reservationId },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  @Get("partners/:id/credits")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async getCredits(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    await this.requireAccount(tenant.id, id);
    return { partnerAccountId: id, balances: await this.creditBalance(tenant.id, id) };
  }

  @Post("partners/price-books")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("commerce.order.write")
  async publishPriceBook(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "partners.publish_price_book", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("reseller-orders")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("commerce.order.write")
  async createOrder(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "partners.create_reseller_order", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Get("reseller-orders/:id")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async getOrder(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const row = await this.requireDb()
      .selectFrom("partners.reseller_orders")
      .select([
        "id",
        "partner_account_id",
        "price_book_id",
        "quantity",
        "unit_price_minor",
        "total_minor",
        "currency",
        "status",
        "credit_reservation_id",
        "settled_at",
      ])
      .where("tenant_id", "=", tenant.id)
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "reseller order not found" }, 404);
    }
    return {
      id: row.id,
      partnerAccountId: row.partner_account_id,
      priceBookId: row.price_book_id,
      quantity: row.quantity,
      unitPriceMinor: String(row.unit_price_minor),
      totalMinor: String(row.total_minor),
      currency: row.currency,
      status: row.status,
      creditReservationId: row.credit_reservation_id,
      settledAt: row.settled_at?.toISOString() ?? null,
    };
  }

  /**
   * Direct-children network aggregate (G15): ONLY direct children of
   * `:id` are listed, each with its own credit/order/academy totals.
   * Ancestors aggregate — they never see (or manage) deeper levels here.
   */
  @Get("partners/:id/network")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async getNetwork(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    await this.requireAccount(tenant.id, id);
    const db = this.requireDb();
    const children = await db
      .selectFrom("partners.partner_relationships as rel")
      .innerJoin("partners.partner_accounts as child", (join) =>
        join.onRef("child.tenant_id", "=", "rel.tenant_id").onRef("child.id", "=", "rel.child_account_id"),
      )
      .select([
        "child.id",
        "child.display_name",
        "child.account_type",
        "child.status",
        "child.linked_tenant_id",
        "child.created_at",
        "child.updated_at",
      ])
      .where("rel.tenant_id", "=", tenant.id)
      .where("rel.parent_account_id", "=", id)
      .where("rel.status", "=", "ACTIVE")
      .orderBy("child.created_at", "asc")
      .execute();
    const items: Record<string, unknown>[] = [];
    for (const child of children) {
      const balances = await this.creditBalance(tenant.id, child.id);
      const orders = await db
        .selectFrom("partners.reseller_orders")
        .select(["id", "status", "total_minor", "currency"])
        .where("tenant_id", "=", tenant.id)
        .where("partner_account_id", "=", child.id)
        .execute();
      const settled = orders.filter((order) => order.status === "SETTLED");
      const progress = await db
        .selectFrom("partners.learning_progress")
        .select(["id"])
        .where("tenant_id", "=", tenant.id)
        .where("partner_account_id", "=", child.id)
        .where("status", "=", "COMPLETED")
        .execute();
      items.push({
        ...toPublicAccount({
          id: child.id,
          display_name: child.display_name,
          account_type: child.account_type,
          status: child.status,
          linked_tenant_id: child.linked_tenant_id,
          created_at: child.created_at,
          updated_at: child.updated_at,
        }),
        balances,
        orderCount: orders.length,
        settledOrderCount: settled.length,
        settledTotalMinor: settled.reduce((sum, order) => sum + BigInt(String(order.total_minor)), 0n).toString(),
        completedTopics: progress.length,
      });
    }
    return { partnerAccountId: id, directChildren: items };
  }

  /** 360 view: account + lifecycle + credits + orders + Academy progress. */
  @Get("partners/:id/summary")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async getSummary(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const account = await this.requireAccount(tenant.id, id);
    const db = this.requireDb();
    const balances = await this.creditBalance(tenant.id, id);
    const orders = await db
      .selectFrom("partners.reseller_orders")
      .select(["id", "status", "total_minor", "currency", "settled_at"])
      .where("tenant_id", "=", tenant.id)
      .where("partner_account_id", "=", id)
      .orderBy("created_at", "desc")
      .limit(200)
      .execute();
    const content = await db
      .selectFrom("partners.learning_content")
      .select(["id", "topic_key", "title", "position"])
      .orderBy("position", "asc")
      .execute();
    const progress = await db
      .selectFrom("partners.learning_progress")
      .select(["content_id", "status", "completed_at"])
      .where("tenant_id", "=", tenant.id)
      .where("partner_account_id", "=", id)
      .execute();
    const byContent = new Map(progress.map((row) => [row.content_id, row]));
    const capabilities = await db
      .selectFrom("partners.partner_capabilities")
      .select(["capability_key", "status"])
      .where("tenant_id", "=", tenant.id)
      .where("partner_account_id", "=", id)
      .execute();
    return {
      account: toPublicAccount(account),
      balances,
      orders: orders.map((order) => ({
        id: order.id,
        status: order.status,
        totalMinor: String(order.total_minor),
        currency: order.currency,
        settledAt: order.settled_at?.toISOString() ?? null,
      })),
      academy: {
        totalTopics: content.length,
        completedTopics: progress.filter((row) => row.status === "COMPLETED").length,
        topics: content.map((topic) => ({
          topicKey: topic.topic_key,
          title: topic.title,
          status: byContent.get(topic.id)?.status ?? "NOT_STARTED",
          completedAt: byContent.get(topic.id)?.completed_at?.toISOString() ?? null,
        })),
      },
      capabilities: capabilities.map((row) => ({ capabilityKey: row.capability_key, status: row.status })),
    };
  }

  @Get("academy/content")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.person.read")
  async listAcademyContent() {
    const rows = await this.requireDb()
      .selectFrom("partners.learning_content")
      .select(["id", "topic_key", "title", "position"])
      .orderBy("position", "asc")
      .execute();
    return {
      items: rows.map((row) => ({ id: row.id, topicKey: row.topic_key, title: row.title, position: row.position })),
    };
  }

  @Post("academy/progress")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("crm.lead.write")
  async completeTopic(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "partners.complete_topic", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }
}
