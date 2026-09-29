import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDb } from "@iptv/database";
import { newId } from "@iptv/domain";
import {
  captureSupplierAppSnapshot,
  diffPersistedSupplierAppSnapshots,
  loadSupplierAppItems,
  loadSupplierAppSnapshot,
} from "../src/inventory/supplier-app-catalog.store.js";
import {
  diffSupplierAppCatalogs,
  normalizeIngestItems,
  type SupplierAppIngestItem,
} from "../src/inventory/supplier-app-catalog.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function app(overrides: Partial<SupplierAppIngestItem> & { externalId: string }): SupplierAppIngestItem {
  return {
    name: `App ${overrides.externalId}`,
    annualPriceMinor: "1990",
    lifetimePriceMinor: "5990",
    currency: "BRL",
    activationFlags: { trial: true },
    mediaRefs: [{ kind: "logo", ref: `img://${overrides.externalId}` }],
    availability: "AVAILABLE",
    ...overrides,
  };
}

describe.skipIf(!hasDb)("Wave 7 supplier app catalog snapshots (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });

  async function makeTenant(): Promise<string> {
    const id = newId();
    // UUIDv7 head (slice(0, 8)) is a timestamp prefix that collides for
    // same-second creations; use the random tail so rapid fixtures stay unique.
    const suffix = id.replace(/-/g, "").slice(-8);
    await db
      .insertInto("control.tenants")
      .values({
        id,
        slug: `w7-${suffix}`,
        name: "Wave7 Tenant",
        status: "ACTIVE",
        default_currency: "BRL",
        timezone: "America/Sao_Paulo",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    return id;
  }

  async function makeSupplier(tenantId: string, name: string): Promise<string> {
    const id = newId();
    await db
      .insertInto("inventory.suppliers")
      .values({
        id,
        tenant_id: tenantId,
        name,
        supplier_type: "APP_CATALOG",
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    return id;
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
  });

  afterAll(async () => {
    await db.destroy().catch(() => undefined);
  });

  it("captures idempotently: same content returns the existing snapshot without duplicates", async () => {
    const tenantId = await makeTenant();
    const supplierId = await makeSupplier(tenantId, "Wave7 Supplier");
    const items = [app({ externalId: "app-a" }), app({ externalId: "app-b" })];

    const first = await captureSupplierAppSnapshot(db, { tenantId, supplierId, items });
    expect(first.deduped).toBe(false);
    expect(first.itemCount).toBe(2);

    // Re-ingest in a different order: same canonical hash, same snapshot.
    const second = await captureSupplierAppSnapshot(db, {
      tenantId,
      supplierId,
      items: [...items].reverse(),
      captureMetadata: { source: "retry" },
    });
    expect(second.deduped).toBe(true);
    expect(second.snapshotId).toBe(first.snapshotId);

    const rows = await db
      .selectFrom("inventory.supplier_app_snapshots")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("supplier_id", "=", supplierId)
      .execute();
    expect(rows).toHaveLength(1);

    const storedItems = await loadSupplierAppItems(db, tenantId, first.snapshotId);
    expect(storedItems.map((i) => i.externalId)).toEqual(["app-a", "app-b"]);
    // JSONB round-trip: mediaRefs (top-level array) must come back as the same shape.
    expect(storedItems.find((i) => i.externalId === "app-a")?.mediaRefs).toEqual([
      { kind: "logo", ref: "img://app-a" },
    ]);
    expect(storedItems.find((i) => i.externalId === "app-b")?.activationFlags).toEqual({ trial: true });
  });

  it("generates distinct tenant slugs under rapid creation", async () => {
    const ids = [await makeTenant(), await makeTenant(), await makeTenant(), await makeTenant(), await makeTenant()];
    expect(new Set(ids).size).toBe(ids.length);
    const rows = await db
      .selectFrom("control.tenants")
      .select(["slug"])
      .where("id", "in", ids)
      .execute();
    const slugs = rows.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(ids.length);
  });

  it("stores same-name apps as distinct rows keyed by external_id", async () => {
    const tenantId = await makeTenant();
    const supplierId = await makeSupplier(tenantId, "Wave7 Same-Name Supplier");
    const captured = await captureSupplierAppSnapshot(db, {
      tenantId,
      supplierId,
      items: [app({ externalId: "ext-1", name: "Same Name" }), app({ externalId: "ext-2", name: "Same Name" })],
    });
    const stored = await loadSupplierAppItems(db, tenantId, captured.snapshotId);
    expect(stored).toHaveLength(2);
    expect(stored.map((i) => i.externalId).sort()).toEqual(["ext-1", "ext-2"]);
  });

  it("diffs two snapshots deterministically and isolates tenants", async () => {
    const tenantId = await makeTenant();
    const supplierId = await makeSupplier(tenantId, "Wave7 Diff Supplier");
    const v1 = await captureSupplierAppSnapshot(db, {
      tenantId,
      supplierId,
      items: [app({ externalId: "keep" }), app({ externalId: "gone" })],
    });
    const v2 = await captureSupplierAppSnapshot(db, {
      tenantId,
      supplierId,
      items: [app({ externalId: "keep", annualPriceMinor: "2490" }), app({ externalId: "new" })],
    });
    expect(v2.snapshotId).not.toBe(v1.snapshotId);

    const beforeHeader = await loadSupplierAppSnapshot(db, tenantId, v1.snapshotId);
    const afterHeader = await loadSupplierAppSnapshot(db, tenantId, v2.snapshotId);
    const diff = diffSupplierAppCatalogs(await loadSupplierAppItems(db, tenantId, v1.snapshotId), await loadSupplierAppItems(db, tenantId, v2.snapshotId), {
      before: { tenantId: beforeHeader.tenantId, supplierId: beforeHeader.supplierId },
      after: { tenantId: afterHeader.tenantId, supplierId: afterHeader.supplierId },
    });
    expect(diff.added.map((i) => i.externalId)).toEqual(["new"]);
    expect(diff.removed.map((i) => i.externalId)).toEqual(["gone"]);
    expect(diff.changed.map((c) => c.externalId)).toEqual(["keep"]);

    // Same payload in another tenant is a separate snapshot; headers stay invisible cross-tenant.
    const otherTenant = await makeTenant();
    const otherSupplier = await makeSupplier(otherTenant, "Wave7 Diff Supplier");
    const foreign = await captureSupplierAppSnapshot(db, {
      tenantId: otherTenant,
      supplierId: otherSupplier,
      items: [app({ externalId: "keep" }), app({ externalId: "gone" })],
    });
    expect(foreign.snapshotId).not.toBe(v1.snapshotId);
    await expect(loadSupplierAppSnapshot(db, otherTenant, v1.snapshotId)).rejects.toThrow(/not found/);
    await expect(loadSupplierAppItems(db, otherTenant, v1.snapshotId)).rejects.toThrow(/not found/);
    expect(() =>
      diffSupplierAppCatalogs(normalizeIngestItems([app({ externalId: "keep" })]), normalizeIngestItems([app({ externalId: "keep" })]), {
        before: { tenantId, supplierId },
        after: { tenantId: otherTenant, supplierId: otherSupplier },
      }),
    ).toThrow(/cross-tenant/);
  });

  it("diffs two persisted snapshots through the store read path", async () => {
    const tenantId = await makeTenant();
    const supplierId = await makeSupplier(tenantId, "Wave7 Persisted Diff Supplier");
    const v1 = await captureSupplierAppSnapshot(db, {
      tenantId,
      supplierId,
      items: [app({ externalId: "keep" }), app({ externalId: "gone" })],
    });
    const v2 = await captureSupplierAppSnapshot(db, {
      tenantId,
      supplierId,
      items: [app({ externalId: "keep", annualPriceMinor: "2490" }), app({ externalId: "new" })],
    });

    const diff = await diffPersistedSupplierAppSnapshots(db, tenantId, v1.snapshotId, v2.snapshotId);
    expect(diff.added.map((i) => i.externalId)).toEqual(["new"]);
    expect(diff.removed.map((i) => i.externalId)).toEqual(["gone"]);
    expect(diff.changed.map((c) => c.externalId)).toEqual(["keep"]);
  });

  it("rejects persisted diffs with a foreign-tenant snapshot in either position", async () => {
    const tenantId = await makeTenant();
    const supplierId = await makeSupplier(tenantId, "Wave7 Tenant-Scoped Diff Supplier");
    const local = await captureSupplierAppSnapshot(db, {
      tenantId,
      supplierId,
      items: [app({ externalId: "local" })],
    });

    const foreignTenant = await makeTenant();
    const foreignSupplier = await makeSupplier(foreignTenant, "Wave7 Foreign Diff Supplier");
    const foreign = await captureSupplierAppSnapshot(db, {
      tenantId: foreignTenant,
      supplierId: foreignSupplier,
      items: [app({ externalId: "foreign" })],
    });

    await expect(
      diffPersistedSupplierAppSnapshots(db, tenantId, foreign.snapshotId, local.snapshotId),
    ).rejects.toThrow(/not found in this tenant/);
    await expect(
      diffPersistedSupplierAppSnapshots(db, tenantId, local.snapshotId, foreign.snapshotId),
    ).rejects.toThrow(/not found in this tenant/);
  });

  it("rejects persisted diffs across suppliers in the same tenant", async () => {
    const tenantId = await makeTenant();
    const supplierA = await makeSupplier(tenantId, "Wave7 Persisted Supplier A");
    const supplierB = await makeSupplier(tenantId, "Wave7 Persisted Supplier B");
    const snapA = await captureSupplierAppSnapshot(db, {
      tenantId,
      supplierId: supplierA,
      items: [app({ externalId: "app-1" })],
    });
    const snapB = await captureSupplierAppSnapshot(db, {
      tenantId,
      supplierId: supplierB,
      items: [app({ externalId: "app-1" })],
    });

    await expect(diffPersistedSupplierAppSnapshots(db, tenantId, snapA.snapshotId, snapB.snapshotId)).rejects.toThrow(
      /cross-supplier/,
    );
  });

  it("rejects captures for suppliers outside the tenant", async () => {
    const tenantId = await makeTenant();
    const foreignTenant = await makeTenant();
    const foreignSupplier = await makeSupplier(foreignTenant, "Foreign Supplier");
    await expect(
      captureSupplierAppSnapshot(db, { tenantId, supplierId: foreignSupplier, items: [app({ externalId: "x" })] }),
    ).rejects.toThrow(/not found in this tenant/);
  });

  it("rejects items whose supplier_id does not match the snapshot supplier (same tenant)", async () => {
    const tenantId = await makeTenant();
    const supplierA = await makeSupplier(tenantId, "Supplier A");
    const supplierB = await makeSupplier(tenantId, "Supplier B");
    const captured = await captureSupplierAppSnapshot(db, {
      tenantId,
      supplierId: supplierA,
      items: [app({ externalId: "app-1" })],
    });

    // Direct SQL bypass attempt: snapshot from supplier A + supplier_id B.
    // The composite FK (tenant_id, snapshot_id, supplier_id) must reject it.
    await expect(
      db
        .insertInto("inventory.supplier_app_items")
        .values({
          id: newId(),
          tenant_id: tenantId,
          snapshot_id: captured.snapshotId,
          supplier_id: supplierB,
          external_id: "smuggled",
          name: "Smuggled App",
          annual_price_minor: "100",
          lifetime_price_minor: null,
          currency: "BRL",
          activation_flags_json: {},
          // Same node-postgres boundary as the store: top-level arrays must be
          // explicit JSON text for jsonb (a bare [] would bind as a PG array).
          media_refs_json: JSON.stringify([]) as never,
          availability: "AVAILABLE",
        })
        .execute(),
    ).rejects.toThrow(/supplier_app_items_snapshot_fk|foreign key|violates/i);
  });
});
