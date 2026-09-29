import { z } from "zod";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { kyselyTrxOf } from "../crm/wave2-store.js";
import { UniqueViolationError } from "../trial/trial-store.js";
import {
  resolveSupplierBalancePort,
  supplierBalanceAdapterFromEnv,
  type SupplierBalancePort,
} from "./supplier-balance.port.js";
import {
  advisoryLockReservation,
  advisoryLockReservationScope,
  advisoryLockSupplierBalance,
  computeAvailablePool,
  findProcurementByCommerceOrder,
  findProcurementByReservation,
  findProcurementByTrial,
  findReservationByKey,
  getReservation,
  insertBalanceSnapshot,
  insertProcurementOrder,
  insertReservation,
  latestBalanceSnapshot,
  nextReservationStatus,
  parsePositiveMinor,
  sumActiveReservations,
  updateProcurementStatusIf,
  updateReservationStatusIf,
  type CreditReservationRow,
} from "./supplier-credit.store.js";

/**
 * Wave 7 slice S2: MK balance + atomic credit-reservation commands.
 *
 * - `inventory.refresh_supplier_balance` persists one append-only balance
 *   reading through the echo/manual port (ports/fakes only — the real MK
 *   Browser Worker adapter is out of scope).
 * - `inventory.reserve_app_credit` holds funds atomically: under a
 *   per-(tenant, supplier) advisory lock it resolves the latest snapshot,
 *   subtracts ACTIVE reservations and inserts the reservation +
 *   procurement order (RESERVED) in the SAME transaction. Insufficient
 *   pool fails closed with `BLOCKED INSUFFICIENT_SUPPLIER_BALANCE` — the
 *   stable F15 signal the caller pauses/alerts on (no alert emitted here).
 * - `inventory.release_app_credit` frees an ACTIVE hold (idempotent replay
 *   on terminal RELEASED/EXPIRED; CONSUMED funds are spent and refuse).
 * - `inventory.expire_credit_reservations` sweeps due ACTIVE holds.
 */

export const refreshSupplierBalanceInput = z.object({
  supplierId: z.string().uuid(),
  balanceMinor: z.string().trim().min(1).max(30).optional(),
  currency: z.string().trim().min(1).max(8).optional(),
  evidenceRef: z.string().trim().min(1).max(500).optional(),
  adapter: z.enum(["echo", "manual"]).optional(),
});

export type RefreshSupplierBalanceInput = z.infer<typeof refreshSupplierBalanceInput>;

export const reserveAppCreditInput = z.object({
  supplierId: z.string().uuid(),
  commerceOrderId: z.string().uuid(),
  appTrialId: z.string().uuid(),
  amountMinor: z.string().trim().min(1).max(30),
  currency: z.string().trim().min(1).max(8),
  idempotencyKey: z.string().trim().min(1).max(200),
  expiresAt: z.string().datetime().optional(),
});

export type ReserveAppCreditInput = z.infer<typeof reserveAppCreditInput>;

export const releaseAppCreditInput = z.object({
  reservationId: z.string().uuid(),
});

export type ReleaseAppCreditInput = z.infer<typeof releaseAppCreditInput>;

export const expireCreditReservationsInput = z.object({
  limit: z.number().int().min(1).max(500).default(100),
});

export type ExpireCreditReservationsInput = z.infer<typeof expireCreditReservationsInput>;

