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
import type { CommandResult, CommandActor } from "@iptv/domain";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import { CommandBus, commandActorFromRequestParts } from "../commands/command-bus.js";
import { listAppTrials } from "./app-trial.store.js";
import { listReconciliationFindings } from "./license.store.js";

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
 * Wave 7 Inventory surface (Apps/MK). Writes go through the `CommandBus`
 * (owning contexts: AppTrial, supplier credit, LicenseAsset); reads are
 * plain tenant-scoped selects shaped to the OpenAPI contract.
 *
 * Permission reuse (no new keys, no migration in this slice): trial-adjacent
 * writes/reads use `trial.*`, balance reads and license activation/
 * reconciliation use `provider.operation.*`, and procurement-money writes
 * (reserve/release/purchase) use `commerce.order.write`.
 */
@Controller("v1")
export class InventoryController {
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

  @Post("inventory/app-trials")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.write")
  async requestAppTrial(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "inventory.request_app_trial", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Get("inventory/app-trials")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.read")
  async listAppTrials(
    @Query("personId") personId: string | undefined,
    @Query("supplierId") supplierId: string | undefined,
    @Query("status") status: string | undefined,
    @Req() req: FastifyRequest,
  ) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const items = await listAppTrials(this.requireDb(), tenant.id, {
      personId,
      supplierId,
      status,
      limit: 100,
    });
    return {
      items: items.map((row) => ({
        id: row.id,
        personId: row.personId,
        customerId: row.customerId,
        supplierId: row.supplierId,
        supplierAppExternalId: row.supplierAppExternalId,
        status: row.status,
        requestedAt: row.requestedAt.toISOString(),
        validatedAt: row.validatedAt?.toISOString() ?? null,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      })),
    };
  }

  @Post("inventory/app-trials/:id/validate")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.write")
  async validateAppTrial(@Param("id") id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), trialId: id }
        : { trialId: id };
    const result = await this.bus.execute(actorFromRequest(req), "inventory.validate_app_trial", payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("inventory/app-trials/expire-due")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("trial.write")
  async expireAppTrials(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "inventory.expire_app_trials", body ?? {}, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Get("inventory/supplier-balance")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("provider.operation.read")
  async getSupplierBalance(@Query("supplierId") supplierId: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const db = this.requireDb();
    const snapshot = await db
      .selectFrom("inventory.supplier_balance_snapshots")
      .select(["id", "supplier_id", "balance_minor", "currency", "observed_at", "evidence_ref"])
      .where("tenant_id", "=", tenant.id)
      .where("supplier_id", "=", supplierId)
      .orderBy("observed_at", "desc")
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    if (snapshot === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "no balance reading for this supplier" }, 404);
    }
    return {
      supplierId: snapshot.supplier_id,
      balanceMinor: String(snapshot.balance_minor),
      currency: snapshot.currency,
      observedAt: snapshot.observed_at.toISOString(),
      evidenceRef: snapshot.evidence_ref,
      snapshotId: snapshot.id,
    };
  }

  @Post("inventory/supplier-balance/refreshes")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("provider.operation.write")
  async refreshSupplierBalance(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "inventory.refresh_supplier_balance", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("inventory/credit-reservations")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("commerce.order.write")
  async reserveAppCredit(@Body() body: unknown, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(actorFromRequest(req), "inventory.reserve_app_credit", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("inventory/credit-reservations/:id/release")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("commerce.order.write")
  async releaseAppCredit(@Param("id") id: string, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(
      actorFromRequest(req),
      "inventory.release_app_credit",
      { reservationId: id },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  @Post("inventory/license-purchases")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("commerce.order.write")
  async purchaseAppLicense(@Body() body: unknown, @Req() req: FastifyRequest) {
    // Wave 7 review fix F1: two committed phases. The intent (gate +
    // PROVISIONING + REQUESTED operation) commits BEFORE the external
    // charge; the execute step then runs the single charge and finalizes.
    // A crash between them leaves a recoverable VERIFYING/REQUESTED
    // intention, never a lost charge record.
    const intent = await this.bus.execute<Record<string, unknown>>(
      actorFromRequest(req),
      "inventory.purchase_app_license",
      body,
      {
        correlationId: req.id,
        idempotencyKey: idempotencyKeyOf(req),
      },
    );
    const intentData = send(intent);
    if (intentData["status"] !== "PROVISIONING") {
      return intentData;
    }
    const payload = body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
    const chargeInput: Record<string, unknown> = { licenseId: intentData["id"] };
    if (typeof payload["adapter"] === "string") {
      chargeInput["adapter"] = payload["adapter"];
    }
    if (typeof payload["echoOutcome"] === "string") {
      chargeInput["echoOutcome"] = payload["echoOutcome"];
    }
    const charged = await this.bus.execute<Record<string, unknown>>(
      actorFromRequest(req),
      "inventory.execute_app_license_charge",
      chargeInput,
      {
        correlationId: req.id,
        idempotencyKey: idempotencyKeyOf(req),
      },
    );
    return send(charged);
  }

  @Post("licenses/:id/activate")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("provider.operation.write")
  async activateAppLicense(@Param("id") id: string, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(
      actorFromRequest(req),
      "inventory.activate_app_license",
      { licenseId: id },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  @Post("licenses/:id/reconcile")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("provider.operation.write")
  async reconcileSupplierPurchase(@Param("id") id: string, @Req() req: FastifyRequest) {
    const result = await this.bus.execute(
      actorFromRequest(req),
      "inventory.reconcile_supplier_purchase",
      { licenseId: id },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  @Get("reconciliation-findings")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("provider.operation.read")
  async listFindings(@Query("status") status: string | undefined, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const items = await listReconciliationFindings(this.requireDb(), tenant.id, { status, limit: 100 });
    return {
      items: items.map((row) => ({
        id: row.id,
        entityType: row.entityType,
        entityId: row.entityId,
        expected: row.expected,
        observed: row.observed,
        status: row.status,
        resolutionRef: row.resolutionRef,
        createdAt: row.createdAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
      })),
    };
  }
}
