-- AI Revenue & Operations Platform
-- Migration 032: Partners core (Wave 13 slice S1)
--
-- Bounded context `partners` (MVP-PILOT):
-- - `partner_accounts`: reseller/service account with the canonical
--   lifecycle PROSPECT -> ONBOARDING -> TRAINING -> READY -> ACTIVE
--   (+ AT_RISK | INACTIVE | SUSPENDED | TERMINATED). `linked_tenant_id`
--   is the POST-MVP SaaS link (nullable, no behavior in this slice).
-- - `partner_relationships`: DIRECT parent -> child edge. One active
--   parent per child (unique), self-parent rejected, cycles rejected by
--   the command layer walk (linear: at most one parent per child).
-- - `partner_capabilities`: independent capability flags per account
--   (SERVICE_RESELLER now; SAAS_RESELLER later).
-- - Tenant-aware composite FKs + UNIQUE (tenant_id, id) follow the
--   inventory/referral convention so children reference (tenant, id).

BEGIN;

CREATE SCHEMA IF NOT EXISTS partners;

CREATE TABLE partners.partner_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    display_name text NOT NULL,
    account_type text NOT NULL DEFAULT 'SERVICE_RESELLER',
    status text NOT NULL DEFAULT 'ONBOARDING',
    linked_tenant_id uuid NULL REFERENCES control.tenants(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT partner_accounts_status_check CHECK (status IN ('PROSPECT','ONBOARDING','TRAINING','READY','ACTIVE','AT_RISK','INACTIVE','SUSPENDED','TERMINATED')),
    CONSTRAINT partner_accounts_type_check CHECK (account_type IN ('SERVICE_RESELLER')),
    CONSTRAINT partner_accounts_display_name_not_blank CHECK (btrim(display_name) <> ''),
    CONSTRAINT partner_accounts_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE partners.partner_relationships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    parent_account_id uuid NOT NULL,
    child_account_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz NULL,
    CONSTRAINT partner_relationships_parent_fk FOREIGN KEY (tenant_id, parent_account_id)
        REFERENCES partners.partner_accounts (tenant_id, id),
    CONSTRAINT partner_relationships_child_fk FOREIGN KEY (tenant_id, child_account_id)
        REFERENCES partners.partner_accounts (tenant_id, id),
    CONSTRAINT partner_relationships_status_check CHECK (status IN ('ACTIVE','ENDED')),
    CONSTRAINT partner_relationships_no_self_parent CHECK (parent_account_id <> child_account_id),
    CONSTRAINT partner_relationships_direct_parent_unique UNIQUE (tenant_id, child_account_id),
    CONSTRAINT partner_relationships_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX partner_relationships_children_idx
    ON partners.partner_relationships (tenant_id, parent_account_id, status)
    WHERE status = 'ACTIVE';

CREATE TABLE partners.partner_capabilities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    partner_account_id uuid NOT NULL,
    capability_key text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT partner_capabilities_partner_fk FOREIGN KEY (tenant_id, partner_account_id)
        REFERENCES partners.partner_accounts (tenant_id, id),
    CONSTRAINT partner_capabilities_status_check CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED')),
    CONSTRAINT partner_capabilities_key_check CHECK (capability_key IN ('SERVICE_RESELLER','SAAS_RESELLER')),
    CONSTRAINT partner_capabilities_account_key_unique UNIQUE (tenant_id, partner_account_id, capability_key),
    CONSTRAINT partner_capabilities_tenant_id_id_unique UNIQUE (tenant_id, id)
);

COMMIT;
