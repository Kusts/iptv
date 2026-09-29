import { sql, type Kysely, type Transaction } from "kysely";
import { newId, now } from "@iptv/domain";
import type { Database } from "@iptv/database";
import type { CommandHandlerContext } from "../commands/command-bus.js";
import { kyselyTrxOf } from "../crm/wave2-store.js";

/**
 * Wave 7 slice S3: LicenseAsset + reconciliation-finding repository.
 *
 * Storage rules (migration 026):
 * - `license_assets` is APPEND-ONLY (DB trigger rejects UPDATE/DELETE).
 *   The license identity is the procurement order (exactly one supplier
 *   charge per purchase, G07): the first row is PROVISIONING and every
 *   later transition (ACTIVE with activation evidence, FAILED, REVOKED)
 *   is a NEW row pointing at `prior_asset_id`. Current status is the
 *   latest row per (tenant, procurement_order). A partial unique index
 *   allows a single PROVISIONING row per procurement order, and writers
 *   take a per-procurement-order advisory lock so concurrent purchases
 *   serialize instead of double-charging.
 * - `reconciliation_findings` rows are MUTABLE resolution aggregates
 *   (OPEN -> RESOLVED with resolution_ref), exactly like
 *   billing.exceptions.
 * - Like the referral slice, commands require a database transaction —
 *   there is no in-memory path. The gate mapping is covered by unit tests
 *   over the pure procurement policy; the orchestrated flow is covered by
 *   the `TEST_DATABASE_URL` integration suite.
 */

export const LICENSE_ASSET_STATUSES = ["PROVISIONING", "ACTIVE", "FAILED", "REVOKED"] as const;
export type LicenseAssetStatus = (typeof LICENSE_ASSET_STATUSES)[number];

