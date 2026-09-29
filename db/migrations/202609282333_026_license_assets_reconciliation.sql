-- AI Revenue & Operations Platform
-- Migration 026: LicenseAsset lifecycle + supplier reconciliation (Wave 7 slice S3)
--
-- Justification (only the genuinely missing G07 pieces):
-- - `inventory.license_assets`: APPEND-ONLY lifecycle rows for one purchased
--   app license. The license identity is the procurement order (exactly one
--   supplier charge per purchase, G07): the first row is PROVISIONING and
--   every later transition (ACTIVE with activation evidence, FAILED,
--   REVOKED) is a NEW row pointing at `prior_asset_id`. Current status is
--   the latest row per (tenant, procurement_order). A partial unique index
--   allows a single PROVISIONING row per procurement order, so a second
--   purchase attempt fails closed instead of double-charging (writers also
--   take a per-procurement-order advisory lock).
-- - `inventory.reconciliation_findings`: one row per uncertain supplier
--   effect (entity ref + expected vs observed). OPEN -> RESOLVED with a
--   resolution_ref (operation id / evidence); status is mutable because the
--   finding IS the resolution aggregate, exactly like billing.exceptions.
-- - All FKs tenant-aware (customer, procurement order, supplier, license
--   chain). No commerce/billing writes in this slice; only the
--   registry-listed `inventory.license.activated.v1` domain event is
--   emitted on activation.

BEGIN;

CREATE TABLE inventory.license_assets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    customer_id uuid NOT NULL,
    procurement_order_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    prior_asset_id uuid,
    external_license_ref text,
    status text NOT NULL,
    activation_evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT license_assets_customer_fk FOREIGN KEY (tenant_id, customer_id)
        REFERENCES crm.customers (tenant_id, id),
    CONSTRAINT license_assets_procurement_fk FOREIGN KEY (tenant_id, procurement_order_id)
        REFERENCES inventory.procurement_orders (tenant_id, id),
    CONSTRAINT license_assets_supplier_fk FOREIGN KEY (tenant_id, supplier_id)
        REFERENCES inventory.suppliers (tenant_id, id),
    CONSTRAINT license_assets_prior_fk FOREIGN KEY (tenant_id, prior_asset_id)
        REFERENCES inventory.license_assets (tenant_id, id),
    CONSTRAINT license_assets_status_check CHECK (status IN ('PROVISIONING','ACTIVE','FAILED','REVOKED')),
    CONSTRAINT license_assets_tenant_id_id_unique UNIQUE (tenant_id, id)
);

-- Exactly one PROVISIONING row per procurement order: a second purchase for
-- the same procurement fails closed (no blind re-execution, G07).
CREATE UNIQUE INDEX license_assets_one_provisioning_per_procurement
    ON inventory.license_assets (tenant_id, procurement_order_id)
    WHERE status = 'PROVISIONING';

CREATE INDEX license_assets_procurement_idx
    ON inventory.license_assets (tenant_id, procurement_order_id, created_at DESC);

CREATE TRIGGER license_assets_append_only
BEFORE UPDATE OR DELETE ON inventory.license_assets
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

CREATE TABLE inventory.reconciliation_findings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    expected_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    observed_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'OPEN',
    resolution_ref text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    CONSTRAINT reconciliation_findings_status_check CHECK (status IN ('OPEN','RESOLVED')),
    CONSTRAINT reconciliation_findings_entity_not_blank CHECK (btrim(entity_type) <> ''),
    CONSTRAINT reconciliation_findings_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX reconciliation_findings_open_idx
    ON inventory.reconciliation_findings (tenant_id, status, entity_type, entity_id)
    WHERE status = 'OPEN';

COMMIT;