export interface SupplierCreditCommandDeps {
  balancePort?: SupplierBalancePort;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

function toPublicReservation(row: CreditReservationRow, procurementOrderId: string | null): Record<string, unknown> {
  return {
    id: row.id,
    supplierId: row.supplierId,
    totalMinor: row.totalMinor,
    reservedMinor: row.reservedMinor,
    availableMinor: row.availableMinor,
    currency: row.currency,
    status: row.status,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    procurementOrderId,
  };
}

function handleRefreshFactory(deps: SupplierCreditCommandDeps) {
  return async (
    ctx: CommandHandlerContext,
    input: RefreshSupplierBalanceInput,
  ): Promise<CommandResult<{ snapshotId: string; balanceMinor: string; currency: string; evidenceRef: string }>> => {
    const trx = kyselyTrxOf(ctx);
    if (trx === null) {
      throw new Error("supplier credit commands require a database transaction");
    }
    const supplier = await trx
      .selectFrom("inventory.suppliers")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", input.supplierId)
      .executeTakeFirst();
    if (supplier === undefined) {
      return { ok: false, code: "not_found", message: "supplier not found in this tenant" };
    }
    const fallback: "echo" | "manual" =
      deps.balancePort !== undefined ? (deps.balancePort.name === "echo" ? "echo" : "manual") : supplierBalanceAdapterFromEnv();
    const requested = input.adapter ?? fallback;
    const port = deps.balancePort !== undefined && deps.balancePort.name === requested
      ? deps.balancePort
      : resolveSupplierBalancePort(requested);
    const reading = await port.readBalance(
      { tenantId: ctx.tenantId, supplierId: input.supplierId, correlationId: ctx.correlationId },
      { balanceMinor: input.balanceMinor, currency: input.currency, evidenceRef: input.evidenceRef },
    );
    if (reading.certainty !== "KNOWN") {
      return {
        ok: false,
        code: "precondition_failed",
        message: "manual supplier balance reading required (supply balanceMinor/currency/evidenceRef)",
      };
    }
    const snapshot = await insertBalanceSnapshot(ctx, {
      supplierId: input.supplierId,
      balanceMinor: reading.balanceMinor,
      currency: reading.currency,
      observedAt: reading.observedAt,
      evidenceRef: reading.evidenceRef,
    });
    return {
      ok: true,
      data: {
        snapshotId: snapshot.id,
        balanceMinor: snapshot.balanceMinor,
        currency: snapshot.currency,
        evidenceRef: snapshot.evidenceRef,
      },
    };
  };
}

async function handleReserve(
  ctx: CommandHandlerContext,
  input: ReserveAppCreditInput,
): Promise<CommandResult<Record<string, unknown>>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("supplier credit commands require a database transaction");
  }
  const currency = input.currency.trim().toUpperCase();
  if (!CURRENCY_RE.test(currency)) {
    return { ok: false, code: "validation_failed", message: "currency must be an explicit 3-letter code" };
  }
  let amount: bigint;
  try {
    const parsed = parsePositiveMinor(input.amountMinor);
    if (parsed === null) {
      throw new Error("amount unknown");
    }
    amount = parsed;
  } catch {
    return { ok: false, code: "validation_failed", message: "amountMinor must be a strictly positive integer" };
  }

  await advisoryLockSupplierBalance(trx, ctx.tenantId, input.supplierId);

  const supplier = await trx
    .selectFrom("inventory.suppliers")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.supplierId)
    .executeTakeFirst();
  if (supplier === undefined) {
    return { ok: false, code: "not_found", message: "supplier not found in this tenant" };
  }
  const commerceOrder = await trx
    .selectFrom("commerce.orders")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.commerceOrderId)
    .executeTakeFirst();
  if (commerceOrder === undefined) {
    return { ok: false, code: "not_found", message: "commerce order not found in this tenant" };
  }
  const trial = await trx
    .selectFrom("inventory.app_trials")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.appTrialId)
    .executeTakeFirst();
  if (trial === undefined) {
    return { ok: false, code: "not_found", message: "app trial not found in this tenant" };
  }

  const replayed = await findReservationByKey(ctx, input.supplierId, input.idempotencyKey.trim());
  if (replayed !== null) {
    const procurement = await findProcurementByReservation(ctx, replayed.id);
    return { ok: true, data: { ...toPublicReservation(replayed, procurement?.id ?? null), already: true } };
  }

  // Wave 7 review fix F5: the purchase identity is (order, trial). A
  // non-FAILED procurement already covering either one means this reserve
  // is a duplicate with a different idempotency key — return it instead
  // of creating a second charge-eligible procurement.
  const identityHit =
    (await findProcurementByCommerceOrder(ctx, input.commerceOrderId)) ??
    (await findProcurementByTrial(ctx, input.appTrialId));
  if (identityHit !== null) {
    const identityReservation = identityHit.creditReservationId === null
      ? null
      : await getReservation(ctx, identityHit.creditReservationId);
    if (identityReservation !== null) {
      return {
        ok: true,
        data: { ...toPublicReservation(identityReservation, identityHit.id), already: true },
      };
    }
  }

  const snapshot = await latestBalanceSnapshot(ctx, input.supplierId);
  if (snapshot === null) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "BLOCKED SUPPLIER_BALANCE_UNKNOWN: no balance reading for this supplier",
    };
  }
  if (snapshot.currency !== currency) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `BLOCKED CURRENCY_MISMATCH: reservation is ${currency} but supplier balance is ${snapshot.currency}`,
    };
  }
  const activeTotal = await sumActiveReservations(ctx, input.supplierId);
  const available = computeAvailablePool(snapshot.balanceMinor, activeTotal);
  if (BigInt(available) < amount) {
    return {
      ok: false,
      code: "precondition_failed",
      message:
        `BLOCKED INSUFFICIENT_SUPPLIER_BALANCE: available ${available} ${currency} ` +
        `is less than the requested ${amount.toString()} (caller pauses/alerts, F15)`,
    };
  }

  let expiresAt: Date | null = null;
  if (input.expiresAt !== undefined) {
    expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      return { ok: false, code: "validation_failed", message: "expiresAt must be a valid date-time" };
    }
  }

  // Orphan guard (F5 race): if the procurement insert loses the identity
  // race below, the reservation row just created must be unwound so it
  // does not hold funds without a procurement.
  let createdReservationId: string | null = null;
  try {
    const reservation = await insertReservation(ctx, {
      supplierId: input.supplierId,
      amountMinor: amount.toString(),
      currency,
      idempotencyKey: input.idempotencyKey.trim(),
      expiresAt,
    });
    createdReservationId = reservation.id;
    const procurement = await insertProcurementOrder(ctx, {
      supplierId: input.supplierId,
      commerceOrderId: input.commerceOrderId,
      appTrialId: input.appTrialId,
      creditReservationId: reservation.id,
      totalCostMinor: amount.toString(),
      currency,
      status: "RESERVED",
    });
    return { ok: true, data: { ...toPublicReservation(reservation, procurement.id), already: false } };
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      const raced = await findReservationByKey(ctx, input.supplierId, input.idempotencyKey.trim());
      if (raced !== null) {
        const procurement = await findProcurementByReservation(ctx, raced.id);
        return { ok: true, data: { ...toPublicReservation(raced, procurement?.id ?? null), already: true } };
      }
      // Wave 7 review fix F5: migration 027 identity conflict — a
      // concurrent reserve won the same order/trial. Unwind the orphan
      // hold, then return the winner as an idempotent conflict instead
      // of a second procurement.
      if (createdReservationId !== null) {
        await updateReservationStatusIf(ctx, createdReservationId, "ACTIVE", "RELEASED");
      }
      const winner =
        (await findProcurementByCommerceOrder(ctx, input.commerceOrderId)) ??
        (await findProcurementByTrial(ctx, input.appTrialId));
      if (winner !== null && winner.creditReservationId !== null) {
        const winnerReservation = await getReservation(ctx, winner.creditReservationId);
        if (winnerReservation !== null) {
          return {
            ok: true,
            data: { ...toPublicReservation(winnerReservation, winner.id), already: true },
          };
        }
      }
      return { ok: false, code: "precondition_failed", message: err.message };
    }
    throw err;
  }
}

