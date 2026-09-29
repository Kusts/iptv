import { sql, type Transaction } from "kysely";
import { newId, now } from "@iptv/domain";
import type { Database } from "@iptv/database";
import type { CommandHandlerContext } from "../commands/command-bus.js";
import { kyselyTrxOf } from "../crm/wave2-store.js";
import { UniqueViolationError } from "../trial/trial-store.js";

/**
 * Wave 7 slice S2: supplier-balance + credit-reservation repository.
 *
 * Money discipline: every minor-unit value is an exact decimal string
 * (`bigint` at the boundary, never float). The available pool is always
 * `latest_snapshot_balance - SUM(ACTIVE reservation totals)` computed
 * inside one transaction under a per-(tenant, supplier) advisory lock, so
 * concurrent reserves serialize and can never double-spend (same lock
 * discipline as the referral first-touch path).
 *
 * Storage rules (migration 025):
 * - `supplier_balance_snapshots` is append-only (DB trigger rejects
 *   UPDATE/DELETE): readings accumulate, the latest wins.
 * - `credit_reservations` + `procurement_orders` are MUTABLE lifecycle
 *   aggregates (status updates under the supplier lock).
 * - Like the referral slice, commands require a database transaction —
 *   there is no in-memory path. Units run against the pure
 *   `computeAvailablePool` / `nextReservationStatus` helpers; the atomic
 *   flow is covered by the `TEST_DATABASE_URL` integration suite.
 */

export const RESERVATION_STATUSES = ["ACTIVE", "CONSUMED", "RELEASED", "EXPIRED"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

type ReservationTransition = "CONSUME" | "RELEASE" | "EXPIRE";

const RESERVATION_TRANSITIONS: Record<ReservationStatus, Partial<Record<ReservationTransition, ReservationStatus>>> = {
  ACTIVE: { CONSUME: "CONSUMED", RELEASE: "RELEASED", EXPIRE: "EXPIRED" },
  CONSUMED: {},
  RELEASED: {},
  EXPIRED: {},
};

/** Pure reservation transition table (no I/O); throws on invalid pairs. */
export function nextReservationStatus(current: ReservationStatus, transition: ReservationTransition): ReservationStatus {
  const next = RESERVATION_TRANSITIONS[current]?.[transition];
  if (next === undefined) {
    throw new Error(`invalid credit reservation transition ${transition} from ${current}`);
  }
  return next;
}

/** PostgreSQL signed BIGINT max: minor-unit values above this cannot persist. */
const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;

/** Exact pool math on decimal strings; throws on malformed input. */
export function computeAvailablePool(balanceMinor: string, activeReservedMinor: string): string {
  if (!/^\d+$/.test(balanceMinor) || !/^\d+$/.test(activeReservedMinor)) {
    throw new Error("pool inputs must be non-negative integer minor-unit strings");
  }
  const balance = BigInt(balanceMinor);
  const reserved = BigInt(activeReservedMinor);
  if (balance > PG_BIGINT_MAX) {
    throw new Error("supplier balance exceeds PostgreSQL BIGINT range");
  }
  return (balance >= reserved ? balance - reserved : 0n).toString();
}

/** Parse an exact minor-unit amount (strictly positive); null when unknown. */
export function parsePositiveMinor(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = value.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error("amount must be a non-negative integer minor-unit value");
  }
  const parsed = BigInt(text);
  if (parsed <= 0n || parsed > PG_BIGINT_MAX) {
    throw new Error("amount must be strictly positive and within PostgreSQL BIGINT range");
  }
  return parsed;
}

function requireTrx(ctx: CommandHandlerContext): Transaction<Database> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("supplier credit commands require a database transaction");
  }
  return trx;
}

export async function advisoryLockSupplierBalance(
  trx: Transaction<Database>,
  tenantId: string,
  supplierId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${"supplier-balance:" + tenantId + ":" + supplierId}))`.execute(trx);
}

export async function advisoryLockReservation(trx: Transaction<Database>, reservationId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${"credit-reservation:" + reservationId}))`.execute(trx);
}

/**
 * Wave 7 review fix F2: tenant-scoped reservation lock shared by purchase
 * (consume), release and expire. All three acquire the supplier-balance
 * lock FIRST and this lock SECOND, so purchase vs release/expire of the
 * same reservation always serialize on the same key (no lock-order cycle).
 */
