-- AI Revenue & Operations Platform
-- Migration 025: MK supplier balance + atomic credit reservations (Wave 7 slice S2)
--
-- Justification (only the genuinely missing F15 pieces):
-- - `inventory.supplier_balance_snapshots`: append-only observed MK balance
--   readings per tenant+supplier (balance_minor bigint exact minor units +
--   explicit 3-letter currency, observed_at, evidence_ref). History is never
--   updated in place (append-only trigger, like the credit ledger).
-- - `inventory.credit_reservations`: one held amount per procurement attempt.
--   `total_minor` is authorized at reserve; while ACTIVE the full amount is
--   held (`reserved_minor = total_minor`, `available_minor = total_minor`);
--   terminal states (CONSUMED/RELEASED/EXPIRED) zero both. Available pool =
--   latest snapshot balance - SUM(total_minor) over ACTIVE reservations,
--   computed under a per-(tenant, supplier) advisory lock so concurrent
--   reserves serialize (no double-spend). Idempotent on
--   (tenant_id, supplier_id, idempotency_key).
-- - `inventory.procurement_orders`: links one commerce Order + one app trial
--   to one reservation for one supplier. DRAFT -> RESERVED (funds held) ->
--   PURCHASED, with FAILED for abandoned attempts. The S3 purchase gate
--   requires RESERVED + SETTLED Order before consuming the reservation.
-- - All FKs tenant-aware (supplier, commerce order, app trial, reservation).
--   Money is exact bigint minor units; no floats anywhere.

BEGIN;

CREATE TABLE inventory.supplier_balance_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    supplier_id uuid NOT NULL,
    balance_minor bigint NOT NULL,
    currency char(3) NOT NULL,
    observed_at timestamptz NOT NULL DEFAULT now(),
    evidence_ref text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT supplier_balance_snapshots_supplier_fk FOREIGN KEY (tenant_id, supplier_id)
        REFERENCES inventory.suppliers (tenant_id, id),
    CONSTRAINT supplier_balance_snapshots_balance_check CHECK (balance_minor >= 0),
    CONSTRAINT supplier_balance_snapshots_evidence_not_blank CHECK (btrim(evidence_ref) <> ''),
    CONSTRAINT supplier_balance_snapshots_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX supplier_balance_snapshots_latest_idx
    ON inventory.supplier_balance_snapshots (tenant_id, supplier_id, observed_at DESC);

CREATE TRIGGER supplier_balance_snapshots_append_only
BEFORE UPDATE OR DELETE ON inventory.supplier_balance_snapshots
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

CREATE TABLE inventory.credit_reservations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    supplier_id uuid NOT NULL,
    total_minor bigint NOT NULL,
    reserved_minor bigint NOT NULL,
    available_minor bigint NOT NULL,
    currency char(3) NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    idempotency_key text NOT NULL,
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT credit_reservations_supplier_fk FOREIGN KEY (tenant_id, supplier_id)
        REFERENCES inventory.suppliers (tenant_id, id),
    CONSTRAINT credit_reservations_status_check CHECK (status IN ('ACTIVE','CONSUMED','RELEASED','EXPIRED')),
    CONSTRAINT credit_reservations_total_positive CHECK (total_minor > 0),
    CONSTRAINT credit_reservations_amounts_check CHECK (
        reserved_minor >= 0 AND reserved_minor <= total_minor AND
        available_minor >= 0 AND available_minor <= total_minor
    ),
    CONSTRAINT credit_reservations_idempotency_unique UNIQUE (tenant_id, supplier_id, idempotency_key),
    CONSTRAINT credit_reservations_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX credit_reservations_active_idx
    ON inventory.credit_reservations (tenant_id, supplier_id, status)
    WHERE status = 'ACTIVE';

CREATE TABLE inventory.procurement_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    supplier_id uuid NOT NULL,
    commerce_order_id uuid NOT NULL,
    app_trial_id uuid NOT NULL,
    credit_reservation_id uuid,
    status text NOT NULL DEFAULT 'DRAFT',
    total_cost_minor bigint NOT NULL,
    currency char(3) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT procurement_orders_supplier_fk FOREIGN KEY (tenant_id, supplier_id)
        REFERENCES inventory.suppliers (tenant_id, id),
    CONSTRAINT procurement_orders_commerce_order_fk FOREIGN KEY (tenant_id, commerce_order_id)
        REFERENCES commerce.orders (tenant_id, id),
    CONSTRAINT procurement_orders_app_trial_fk FOREIGN KEY (tenant_id, app_trial_id)
        REFERENCES inventory.app_trials (tenant_id, id),
    CONSTRAINT procurement_orders_reservation_fk FOREIGN KEY (tenant_id, credit_reservation_id)
        REFERENCES inventory.credit_reservations (tenant_id, id),
    CONSTRAINT procurement_orders_status_check CHECK (status IN ('DRAFT','RESERVED','PURCHASED','FAILED')),
    CONSTRAINT procurement_orders_cost_positive CHECK (total_cost_minor > 0),
    CONSTRAINT procurement_orders_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX procurement_orders_order_idx
    ON inventory.procurement_orders (tenant_id, commerce_order_id);

COMMIT;