async function handleRelease(
  ctx: CommandHandlerContext,
  input: ReleaseAppCreditInput,
): Promise<CommandResult<Record<string, unknown>>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("supplier credit commands require a database transaction");
  }
  await advisoryLockReservation(trx, input.reservationId);
  const reservation = await getReservation(ctx, input.reservationId);
  if (reservation === null) {
    return { ok: false, code: "not_found", message: "credit reservation not found in this tenant" };
  }
  if (reservation.status === "CONSUMED") {
    return { ok: false, code: "precondition_failed", message: "reservation is CONSUMED; spent funds cannot be released" };
  }
  if (reservation.status === "RELEASED" || reservation.status === "EXPIRED") {
    const procurement = await findProcurementByReservation(ctx, reservation.id);
    return { ok: true, data: { ...toPublicReservation(reservation, procurement?.id ?? null), already: true } };
  }
  // Wave 7 review fix F2: serialize with purchase-consume and expire on
  // the SAME keys (supplier lock first, reservation-scope lock second —
  // the global lock order), then transition conditionally so a raced
  // purchase winner is observed, never overwritten.
  await advisoryLockSupplierBalance(trx, ctx.tenantId, reservation.supplierId);
  await advisoryLockReservationScope(trx, ctx.tenantId, reservation.id);
  const updated = await updateReservationStatusIf(ctx, reservation.id, "ACTIVE", nextReservationStatus("ACTIVE", "RELEASE"));
  if (updated === null) {
    const raced = await getReservation(ctx, reservation.id);
    if (raced === null) {
      return { ok: false, code: "not_found", message: "credit reservation not found in this tenant" };
    }
    if (raced.status === "CONSUMED") {
      return { ok: false, code: "precondition_failed", message: "reservation is CONSUMED; spent funds cannot be released" };
    }
    const procurement = await findProcurementByReservation(ctx, raced.id);
    return { ok: true, data: { ...toPublicReservation(raced, procurement?.id ?? null), already: true } };
  }
  const procurement = await findProcurementByReservation(ctx, updated.id);
  if (procurement !== null && procurement.status === "RESERVED") {
    await updateProcurementStatusIf(ctx, procurement.id, "RESERVED", "FAILED");
  }
  return {
    ok: true,
    data: { ...toPublicReservation(updated, procurement?.id ?? null), already: false },
  };
}

