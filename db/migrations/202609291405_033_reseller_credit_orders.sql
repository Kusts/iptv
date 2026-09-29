-- AI Revenue & Operations Platform
-- Migration 033: Reseller prepaid credit + orders (Wave 13 slice S2)
--
-- - `reseller_credit_entries`: append-only ledger truth (TOPUP / RESERVE /
--   CONSUME / RELEASE / ADJUST). Money is exact bigint minor units; RESERVE
--   and RELEASE are zero-amount memo rows (holds live in the reservations
--   table), TOPUP positive, CONSUME negative, ADJUST signed. Trigger
--   rejects UPDATE/DELETE like every other ledger in the platform.
-- - `reseller_credit_reservations`: one hold per funding attempt.
--   RESERVED -> CONSUMED | RELEASED. Available pool = SUM(entries) -
--   SUM(RESERVED reservations), computed under a per-(tenant, partner)
--   advisory lock so concurrent orders serialize (no double-spend).
--   Idempotent on (tenant_id, partner_account_id, idempotency_key).
-- - `reseller_price_books`: versioned wholesale books; orders pin the exact
--   version (price snapshot immutable after settlement).
-- - `reseller_orders`: DRAFT -> RESERVED -> SETTLED, FAILED for abandoned
--   attempts. Idempotent on (tenant_id, partner_account_id,
--   idempotency_key). POST-MVP: postpaid limits (no column here).

BEGIN;

CREATE TABLE partners.reseller_credit_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    partner_account_id uuid NOT NULL,
    entry_type text NOT NULL,
    amount_minor bigint NOT NULL,
    currency char(3) NOT NULL,
    idempotency_key text NOT NULL,
    reference_type text NULL,
    reference_id uuid NULL,
    evidence_ref text NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT reseller_credit_entries_partner_fk FOREIGN KEY (tenant_id, partner_account_id)
        REFERENCES partners.partner_accounts (tenant_id, id),
    CONSTRAINT reseller_credit_entries_type_check CHECK (entry_type IN ('TOPUP','RESERVE','CONSUME','RELEASE','ADJUST')),
    CONSTRAINT reseller_credit_entries_idempotency_unique UNIQUE (tenant_id, partner_account_id, idempotency_key),
    CONSTRAINT reseller_credit_entries_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX reseller_credit_entries_partner_idx
    ON partners.reseller_credit_entries (tenant_id, partner_account_id, created_at);

CREATE TRIGGER reseller_credit_entries_append_only
BEFORE UPDATE OR DELETE ON partners.reseller_credit_entries
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

CREATE TABLE partners.reseller_credit_reservations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    partner_account_id uuid NOT NULL,
    amount_minor bigint NOT NULL,
    currency char(3) NOT NULL,
    status text NOT NULL DEFAULT 'RESERVED',
    idempotency_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT reseller_credit_reservations_partner_fk FOREIGN KEY (tenant_id, partner_account_id)
        REFERENCES partners.partner_accounts (tenant_id, id),
    CONSTRAINT reseller_credit_reservations_status_check CHECK (status IN ('RESERVED','CONSUMED','RELEASED')),
    CONSTRAINT reseller_credit_reservations_amount_positive CHECK (amount_minor > 0),
    CONSTRAINT reseller_credit_reservations_idempotency_unique UNIQUE (tenant_id, partner_account_id, idempotency_key),
    CONSTRAINT reseller_credit_reservations_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX reseller_credit_reservations_active_idx
    ON partners.reseller_credit_reservations (tenant_id, partner_account_id, status)
    WHERE status = 'RESERVED';

CREATE TABLE partners.reseller_price_books (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    book_key text NOT NULL,
    version_no integer NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT',
    unit_price_minor bigint NOT NULL,
    currency char(3) NOT NULL,
    published_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT reseller_price_books_status_check CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
    CONSTRAINT reseller_price_books_version_positive CHECK (version_no >= 1),
    CONSTRAINT reseller_price_books_unit_price_positive CHECK (unit_price_minor > 0),
    CONSTRAINT reseller_price_books_key_not_blank CHECK (btrim(book_key) <> ''),
    CONSTRAINT reseller_price_books_version_unique UNIQUE (tenant_id, book_key, version_no),
    CONSTRAINT reseller_price_books_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE partners.reseller_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    partner_account_id uuid NOT NULL,
    price_book_id uuid NOT NULL,
    quantity integer NOT NULL,
    unit_price_minor bigint NOT NULL,
    total_minor bigint NOT NULL,
    currency char(3) NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT',
    credit_reservation_id uuid NULL,
    idempotency_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    settled_at timestamptz NULL,
    CONSTRAINT reseller_orders_partner_fk FOREIGN KEY (tenant_id, partner_account_id)
        REFERENCES partners.partner_accounts (tenant_id, id),
    CONSTRAINT reseller_orders_price_book_fk FOREIGN KEY (tenant_id, price_book_id)
        REFERENCES partners.reseller_price_books (tenant_id, id),
    CONSTRAINT reseller_orders_reservation_fk FOREIGN KEY (tenant_id, credit_reservation_id)
        REFERENCES partners.reseller_credit_reservations (tenant_id, id),
    CONSTRAINT reseller_orders_status_check CHECK (status IN ('DRAFT','RESERVED','SETTLED','FAILED')),
    CONSTRAINT reseller_orders_quantity_positive CHECK (quantity > 0),
    CONSTRAINT reseller_orders_amounts_positive CHECK (unit_price_minor > 0 AND total_minor > 0),
    CONSTRAINT reseller_orders_idempotency_unique UNIQUE (tenant_id, partner_account_id, idempotency_key),
    CONSTRAINT reseller_orders_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX reseller_orders_partner_idx
    ON partners.reseller_orders (tenant_id, partner_account_id, status);

COMMIT;
