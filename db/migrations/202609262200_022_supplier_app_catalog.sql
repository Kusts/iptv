-- AI Revenue & Operations Platform
-- Migration 022: Supplier app-catalog snapshots + items (Wave 7 read-only slice)
--
-- Justification (only the genuinely missing read-only pieces; no retail,
-- commerce, fulfillment or event-catalog changes):
-- - `inventory.supplier_app_snapshots`: versioned capture header per
--   tenant+supplier, idempotent on `(tenant_id, supplier_id, source_hash)`.
--   Stores item count + capture metadata only (no integral blob); history is
--   append-only, never updated in place.
-- - `inventory.supplier_app_items`: one row per supplier app per snapshot,
--   keyed by `(tenant_id, snapshot_id, external_id)` so two apps with the
--   same display name never collide. Prices are integer minor units with an
--   explicit currency per row (no hidden default); activation flags, media
--   refs and availability travel as data for deterministic diffs.
-- - Tenant isolation follows `inventory.suppliers`: every FK carries
--   `(tenant_id, ...)` and every row carries the `(tenant_id, id)` unique
--   guard used across the codebase. Items additionally carry a composite FK
--   `(tenant_id, snapshot_id, supplier_id)` against the snapshot header
--   `(tenant_id, id, supplier_id)`, so an item can never mix a snapshot from
--   one supplier with another supplier_id from the same tenant.
--   No change to catalog/commerce tables,
--   no public event, no HTTP read path in this slice.

BEGIN;

CREATE TABLE inventory.supplier_app_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    supplier_id uuid NOT NULL,
    source_hash text NOT NULL,
    item_count integer NOT NULL,
    capture_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    captured_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT supplier_app_snapshots_supplier_fk FOREIGN KEY (tenant_id, supplier_id)
        REFERENCES inventory.suppliers (tenant_id, id),
    CONSTRAINT supplier_app_snapshots_hash_not_blank CHECK (btrim(source_hash) <> ''),
    CONSTRAINT supplier_app_snapshots_item_count_check CHECK (item_count >= 0),
    CONSTRAINT supplier_app_snapshots_idempotent UNIQUE (tenant_id, supplier_id, source_hash),
    CONSTRAINT supplier_app_snapshots_tenant_id_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT supplier_app_snapshots_tenant_id_id_supplier_unique UNIQUE (tenant_id, id, supplier_id)
);

CREATE INDEX supplier_app_snapshots_supplier_idx
    ON inventory.supplier_app_snapshots (tenant_id, supplier_id, captured_at DESC);

CREATE TABLE inventory.supplier_app_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    external_id text NOT NULL,
    name text NOT NULL,
    annual_price_minor bigint,
    lifetime_price_minor bigint,
    currency char(3) NOT NULL,
    activation_flags_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    media_refs_json jsonb NOT NULL DEFAULT '[]'::jsonb,
    availability text NOT NULL DEFAULT 'UNKNOWN',
    CONSTRAINT supplier_app_items_snapshot_fk FOREIGN KEY (tenant_id, snapshot_id, supplier_id)
        REFERENCES inventory.supplier_app_snapshots (tenant_id, id, supplier_id),
    CONSTRAINT supplier_app_items_supplier_fk FOREIGN KEY (tenant_id, supplier_id)
        REFERENCES inventory.suppliers (tenant_id, id),
    CONSTRAINT supplier_app_items_external_not_blank CHECK (btrim(external_id) <> ''),
    CONSTRAINT supplier_app_items_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT supplier_app_items_annual_nonnegative CHECK (annual_price_minor IS NULL OR annual_price_minor >= 0),
    CONSTRAINT supplier_app_items_lifetime_nonnegative CHECK (lifetime_price_minor IS NULL OR lifetime_price_minor >= 0),
    CONSTRAINT supplier_app_items_availability_check CHECK (availability IN ('AVAILABLE','LIMITED','UNAVAILABLE','UNKNOWN')),
    CONSTRAINT supplier_app_items_identity_unique UNIQUE (tenant_id, snapshot_id, external_id),
    CONSTRAINT supplier_app_items_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX supplier_app_items_snapshot_idx
    ON inventory.supplier_app_items (tenant_id, snapshot_id, external_id);

CREATE TRIGGER supplier_app_snapshots_append_only
BEFORE UPDATE OR DELETE ON inventory.supplier_app_snapshots
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

CREATE TRIGGER supplier_app_items_append_only
BEFORE UPDATE OR DELETE ON inventory.supplier_app_items
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

COMMIT;
