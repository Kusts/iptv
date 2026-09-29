import { sql, type Kysely, type Transaction } from "kysely";
import { newId, now } from "@iptv/domain";
import type { Database } from "@iptv/database";
import type { CommandHandlerContext } from "../commands/command-bus.js";
import { kyselyTrxOf } from "../crm/wave2-store.js";
import { UniqueViolationError } from "../trial/trial-store.js";

/**
 * Wave 7 slice S1: AppTrial lifecycle repository (Kysely only).
 *
 * An AppTrial is the trial-before-purchase proof for one supplier app:
 * REQUESTED -> VALIDATED (customer confirmed the free test) with ACTIVE
 * reserved for future supplier-side provisioning (real MK/Browser Worker
 * adapter, out of scope — only ports/fakes ship here), EXPIRED swept past
 * `expires_at`, INVALIDATED when the customer rejects the test.
 *
 * Storage rules (migration 024):
 * - One open trial per (tenant, person, supplier): partial unique index
 *   WHERE status IN ('REQUESTED','ACTIVE'). Writers pre-check + take a
 *   per-(tenant, person, supplier) advisory lock so concurrent requests
 *   serialize instead of racing the index (same discipline as the
 *   referral first-touch lock).
 * - The trial row is the MUTABLE lifecycle aggregate (no append-only
 *   trigger): transitions are status updates with timestamp side-effects.
 * - Every relationship is tenant-aware (person/customer/supplier); cross-
 *   tenant and cross-customer mixes fail closed.
 * - Like the referral slice, commands require a database transaction —
 *   there is no in-memory path. Units run against the pure
 *   `nextAppTrialStatus` transition table; the full flow is covered by the
 *   `TEST_DATABASE_URL` integration suite.
 */

export const APP_TRIAL_STATUSES = ["REQUESTED", "ACTIVE", "VALIDATED", "EXPIRED", "INVALIDATED"] as const;
export type AppTrialStatus = (typeof APP_TRIAL_STATUSES)[number];

export const OPEN_APP_TRIAL_STATUSES: readonly AppTrialStatus[] = ["REQUESTED", "ACTIVE"];

export type AppTrialTransition = "ACTIVATE" | "VALIDATE" | "INVALIDATE" | "EXPIRE";

const TRANSITIONS: Record<AppTrialStatus, Partial<Record<AppTrialTransition, AppTrialStatus>>> = {
  REQUESTED: { ACTIVATE: "ACTIVE", VALIDATE: "VALIDATED", INVALIDATE: "INVALIDATED", EXPIRE: "EXPIRED" },
  ACTIVE: { VALIDATE: "VALIDATED", INVALIDATE: "INVALIDATED", EXPIRE: "EXPIRED" },
  VALIDATED: {},
  EXPIRED: {},
  INVALIDATED: {},
};

/**
 * Pure lifecycle transition table (no I/O). Throws on any invalid
 * (status, transition) pair so callers fail closed with a stable message.
 */
export function nextAppTrialStatus(current: AppTrialStatus, transition: AppTrialTransition): AppTrialStatus {
  const next = TRANSITIONS[current]?.[transition];
  if (next === undefined) {
    throw new Error(`invalid app trial transition ${transition} from ${current}`);
  }
  return next;
}

function requireTrx(ctx: CommandHandlerContext): Transaction<Database> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("app trial commands require a database transaction");
  }
  return trx;
}

export async function advisoryLockAppTrialScope(
  trx: Transaction<Database>,
  tenantId: string,
  personId: string,
  supplierId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${"app-trial:" + tenantId + ":" + personId + ":" + supplierId}))`.execute(
    trx,
  );
}

export async function advisoryLockAppTrial(trx: Transaction<Database>, trialId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${"app-trial:" + trialId}))`.execute(trx);
}

export interface AppTrialRow {
  id: string;
  tenantId: string;
  personId: string;
  customerId: string | null;
  supplierId: string;
  supplierAppExternalId: string;
  status: AppTrialStatus;
  requestedAt: Date;
  activatedAt: Date | null;
  validatedAt: Date | null;
  expiresAt: Date | null;
  invalidatedReason: string | null;
}

const APP_TRIAL_COLUMNS = [
  "id",
  "tenant_id",
  "person_id",
  "customer_id",
  "supplier_id",
  "supplier_app_external_id",
  "status",
  "requested_at",
  "activated_at",
  "validated_at",
  "expires_at",
  "invalidated_reason",
] as const;