async function handleExpireReservations(
  ctx: CommandHandlerContext,
  input: ExpireCreditReservationsInput,
): Promise<CommandResult<{ expiredReservationIds: string[] }>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("supplier credit commands require a database transaction");
  }
  const due = await trx
    .selectFrom("inventory.credit_reservations")
    .select(["id", "expires_at"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("status", "=", "ACTIVE")
    .where("expires_at", "is not", null)
    .where("expires_at", "<=", new Date())
    .orderBy("expires_at", "asc")
    .limit(input.limit)
    .execute();
  const expiredReservationIds: string[] = [];
  for (const candidate of due) {
    await advisoryLockReservation(trx, candidate.id);
    const reservation = await getReservation(ctx, candidate.id);
    if (reservation === null || reservation.status !== "ACTIVE") {
      continue;
    }
    if (reservation.expiresAt !== null && reservation.expiresAt.getTime() > Date.now()) {
      continue;
    }
    // Wave 7 review fix F2: same shared keys as purchase/release
    // (supplier first, reservation-scope second) + conditional
    // transition; a concurrent purchase winner yields zero rows and is
    // skipped instead of clobbered.
    await advisoryLockSupplierBalance(trx, ctx.tenantId, reservation.supplierId);
    await advisoryLockReservationScope(trx, ctx.tenantId, reservation.id);
    const expired = await updateReservationStatusIf(ctx, reservation.id, "ACTIVE", nextReservationStatus("ACTIVE", "EXPIRE"));
    if (expired === null) {
      continue;
    }
    const procurement = await findProcurementByReservation(ctx, reservation.id);
    if (procurement !== null && procurement.status === "RESERVED") {
      await updateProcurementStatusIf(ctx, procurement.id, "RESERVED", "FAILED");
    }
    expiredReservationIds.push(reservation.id);
  }
  return { ok: true, data: { expiredReservationIds } };
}

export function registerSupplierCreditCommands(bus: CommandBus, deps: SupplierCreditCommandDeps = {}): void {
  bus.register<RefreshSupplierBalanceInput, { snapshotId: string; balanceMinor: string; currency: string; evidenceRef: string }>({
    name: "inventory.refresh_supplier_balance",
    permission: "provider.operation.write",
    auditAction: "inventory.refresh_supplier_balance",
    auditResource: "supplier_balance_snapshot",
    input: refreshSupplierBalanceInput,
    handler: handleRefreshFactory(deps),
  });
  bus.register<ReserveAppCreditInput, Record<string, unknown>>({
    name: "inventory.reserve_app_credit",
    permission: "commerce.order.write",
    auditAction: "inventory.reserve_app_credit",
    auditResource: "credit_reservation",
    input: reserveAppCreditInput,
    handler: handleReserve,
  });
  bus.register<ReleaseAppCreditInput, Record<string, unknown>>({
    name: "inventory.release_app_credit",
    permission: "commerce.order.write",
    auditAction: "inventory.release_app_credit",
    auditResource: "credit_reservation",
    input: releaseAppCreditInput,
    handler: handleRelease,
  });
  bus.register<ExpireCreditReservationsInput, { expiredReservationIds: string[] }>({
    name: "inventory.expire_credit_reservations",
    permission: "commerce.order.write",
    auditAction: "inventory.expire_credit_reservations",
    auditResource: "credit_reservation",
    input: expireCreditReservationsInput,
    handler: handleExpireReservations,
  });
}