export async function advisoryLockLicenseScope(
  trx: Transaction<Database>,
  tenantId: string,
  procurementOrderId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${"license:" + tenantId + ":" + procurementOrderId}))`.execute(trx);
}

function requireTrx(ctx: CommandHandlerContext): Transaction<Database> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("license commands require a database transaction");
  }
  return trx;
}

export interface LicenseAssetRow {
  id: string;
  tenantId: string;
  customerId: string;
  procurementOrderId: string;
  supplierId: string;
  priorAssetId: string | null;
  externalLicenseRef: string | null;
  status: LicenseAssetStatus;
  activationEvidence: unknown;
  createdAt: Date;
}

const LICENSE_COLUMNS = [
  "id",
  "tenant_id",
  "customer_id",
  "procurement_order_id",
  "supplier_id",
  "prior_asset_id",
  "external_license_ref",
  "status",
  "activation_evidence_json",
  "created_at",
] as const;

function toLicenseRow(tenantId: string, row: {
  id: string;
  tenant_id: string;
  customer_id: string;
  procurement_order_id: string;
  supplier_id: string;
  prior_asset_id: string | null;
  external_license_ref: string | null;
  status: string;
  activation_evidence_json: unknown;
  created_at: Date;
}): LicenseAssetRow {
  return {
    id: row.id,
    tenantId,
    customerId: row.customer_id,
    procurementOrderId: row.procurement_order_id,
    supplierId: row.supplier_id,
    priorAssetId: row.prior_asset_id,
    externalLicenseRef: row.external_license_ref,
    status: row.status as LicenseAssetStatus,
    activationEvidence: row.activation_evidence_json,
    createdAt: row.created_at,
  };
}

export async function getLicenseAsset(ctx: CommandHandlerContext, assetId: string): Promise<LicenseAssetRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("inventory.license_assets")
    .select(LICENSE_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", assetId)
    .executeTakeFirst();
  return row === undefined ? null : toLicenseRow(ctx.tenantId, row);
}

/** Current status holder: latest row for the procurement order. */
export async function latestLicenseAsset(
  ctx: CommandHandlerContext,
  procurementOrderId: string,
): Promise<LicenseAssetRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("inventory.license_assets")
    .select(LICENSE_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("procurement_order_id", "=", procurementOrderId)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
  return row === undefined ? null : toLicenseRow(ctx.tenantId, row);
}

export async function insertLicenseAsset(
  ctx: CommandHandlerContext,
  input: {
    customerId: string;
    procurementOrderId: string;
    supplierId: string;
    priorAssetId: string | null;
    externalLicenseRef: string | null;
    status: LicenseAssetStatus;
    evidence: Record<string, unknown>;
  },
): Promise<LicenseAssetRow> {
  const trx = requireTrx(ctx);
  const id = newId();
  const row = await trx
    .insertInto("inventory.license_assets")
    .values({
      id,
      tenant_id: ctx.tenantId,
      customer_id: input.customerId,
      procurement_order_id: input.procurementOrderId,
      supplier_id: input.supplierId,
      prior_asset_id: input.priorAssetId,
      external_license_ref: input.externalLicenseRef,
      status: input.status,
      activation_evidence_json: input.evidence,
      created_at: now(),
    })
    .returning(LICENSE_COLUMNS)
    .executeTakeFirstOrThrow();
  return toLicenseRow(ctx.tenantId, row);
}

export interface ReconciliationFindingRow {
  id: string;
  tenantId: string;
  entityType: string;
  entityId: string;
  expected: unknown;
  observed: unknown;
  status: string;
  resolutionRef: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

const FINDING_COLUMNS = [
  "id",
  "tenant_id",
  "entity_type",
  "entity_id",
  "expected_json",
  "observed_json",
  "status",
  "resolution_ref",
  "created_at",
  "resolved_at",
] as const;

function toFindingRow(tenantId: string, row: {
  id: string;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  expected_json: unknown;
  observed_json: unknown;
  status: string;
  resolution_ref: string | null;
  created_at: Date;
  resolved_at: Date | null;
}): ReconciliationFindingRow {
  return {
    id: row.id,
    tenantId,
    entityType: row.entity_type,
    entityId: row.entity_id,
    expected: row.expected_json,
    observed: row.observed_json,
    status: row.status,
    resolutionRef: row.resolution_ref,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export async function openReconciliationFinding(
  ctx: CommandHandlerContext,
  input: { entityType: string; entityId: string; expected: Record<string, unknown>; observed: Record<string, unknown> },
): Promise<ReconciliationFindingRow> {
  const trx = requireTrx(ctx);
  const existing = await trx
    .selectFrom("inventory.reconciliation_findings")
    .select(FINDING_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("entity_type", "=", input.entityType)
    .where("entity_id", "=", input.entityId)
    .where("status", "=", "OPEN")
    .executeTakeFirst();
  if (existing !== undefined) {
    return toFindingRow(ctx.tenantId, existing);
  }
  const id = newId();
  const timestamp = now();
  const row = await trx
    .insertInto("inventory.reconciliation_findings")
    .values({
      id,
      tenant_id: ctx.tenantId,
      entity_type: input.entityType,
      entity_id: input.entityId,
      expected_json: input.expected,
      observed_json: input.observed,
      status: "OPEN",
      resolution_ref: null,
      created_at: timestamp,
      updated_at: timestamp,
      resolved_at: null,
    })
    .returning(FINDING_COLUMNS)
    .executeTakeFirstOrThrow();
  return toFindingRow(ctx.tenantId, row);
}

export async function findOpenFinding(
  ctx: CommandHandlerContext,
  entityType: string,
  entityId: string,
): Promise<ReconciliationFindingRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("inventory.reconciliation_findings")
    .select(FINDING_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("entity_type", "=", entityType)
    .where("entity_id", "=", entityId)
    .where("status", "=", "OPEN")
    .executeTakeFirst();
  return row === undefined ? null : toFindingRow(ctx.tenantId, row);
}

export async function resolveReconciliationFinding(
  ctx: CommandHandlerContext,
  findingId: string,
  input: { observed: Record<string, unknown>; resolutionRef: string },
): Promise<ReconciliationFindingRow | null> {
  const trx = requireTrx(ctx);
  const timestamp = now();
  const row = await trx
    .updateTable("inventory.reconciliation_findings")
    .set({
      observed_json: input.observed,
      status: "RESOLVED",
      resolution_ref: input.resolutionRef,
      updated_at: timestamp,
      resolved_at: timestamp,
    })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", findingId)
    .where("status", "=", "OPEN")
    .returning(FINDING_COLUMNS)
    .executeTakeFirst();
  return row === undefined ? null : toFindingRow(ctx.tenantId, row);
}

export async function listReconciliationFindings(
  db: Kysely<Database> | Transaction<Database>,
  tenantId: string,
  filters: { status?: string; limit: number },
): Promise<ReconciliationFindingRow[]> {
  let query = db
    .selectFrom("inventory.reconciliation_findings")
    .select(FINDING_COLUMNS)
    .where("tenant_id", "=", tenantId)
    .orderBy("created_at", "desc")
    .limit(filters.limit);
  if (filters.status !== undefined) {
    query = query.where("status", "=", filters.status);
  }
  const rows = await query.execute();
  return rows.map((row) => toFindingRow(tenantId, row));
}