export async function advisoryLockReservationScope(
  trx: Transaction<Database>,
  tenantId: string,
  reservationId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${"credit-reservation-scope:" + tenantId + ":" + reservationId}))`.execute(trx);
}

export async function advisoryLockProcurementOrder(trx: Transaction<Database>, orderId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${"procurement-order:" + orderId}))`.execute(trx);
}

export interface BalanceSnapshotRow {
  id: string;
  tenantId: string;
  supplierId: string;
  balanceMinor: string;
  currency: string;
  observedAt: Date;
  evidenceRef: string;
}

export async function insertBalanceSnapshot(
  ctx: CommandHandlerContext,
  input: { supplierId: string; balanceMinor: string; currency: string; observedAt: Date; evidenceRef: string },
): Promise<BalanceSnapshotRow> {
  const trx = requireTrx(ctx);
  const id = newId();
  await trx
    .insertInto("inventory.supplier_balance_snapshots")
    .values({
      id,
      tenant_id: ctx.tenantId,
      supplier_id: input.supplierId,
      balance_minor: input.balanceMinor,
      currency: input.currency,
      observed_at: input.observedAt,
      evidence_ref: input.evidenceRef,
      created_at: now(),
    })
    .execute();
  return {
    id,
    tenantId: ctx.tenantId,
    supplierId: input.supplierId,
    balanceMinor: input.balanceMinor,
    currency: input.currency,
    observedAt: input.observedAt,
    evidenceRef: input.evidenceRef,
  };
}

