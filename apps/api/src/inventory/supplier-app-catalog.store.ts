/**
 * Wave 7 read-only slice: Kysely repository for supplier app-catalog snapshots.
 *
 * Tenant isolation is structural: every read/write carries `tenant_id`, the
 * supplier row is resolved inside the same tenant, and diffs refuse
 * cross-tenant / cross-supplier comparisons. No retail/commerce writes and
 * no public event emission in this slice.
 */

import { newId } from "@iptv/domain";
import type { Database } from "@iptv/database";
import type { Kysely, Transaction } from "kysely";
import {
  computeSourceHash,
  diffSupplierAppCatalogs,
  normalizeIngestItems,
  type NormalizedSupplierAppItem,
  type SupplierAppCatalogDiff,
  type SupplierAppIngestItem,
} from "./supplier-app-catalog.js";

export interface CaptureSupplierAppSnapshotInput {
  tenantId: string;
  supplierId: string;
  items: readonly SupplierAppIngestItem[];
  captureMetadata?: Record<string, unknown>;
}

export interface CapturedSupplierAppSnapshot {
  snapshotId: string;
  sourceHash: string;
  deduped: boolean;
  itemCount: number;
}

export interface StoredSupplierAppSnapshot {
  id: string;
  tenantId: string;
  supplierId: string;
  sourceHash: string;
  itemCount: number;
  captureMetadata: unknown;
  capturedAt: Date;
}

type DbOrTrx = Kysely<Database> | Transaction<Database>;

