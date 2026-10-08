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
 * Wave 5 Billing surface. Writes go through the `CommandBus` (owning
 * context for Charge/Payment/Refund; refund execution stays human-gated).
 * Reads run inside `withTenantTransaction` (actor tenant): the tables below
 * are RLS-enrolled (migration 052, fail-closed when `app.tenant_id` is
 * unset), so pool-level selects under `iptv_app` would return empty
 * silently after cutover. The explicit `tenant_id =` predicates stay as
 * defense-in-depth alongside the RLS policy.
 */
@Controller("v1")
export class BillingController {
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

  @Post("charges")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.charge.write")
  async createCharge(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "charge.create", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("charges/:id/reconcile")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.charge.write")
  async reconcileCharge(@Param("id") id: string, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "charge.reconcile", { chargeId: id }, {
      correlationId: req.id,
    });
    return send(result);
  }

  @Post("charges/:id/cancel")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.charge.write")
  async cancelCharge(@Param("id") id: string, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "charge.cancel", { chargeId: id }, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("charges/expire-due")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.charge.write")
  async expireCharges(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "charge.expire_due", body ?? {}, {
      correlationId: req.id,
    });
    return send(result);
  }

  @Post("refund-requests")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.refund.request")
  async requestRefund(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "refund.request", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("refund-requests/:id/execute")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.refund.execute")
  async executeRefund(@Param("id") id: string, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "refund.execute_approved", { refundRequestId: id }, {
      correlationId: req.id,
    });
    return send(result);
  }

  @Post("refunds/:id/reconcile")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.refund.execute")
  async reconcileRefund(@Param("id") id: string, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "refund.reconcile", { refundId: id }, {
      correlationId: req.id,
    });
    return send(result);
  }

  @Post("billing-exceptions/:id/resolve")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.exception.resolve")
  async resolveException(@Param("id") id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const payload = { exceptionId: id, ...((body ?? {}) as Record<string, unknown>) };
    const result = await this.bus.execute(actorFromRequest(req), "billing.exception_resolve", payload, {
      correlationId: req.id,
    });
    return send(result);
  }

  @Get("charges")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.read")
  async listCharges(@Query() query: { limit?: string; offset?: string }, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const { limit, offset } = pagination(query);
    const rows = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("billing.charges")
        .select(["id", "order_id", "status", "amount_minor", "currency", "payment_method", "created_at", "paid_at"])
        .where("tenant_id", "=", tenant.id)
        .orderBy("created_at", "desc")
        .limit(limit)
        .offset(offset)
        .execute(),
    );
    return { charges: rows };
  }

  @Get("payments")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.read")
  async listPayments(@Query() query: { limit?: string; offset?: string }, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const { limit, offset } = pagination(query);
    const rows = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("billing.payments")
        .select(["id", "order_id", "charge_id", "status", "amount_minor", "currency", "confirmed_at"])
        .where("tenant_id", "=", tenant.id)
        .orderBy("confirmed_at", "desc")
        .limit(limit)
        .offset(offset)
        .execute(),
    );
    return { payments: rows };
  }

  @Get("refund-requests")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.read")
  async listRefundRequests(@Query() query: { limit?: string; offset?: string }, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const { limit, offset } = pagination(query);
    const rows = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("billing.refund_requests")
        .select(["id", "payment_id", "status", "amount_minor", "currency", "requested_at", "decided_at", "executed_at"])
        .where("tenant_id", "=", tenant.id)
        .orderBy("requested_at", "desc")
        .limit(limit)
        .offset(offset)
        .execute(),
    );
    return { refund_requests: rows };
  }

  @Get("billing-exceptions")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("billing.read")
  async listExceptions(@Query() query: { limit?: string; offset?: string; status?: string }, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const { limit, offset } = pagination(query);
    const status = typeof query.status === "string" && query.status.length > 0 ? query.status : null;
    const rows = await withTenantTransaction(this.requireDb(), tenant.id, (trx) => {
      let select = trx
        .selectFrom("billing.exceptions")
        .select(["id", "kind", "status", "charge_id", "payment_id", "refund_id", "reason", "created_at"])
        .where("tenant_id", "=", tenant.id)
        .orderBy("created_at", "desc")
        .limit(limit)
        .offset(offset);
      if (status !== null) {
        select = select.where("status", "=", status);
      }
      return select.execute();
    });
    return { exceptions: rows };
  }
}