function toRow(tenantId: string, row: {
  id: string;
  tenant_id: string;
  person_id: string;
  customer_id: string | null;
  supplier_id: string;
  supplier_app_external_id: string;
  status: string;
  requested_at: Date;
  activated_at: Date | null;
  validated_at: Date | null;
  expires_at: Date | null;
  invalidated_reason: string | null;
}): AppTrialRow {
  return {
    id: row.id,
    tenantId,
    personId: row.person_id,
    customerId: row.customer_id,
    supplierId: row.supplier_id,
    supplierAppExternalId: row.supplier_app_external_id,
    status: row.status as AppTrialStatus,
    requestedAt: row.requested_at,
    activatedAt: row.activated_at,
    validatedAt: row.validated_at,
    expiresAt: row.expires_at,
    invalidatedReason: row.invalidated_reason,
  };
}

export async function getAppTrial(ctx: CommandHandlerContext, trialId: string): Promise<AppTrialRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("inventory.app_trials")
    .select(APP_TRIAL_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", trialId)
    .executeTakeFirst();
  return row === undefined ? null : toRow(ctx.tenantId, row);
}

export async function findOpenAppTrial(
  ctx: CommandHandlerContext,
  personId: string,
  supplierId: string,
): Promise<AppTrialRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("inventory.app_trials")
    .select(APP_TRIAL_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("person_id", "=", personId)
    .where("supplier_id", "=", supplierId)
    .where("status", "in", [...OPEN_APP_TRIAL_STATUSES])
    .executeTakeFirst();
  return row === undefined ? null : toRow(ctx.tenantId, row);
}

export async function insertAppTrial(
  ctx: CommandHandlerContext,
  input: {
    personId: string;
    customerId: string | null;
    supplierId: string;
    supplierAppExternalId: string;
    expiresAt: Date | null;
  },
): Promise<AppTrialRow> {
  const trx = requireTrx(ctx);
  const id = newId();
  const timestamp = now();
  try {
    const row = await trx
      .insertInto("inventory.app_trials")
      .values({
        id,
        tenant_id: ctx.tenantId,
        person_id: input.personId,
        customer_id: input.customerId,
        supplier_id: input.supplierId,
        supplier_app_external_id: input.supplierAppExternalId,
        status: "REQUESTED",
        requested_at: timestamp,
        activated_at: null,
        validated_at: null,
        expires_at: input.expiresAt,
        invalidated_reason: null,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .returning(APP_TRIAL_COLUMNS)
      .executeTakeFirstOrThrow();
    return toRow(ctx.tenantId, row);
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      throw new UniqueViolationError("an open app trial already exists for this person and supplier");
    }
    throw err;
  }
}

export async function updateAppTrial(
  ctx: CommandHandlerContext,
  trialId: string,
  patch: { status: AppTrialStatus; invalidatedReason?: string | null },
): Promise<AppTrialRow | null> {
  const trx = requireTrx(ctx);
  const timestamp = now();
  const row = await trx
    .updateTable("inventory.app_trials")
    .set({
      status: patch.status,
      ...(patch.status === "ACTIVE" ? { activated_at: timestamp } : {}),
      ...(patch.status === "VALIDATED" ? { validated_at: timestamp } : {}),
      ...(patch.status === "INVALIDATED" ? { invalidated_reason: patch.invalidatedReason ?? null } : {}),
      updated_at: timestamp,
    })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", trialId)
    .returning(APP_TRIAL_COLUMNS)
    .executeTakeFirst();
  return row === undefined ? null : toRow(ctx.tenantId, row);
}

export async function listAppTrials(
  db: Kysely<Database> | Transaction<Database>,
  tenantId: string,
  filters: { personId?: string; supplierId?: string; status?: string; limit: number },
): Promise<AppTrialRow[]> {
  let query = db
    .selectFrom("inventory.app_trials")
    .select(APP_TRIAL_COLUMNS)
    .where("tenant_id", "=", tenantId)
    .orderBy("requested_at", "desc")
    .limit(filters.limit);
  if (filters.personId !== undefined) {
    query = query.where("person_id", "=", filters.personId);
  }
  if (filters.supplierId !== undefined) {
    query = query.where("supplier_id", "=", filters.supplierId);
  }
  if (filters.status !== undefined) {
    query = query.where("status", "=", filters.status);
  }
  const rows = await query.execute();
  return rows.map((row) => toRow(tenantId, row));
}

/** Due open trials (expires_at past) for the expiry sweep, oldest first. */
export async function findDueAppTrials(
  trx: Transaction<Database>,
  tenantId: string,
  limit: number,
): Promise<Array<{ id: string }>> {
  return trx
    .selectFrom("inventory.app_trials")
    .select(["id"])
    .where("tenant_id", "=", tenantId)
    .where("status", "in", [...OPEN_APP_TRIAL_STATUSES])
    .where("expires_at", "is not", null)
    .where("expires_at", "<=", now())
    .orderBy("expires_at", "asc")
    .limit(limit)
    .execute();
}