async function ensureTenantSupplier(db: DbOrTrx, tenantId: string, supplierId: string): Promise<void> {
  const row = await db
    .selectFrom("inventory.suppliers")
    .select(["id"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", supplierId)
    .executeTakeFirst();
  if (row === undefined) {
    throw new Error("supplier not found in this tenant");
  }
}

/**
 * Idempotent capture keyed by (tenant_id, supplier_id, source_hash): the
 * same content re-ingested returns the existing snapshot without inserting
 * duplicate rows.
 */
export async function captureSupplierAppSnapshot(
  db: Kysely<Database>,
  input: CaptureSupplierAppSnapshotInput,
): Promise<CapturedSupplierAppSnapshot> {
  const normalized = normalizeIngestItems(input.items);
  const sourceHash = computeSourceHash(normalized);

  return db.transaction().execute(async (trx) => {
    await ensureTenantSupplier(trx, input.tenantId, input.supplierId);

    const existing = await trx
      .selectFrom("inventory.supplier_app_snapshots")
      .select(["id", "item_count"])
      .where("tenant_id", "=", input.tenantId)
      .where("supplier_id", "=", input.supplierId)
      .where("source_hash", "=", sourceHash)
      .executeTakeFirst();
    if (existing !== undefined) {
      return {
        snapshotId: existing.id,
        sourceHash,
        deduped: true,
        itemCount: existing.item_count,
      };
    }

    const snapshotId = newId();
    const capturedAt = new Date();
    await trx
      .insertInto("inventory.supplier_app_snapshots")
      .values({
        id: snapshotId,
        tenant_id: input.tenantId,
        supplier_id: input.supplierId,
        source_hash: sourceHash,
        item_count: normalized.length,
        capture_metadata_json: (input.captureMetadata ?? {}) as never,
        captured_at: capturedAt,
      })
      .onConflict((oc) => oc.columns(["tenant_id", "supplier_id", "source_hash"]).doNothing())
      .execute();

    const raced = await trx
      .selectFrom("inventory.supplier_app_snapshots")
      .select(["id", "item_count"])
      .where("tenant_id", "=", input.tenantId)
      .where("supplier_id", "=", input.supplierId)
      .where("source_hash", "=", sourceHash)
      .executeTakeFirstOrThrow();

    if (raced.id !== snapshotId) {
      return { snapshotId: raced.id, sourceHash, deduped: true, itemCount: raced.item_count };
    }

    for (const item of normalized) {
      await trx
        .insertInto("inventory.supplier_app_items")
        .values({
          id: newId(),
          tenant_id: input.tenantId,
          snapshot_id: snapshotId,
          supplier_id: input.supplierId,
          external_id: item.externalId,
          name: item.name,
          annual_price_minor: item.annualPriceMinor,
          lifetime_price_minor: item.lifetimePriceMinor,
          currency: item.currency,
          activation_flags_json: item.activationFlags as never,
          // node-postgres serializes top-level JS arrays as Postgres array
          // literals (invalid for jsonb); ordinary objects are JSON-stringified
          // automatically. Explicitly serialize mediaRefs (canonically an array)
          // so the jsonb column always receives valid JSON text. Readback via
          // node-pg JSON parsing restores the same array shape used for hashing.
          media_refs_json: JSON.stringify(item.mediaRefs) as never,
          availability: item.availability,
        })
        .execute();
    }

    return { snapshotId, sourceHash, deduped: false, itemCount: normalized.length };
  });
}

export async function loadSupplierAppSnapshot(
  db: DbOrTrx,
  tenantId: string,
  snapshotId: string,
): Promise<StoredSupplierAppSnapshot> {
  const row = await db
    .selectFrom("inventory.supplier_app_snapshots")
    .select(["id", "tenant_id", "supplier_id", "source_hash", "item_count", "capture_metadata_json", "captured_at"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", snapshotId)
    .executeTakeFirst();
  if (row === undefined) {
    throw new Error("supplier app snapshot not found in this tenant");
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    supplierId: row.supplier_id,
    sourceHash: row.source_hash,
    itemCount: row.item_count,
    captureMetadata: row.capture_metadata_json,
    capturedAt: row.captured_at,
  };
}

export async function loadSupplierAppItems(
  db: DbOrTrx,
  tenantId: string,
  snapshotId: string,
): Promise<NormalizedSupplierAppItem[]> {
  // Tenant-scoped through the snapshot header: a foreign tenant id never
  // resolves the header row above, so items stay invisible.
  await loadSupplierAppSnapshot(db, tenantId, snapshotId);
  const rows = await db
    .selectFrom("inventory.supplier_app_items")
    .select([
      "external_id",
      "name",
      "annual_price_minor",
      "lifetime_price_minor",
      "currency",
      "activation_flags_json",
      "media_refs_json",
      "availability",
    ])
    .where("tenant_id", "=", tenantId)
    .where("snapshot_id", "=", snapshotId)
    .orderBy("external_id", "asc")
    .execute();
  return rows.map((row) => ({
    externalId: row.external_id,
    name: row.name,
    annualPriceMinor: row.annual_price_minor,
    lifetimePriceMinor: row.lifetime_price_minor,
    currency: row.currency,
    activationFlags: (row.activation_flags_json ?? {}) as Record<string, unknown>,
    mediaRefs: (row.media_refs_json ?? []) as unknown,
    availability: row.availability as NormalizedSupplierAppItem["availability"],
  }));
}

/**
 * Read-only persisted diff between two immutable snapshots of the same
 * supplier in the same tenant.
 *
 * Both headers resolve under `tenantId` via `loadSupplierAppSnapshot`, so a
 * missing id or a snapshot owned by another tenant fails closed with
 * "not found in this tenant". Snapshots from different suppliers — even in
 * the same tenant — are rejected; unrelated catalogs are never compared.
 * Delegates item comparison to the pure `diffSupplierAppCatalogs` (keyed by
 * `external_id`) and never mutates snapshots.
 */
export async function diffPersistedSupplierAppSnapshots(
  db: DbOrTrx,
  tenantId: string,
  beforeSnapshotId: string,
  afterSnapshotId: string,
): Promise<SupplierAppCatalogDiff> {
  const beforeHeader = await loadSupplierAppSnapshot(db, tenantId, beforeSnapshotId);
  const afterHeader = await loadSupplierAppSnapshot(db, tenantId, afterSnapshotId);
  const beforeItems = await loadSupplierAppItems(db, tenantId, beforeSnapshotId);
  const afterItems = await loadSupplierAppItems(db, tenantId, afterSnapshotId);
  return diffSupplierAppCatalogs(beforeItems, afterItems, {
    before: { tenantId: beforeHeader.tenantId, supplierId: beforeHeader.supplierId },
    after: { tenantId: afterHeader.tenantId, supplierId: afterHeader.supplierId },
  });
}
