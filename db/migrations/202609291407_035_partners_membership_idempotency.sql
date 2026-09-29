-- AI Revenue & Operations Platform
-- Migration 035: Partners fixes (Wave 13 review iptv-w13-review)
--
-- - `partner_memberships`: authenticated account<->user association so the
--   acting-parent / managed-account scope derives from auth, never from the
--   request body. Reuses the tenants membership pattern (tenant-scoped,
--   one row per (tenant, partner, user)). Membership rows are explicit
--   grants — no lifecycle of their own in the MVP.
-- - `idempotency_fingerprint` on the three domain-idempotency tables
--   (credit entries, credit reservations, orders): sha256 of the normalized
--   payload stored next to the domain key so key reuse with a divergent
--   payload is rejected instead of replaying the stale result.

BEGIN;

CREATE TABLE partners.partner_memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    partner_account_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES control.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT partner_memberships_partner_fk FOREIGN KEY (tenant_id, partner_account_id)
        REFERENCES partners.partner_accounts (tenant_id, id),
    CONSTRAINT partner_memberships_tenant_partner_user_unique UNIQUE (tenant_id, partner_account_id, user_id),
    CONSTRAINT partner_memberships_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX partner_memberships_user_idx
    ON partners.partner_memberships (tenant_id, user_id);

ALTER TABLE partners.reseller_credit_entries
    ADD COLUMN idempotency_fingerprint text NULL;

ALTER TABLE partners.reseller_credit_reservations
    ADD COLUMN idempotency_fingerprint text NULL;

ALTER TABLE partners.reseller_orders
    ADD COLUMN idempotency_fingerprint text NULL;

COMMIT;