export async function latestBalanceSnapshot(
  ctx: CommandHandlerContext,
  supplierId: string,
): Promise<BalanceSnapshotRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("inventory.supplier_balance_snapshots")
    .select(["id", "supplier_id", "balance_minor", "currency", "observed_at", "evidence_ref"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("supplier_id", "=", supplierId)
    .orderBy("observed_at", "desc")
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return row === undefined
    ? null
    : {
        id: row.id,
        tenantId: ctx.tenantId,
        supplierId: row.supplier_id,
        balanceMinor: String(row.balance_minor),
        currency: row.currency,
        observedAt: row.observed_at,
        evidenceRef: row.evidence_ref,
      };
}

/** Exact SUM(total_minor) over ACTIVE reservations (decimal string, "0" when none). */
export async function sumActiveReservations(
  ctx: CommandHandlerContext,
  supplierId: string,
): Promise<string> {
  const trx = requireTrx(ctx);
  const result = await sql<{ total: string | null }>`
    SELECT COALESCE(SUM(total_minor), 0)::text AS total
    FROM inventory.credit_reservations
    WHERE tenant_id = ${ctx.tenantId}::uuid
      AND supplier_id = ${supplierId}::uuid
      AND status = 'ACTIVE'`.execute(trx);
  return result.rows[0]?.total ?? "0";
}

export interface CreditReservationRow {
  id: string;
  tenantId: string;
  supplierId: string;
  totalMinor: string;
  reservedMinor: string;
  availableMinor: string;
  currency: string;
  status: ReservationStatus;
  idempotencyKey: string;
  expiresAt: Date | null;
}

const RESERVATION_COLUMNS = [
  "id",
  "tenant_id",
  "supplier_id",
  "total_minor",
  "reserved_minor",
  "available_minor",
  "currency",
  "status",
  "idempotency_key",
  "expires_at",
] as const;

function toReservationRow(tenantId: string, row: {
  id: string;
  tenant_id: string;
  supplier_id: string;
  total_minor: string | number | bigint;
  reserved_minor: string | number | bigint;
  available_minor: string | number | bigint;
  currency: string;
  status: string;
  idempotency_key: string;
  expires_at: Date | null;
}): CreditReservationRow {
  return {
    id: row.id,
    tenantId,
    supplierId: row.supplier_id,
    totalMinor: String(row.total_minor),
    reservedMinor: String(row.reserved_minor),
    availableMinor: String(row.available_minor),
    currency: row.currency,
    status: row.status as ReservationStatus,
    idempotencyKey: row.idempotency_key,
    expiresAt: row.expires_at,
  };
}

export async function findReservationByKey(
  ctx: CommandHandlerContext,
  supplierId: string,
  idempotencyKey: string,
): Promise<CreditReservationRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("inventory.credit_reservations")
    .select(RESERVATION_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("supplier_id", "=", supplierId)
    .where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirst();
  return row === undefined ? null : toReservationRow(ctx.tenantId, row);
}

export async function getReservation(ctx: CommandHandlerContext, reservationId: string): Promise<CreditReservationRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("inventory.credit_reservations")
    .select(RESERVATION_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", reservationId)
    .executeTakeFirst();
  return row === undefined ? null : toReservationRow(ctx.tenantId, row);
}

export async function insertReservation(
  ctx: CommandHandlerContext,
  input: { supplierId: string; amountMinor: string; currency: string; idempotencyKey: string; expiresAt: Date | null },
): Promise<CreditReservationRow> {
  const trx = requireTrx(ctx);
  const id = newId();
  const timestamp = now();
  try {
    const row = await trx
      .insertInto("inventory.credit_reservations")
      .values({
        id,
        tenant_id: ctx.tenantId,
        supplier_id: input.supplierId,
        total_minor: input.amountMinor,
        reserved_minor: input.amountMinor,
        available_minor: input.amountMinor,
        currency: input.currency,
        status: "ACTIVE",
        idempotency_key: input.idempotencyKey,
        expires_at: input.expiresAt,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .returning(RESERVATION_COLUMNS)
      .executeTakeFirstOrThrow();
    return toReservationRow(ctx.tenantId, row);
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      throw new UniqueViolationError("credit reservation idempotency key already used");
    }
    throw err;
  }
}

export async function updateReservationStatus(
  ctx: CommandHandlerContext,
  reservationId: string,
  status: ReservationStatus,
): Promise<CreditReservationRow | null> {
  const trx = requireTrx(ctx);
  const terminal = status !== "ACTIVE";
  const row = await trx
    .updateTable("inventory.credit_reservations")
    .set({
      status,
      ...(terminal ? { reserved_minor: "0", available_minor: "0" } : {}),
      updated_at: now(),
    })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", reservationId)
    .returning(RESERVATION_COLUMNS)
    .executeTakeFirst();
  return row === undefined ? null : toReservationRow(ctx.tenantId, row);
}

/**
 * Wave 7 review fix F2: conditional lifecycle transition. The UPDATE only
 * matches when the row still holds `expectedStatus`; a concurrent
 * purchase/release/expire winner leaves zero affected rows for the loser
 * (null return), so the loser re-reads instead of overwriting a terminal
 * state. Terminal transitions zero the held amounts atomically.
 */
export async function updateReservationStatusIf(
  ctx: CommandHandlerContext,
  reservationId: string,
  expectedStatus: ReservationStatus,
  nextStatus: ReservationStatus,
): Promise<CreditReservationRow | null> {
  const trx = requireTrx(ctx);
  const terminal = nextStatus !== "ACTIVE";
  const row = await trx
    .updateTable("inventory.credit_reservations")
    .set({
      status: nextStatus,
      ...(terminal ? { reserved_minor: "0", available_minor: "0" } : {}),
      updated_at: now(),
    })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", reservationId)
    .where("status", "=", expectedStatus)
    .returning(RESERVATION_COLUMNS)
    .executeTakeFirst();
  return row === undefined ? null : toReservationRow(ctx.tenantId, row);
}

export interface ProcurementOrderRow {
  id: string;
  tenantId: string;
  supplierId: string;
  commerceOrderId: string;
  appTrialId: string;
  creditReservationId: string | null;
  status: string;
  totalCostMinor: string;
  currency: string;
}

const PROCUREMENT_COLUMNS = [
  "id",
  "tenant_id",
  "supplier_id",
  "commerce_order_id",
  "app_trial_id",
  "credit_reservation_id",
  "status",
  "total_cost_minor",
  "currency",
] as const;

function toProcurementRow(tenantId: string, row: {
  id: string;
  tenant_id: string;
  supplier_id: string;
  commerce_order_id: string;
  app_trial_id: string;
  credit_reservation_id: string | null;
  status: string;
  total_cost_minor: string | number | bigint;
  currency: string;
}): ProcurementOrderRow {
  return {
    id: row.id,
    tenantId,
    supplierId: row.supplier_id,
    commerceOrderId: row.commerce_order_id,
    appTrialId: row.app_trial_id,
    creditReservationId: row.credit_reservation_id,
    status: row.status,
    totalCostMinor: String(row.total_cost_minor),
    currency: row.currency,
  };
}

export async function insertProcurementOrder(
  ctx: CommandHandlerContext,
  input: {
    supplierId: string;
    commerceOrderId: string;
    appTrialId: string;
    creditReservationId: string;
    totalCostMinor: string;
    currency: string;
    status: string;
  },
): Promise<ProcurementOrderRow> {
  const trx = requireTrx(ctx);
  const id = newId();
  const timestamp = now();
  try {
    const row = await trx
      .insertInto("inventory.procurement_orders")
      .values({
        id,
        tenant_id: ctx.tenantId,
        supplier_id: input.supplierId,
        commerce_order_id: input.commerceOrderId,
        app_trial_id: input.appTrialId,
        credit_reservation_id: input.creditReservationId,
        status: input.status,
        total_cost_minor: input.totalCostMinor,
        currency: input.currency,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .returning(PROCUREMENT_COLUMNS)
      .executeTakeFirstOrThrow();
    return toProcurementRow(ctx.tenantId, row);
  } catch (err) {
    // Wave 7 review fix F5: a concurrent reserve for the same commerce
    // order / app trial (migration 027 identity indexes) surfaces here;
    // the caller treats it as an idempotent conflict, never a 2nd charge.
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      throw new UniqueViolationError("procurement order identity already reserved");
    }
    throw err;
  }
}

export async function getProcurementOrder(
  ctx: CommandHandlerContext,
  orderId: string,
): Promise<ProcurementOrderRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("inventory.procurement_orders")
    .select(PROCUREMENT_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", orderId)
    .executeTakeFirst();
  return row === undefined ? null : toProcurementRow(ctx.tenantId, row);
}

export async function findProcurementByReservation(
  ctx: CommandHandlerContext,
  reservationId: string,
): Promise<ProcurementOrderRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("inventory.procurement_orders")
    .select(PROCUREMENT_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("credit_reservation_id", "=", reservationId)
    .executeTakeFirst();
  return row === undefined ? null : toProcurementRow(ctx.tenantId, row);
}

/** Wave 7 review fix F5: purchase-identity lookups (migration 027). */
export async function findProcurementByCommerceOrder(
  ctx: CommandHandlerContext,
  commerceOrderId: string,
): Promise<ProcurementOrderRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("inventory.procurement_orders")
    .select(PROCUREMENT_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("commerce_order_id", "=", commerceOrderId)
    .where("status", "<>", "FAILED")
    .executeTakeFirst();
  return row === undefined ? null : toProcurementRow(ctx.tenantId, row);
}

/** Wave 7 review fix F5: purchase-identity lookups (migration 027). */
export async function findProcurementByTrial(
  ctx: CommandHandlerContext,
  appTrialId: string,
): Promise<ProcurementOrderRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("inventory.procurement_orders")
    .select(PROCUREMENT_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("app_trial_id", "=", appTrialId)
    .where("status", "<>", "FAILED")
    .executeTakeFirst();
  return row === undefined ? null : toProcurementRow(ctx.tenantId, row);
}

export async function updateProcurementStatus(
  ctx: CommandHandlerContext,
  orderId: string,
  status: string,
): Promise<ProcurementOrderRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .updateTable("inventory.procurement_orders")
    .set({ status, updated_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", orderId)
    .returning(PROCUREMENT_COLUMNS)
    .executeTakeFirst();
  return row === undefined ? null : toProcurementRow(ctx.tenantId, row);
}

/**
 * Wave 7 review fixes F2/F4: conditional procurement transition. Only the
 * holder of the expected prior status moves the row; a raced loser gets
 * null and re-reads instead of overwriting (e.g. RESERVED -> PURCHASED
 * must not clobber a concurrent FAILED, and vice-versa).
 */
export async function updateProcurementStatusIf(
  ctx: CommandHandlerContext,
  orderId: string,
  expectedStatus: string,
  nextStatus: string,
): Promise<ProcurementOrderRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .updateTable("inventory.procurement_orders")
    .set({ status: nextStatus, updated_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", orderId)
    .where("status", "=", expectedStatus)
    .returning(PROCUREMENT_COLUMNS)
    .executeTakeFirst();
  return row === undefined ? null : toProcurementRow(ctx.tenantId, row);
}
