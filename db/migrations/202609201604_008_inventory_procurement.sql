-- AI Revenue & Operations Platform
-- Migration 008: Supplier procurement + provider credit inventory ledger

BEGIN;

CREATE SCHEMA IF NOT EXISTS inventory;

CREATE TABLE inventory.suppliers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    name text NOT NULL,
    supplier_type text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT suppliers_status_check CHECK (status IN ('ACTIVE','INACTIVE','RETIRED')),
    CONSTRAINT suppliers_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE inventory.supplier_offers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    offer_type text NOT NULL,
    quantity numeric(14,3),
    total_cost_minor bigint NOT NULL,
    unit_cost_minor bigint,
    currency char(3) NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz,
    terms_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT supplier_offers_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT supplier_offers_supplier_fk FOREIGN KEY (tenant_id, supplier_id)
        REFERENCES inventory.suppliers (tenant_id, id),
    CONSTRAINT supplier_offers_cost_check CHECK (total_cost_minor >= 0 AND (unit_cost_minor IS NULL OR unit_cost_minor >= 0)),
    CONSTRAINT supplier_offers_quantity_check CHECK (quantity IS NULL OR quantity > 0),
    CONSTRAINT supplier_offers_window_check CHECK (ends_at IS NULL OR ends_at > starts_at),
    CONSTRAINT supplier_offers_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE inventory.provider_credit_batches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    provider_account_id uuid NOT NULL,
    supplier_offer_id uuid,
    quantity_purchased numeric(14,3) NOT NULL,
    total_cost_minor bigint NOT NULL,
    currency char(3) NOT NULL,
    unit_cost_minor numeric(18,6) NOT NULL,
    purchased_at timestamptz NOT NULL,
    remaining_quantity numeric(14,3) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT provider_credit_batches_account_fk FOREIGN KEY (tenant_id, provider_account_id)
        REFERENCES provider.provider_accounts (tenant_id, id),
    CONSTRAINT provider_credit_batches_offer_fk FOREIGN KEY (tenant_id, supplier_offer_id)
        REFERENCES inventory.supplier_offers (tenant_id, id),
    CONSTRAINT provider_credit_batches_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT provider_credit_batches_quantity_positive CHECK (quantity_purchased > 0),
    CONSTRAINT provider_credit_batches_remaining_check CHECK (remaining_quantity >= 0 AND remaining_quantity <= quantity_purchased),
    CONSTRAINT provider_credit_batches_cost_check CHECK (total_cost_minor >= 0 AND unit_cost_minor >= 0),
    CONSTRAINT provider_credit_batches_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX provider_credit_batches_remaining_idx
    ON inventory.provider_credit_batches (tenant_id, provider_account_id, purchased_at)
    WHERE remaining_quantity > 0;

CREATE TABLE inventory.provider_credit_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    provider_account_id uuid NOT NULL,
    batch_id uuid,
    entry_type text NOT NULL,
    quantity_delta numeric(14,3) NOT NULL,
    cost_minor bigint,
    subscription_cycle_id uuid,
    subscription_addon_id uuid,
    provider_operation_id uuid,
    idempotency_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT provider_credit_entries_account_fk FOREIGN KEY (tenant_id, provider_account_id)
        REFERENCES provider.provider_accounts (tenant_id, id),
    CONSTRAINT provider_credit_entries_batch_fk FOREIGN KEY (tenant_id, batch_id)
        REFERENCES inventory.provider_credit_batches (tenant_id, id),
    CONSTRAINT provider_credit_entries_cycle_fk FOREIGN KEY (tenant_id, subscription_cycle_id)
        REFERENCES subscription.subscription_cycles (tenant_id, id),
    CONSTRAINT provider_credit_entries_addon_fk FOREIGN KEY (tenant_id, subscription_addon_id)
        REFERENCES subscription.subscription_addons (tenant_id, id),
    CONSTRAINT provider_credit_entries_operation_fk FOREIGN KEY (tenant_id, provider_operation_id)
        REFERENCES provider.provider_operations (tenant_id, id),
    CONSTRAINT provider_credit_entries_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT provider_credit_entries_type_check CHECK (entry_type IN ('PURCHASE','CONSUMPTION','ADJUSTMENT','REVERSAL','EXPIRY')),
    CONSTRAINT provider_credit_entries_quantity_nonzero CHECK (quantity_delta <> 0),
    CONSTRAINT provider_credit_entries_cost_check CHECK (cost_minor IS NULL OR cost_minor >= 0),
    CONSTRAINT provider_credit_entries_idempotency_unique UNIQUE (tenant_id, provider_account_id, idempotency_key),
    CONSTRAINT provider_credit_entries_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX provider_credit_entries_account_idx
    ON inventory.provider_credit_entries (tenant_id, provider_account_id, created_at DESC);

CREATE TRIGGER provider_credit_entries_append_only
BEFORE UPDATE OR DELETE ON inventory.provider_credit_entries
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

ALTER TABLE subscription.subscription_addon_cycle_charges
    ADD CONSTRAINT addon_cycle_charges_credit_entry_fk
    FOREIGN KEY (tenant_id, provider_credit_entry_id)
    REFERENCES inventory.provider_credit_entries (tenant_id, id);

COMMIT;
