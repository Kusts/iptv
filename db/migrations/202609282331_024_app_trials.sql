-- AI Revenue & Operations Platform
-- Migration 024: AppTrial lifecycle (Wave 7 slice S1)
--
-- Justification (only the genuinely missing trial-before-purchase piece):
-- - `inventory.app_trials`: tenant-scoped trial of one supplier app by one
--   person (optional linked customer). Lifecycle REQUESTED -> ACTIVE ->
--   VALIDATED, with EXPIRED (swept past expires_at) and INVALIDATED
--   (customer rejected) as terminal non-happy states. Status is MUTABLE
--   (no append-only trigger): the trial row is the lifecycle aggregate,
--   exactly like `trial.trials`.
-- - One open trial per (tenant, person, supplier): partial unique index
--   WHERE status IN ('REQUESTED','ACTIVE'). Writers additionally take a
--   per-(tenant, person, supplier) advisory lock so concurrent inserts
--   serialize instead of racing the index.
-- - Every relationship is tenant-aware: person -> identity.persons,
--   customer -> crm.customers, supplier -> inventory.suppliers, all keyed
--   on (tenant_id, id). No commerce/billing writes, no public event in
--   this slice.

BEGIN;

CREATE TABLE inventory.app_trials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    person_id uuid NOT NULL,
    customer_id uuid,
    supplier_id uuid NOT NULL,
    supplier_app_external_id text NOT NULL,
    status text NOT NULL DEFAULT 'REQUESTED',
    requested_at timestamptz NOT NULL DEFAULT now(),
    activated_at timestamptz,
    validated_at timestamptz,
    expires_at timestamptz,
    invalidated_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT app_trials_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT app_trials_customer_fk FOREIGN KEY (tenant_id, customer_id)
        REFERENCES crm.customers (tenant_id, id),
    CONSTRAINT app_trials_supplier_fk FOREIGN KEY (tenant_id, supplier_id)
        REFERENCES inventory.suppliers (tenant_id, id),
    CONSTRAINT app_trials_status_check CHECK (status IN ('REQUESTED','ACTIVE','VALIDATED','EXPIRED','INVALIDATED')),
    CONSTRAINT app_trials_external_not_blank CHECK (btrim(supplier_app_external_id) <> ''),
    CONSTRAINT app_trials_tenant_id_id_unique UNIQUE (tenant_id, id)
);

-- One open trial per (tenant, person, supplier): VALIDATED/EXPIRED/
-- INVALIDATED rows never block a later trial for the same triple.
CREATE UNIQUE INDEX app_trials_one_open_per_person_supplier
    ON inventory.app_trials (tenant_id, person_id, supplier_id)
    WHERE status IN ('REQUESTED', 'ACTIVE');

CREATE INDEX app_trials_person_idx
    ON inventory.app_trials (tenant_id, person_id, status);

CREATE INDEX app_trials_expiry_idx
    ON inventory.app_trials (tenant_id, expires_at)
    WHERE status IN ('REQUESTED', 'ACTIVE');

COMMIT;
