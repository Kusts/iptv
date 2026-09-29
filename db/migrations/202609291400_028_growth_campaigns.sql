-- AI Revenue & Operations Platform
-- Migration 028: Growth core — campaigns, versions, audiences, creatives (Wave 11)
--
-- - New `growth` schema: campaigns with DRAFT/ACTIVE/PAUSED/COMPLETED
--   lifecycle, immutable published versions (material edits create a new
--   version row; published rows are never mutated by commands), audience
--   definitions with optional static memberships, and per-channel creatives.
-- - Money is exact bigint minor units (never floats); snapshots are jsonb.
-- - All cross-aggregate references use tenant-aware composite FKs.

BEGIN;

CREATE SCHEMA IF NOT EXISTS growth;

CREATE TABLE growth.campaigns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    campaign_key text NOT NULL,
    name text NOT NULL,
    objective text,
    status text NOT NULL DEFAULT 'DRAFT',
    current_version_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT campaigns_status_check CHECK (status IN ('DRAFT','ACTIVE','PAUSED','COMPLETED')),
    CONSTRAINT campaigns_name_check CHECK (char_length(name) BETWEEN 1 AND 200),
    CONSTRAINT campaigns_key_unique UNIQUE (tenant_id, campaign_key),
    CONSTRAINT campaigns_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE growth.campaign_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    campaign_id uuid NOT NULL,
    version_no integer NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT',
    offer_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    policy_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    budget_cap_minor bigint,
    currency text NOT NULL DEFAULT 'BRL',
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT campaign_versions_campaign_fk FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES growth.campaigns (tenant_id, id),
    CONSTRAINT campaign_versions_status_check CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
    CONSTRAINT campaign_versions_version_positive CHECK (version_no > 0),
    CONSTRAINT campaign_versions_budget_nonnegative CHECK (budget_cap_minor IS NULL OR budget_cap_minor >= 0),
    CONSTRAINT campaign_versions_published_shape_check CHECK (
        (status = 'PUBLISHED' AND published_at IS NOT NULL) OR
        (status <> 'PUBLISHED' AND published_at IS NULL)
    ),
    CONSTRAINT campaign_versions_number_unique UNIQUE (tenant_id, campaign_id, version_no),
    CONSTRAINT campaign_versions_tenant_id_id_unique UNIQUE (tenant_id, id)
);

-- Current-version pointer: added after both tables exist to avoid a
-- forward FK reference. Nullable: a campaign may exist before its first
-- published version.
ALTER TABLE growth.campaigns
    ADD CONSTRAINT campaigns_current_version_fk FOREIGN KEY (tenant_id, current_version_id)
        REFERENCES growth.campaign_versions (tenant_id, id);

CREATE TABLE growth.audience_definitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    campaign_id uuid,
    name text NOT NULL,
    membership_type text NOT NULL DEFAULT 'DYNAMIC',
    criteria_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT audience_definitions_campaign_fk FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES growth.campaigns (tenant_id, id),
    CONSTRAINT audience_definitions_membership_check CHECK (membership_type IN ('DYNAMIC','STATIC')),
    CONSTRAINT audience_definitions_name_check CHECK (char_length(name) BETWEEN 1 AND 200),
    CONSTRAINT audience_definitions_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX audience_definitions_campaign_idx
    ON growth.audience_definitions (tenant_id, campaign_id)
    WHERE campaign_id IS NOT NULL;

CREATE TABLE growth.audience_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    audience_id uuid NOT NULL,
    person_id uuid NOT NULL,
    added_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT audience_members_audience_fk FOREIGN KEY (tenant_id, audience_id)
        REFERENCES growth.audience_definitions (tenant_id, id),
    CONSTRAINT audience_members_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT audience_members_unique UNIQUE (tenant_id, audience_id, person_id),
    CONSTRAINT audience_members_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE growth.creatives (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    campaign_id uuid NOT NULL,
    campaign_version_id uuid,
    channel text NOT NULL,
    name text NOT NULL,
    content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'DRAFT',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT creatives_campaign_fk FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES growth.campaigns (tenant_id, id),
    CONSTRAINT creatives_version_fk FOREIGN KEY (tenant_id, campaign_version_id)
        REFERENCES growth.campaign_versions (tenant_id, id),
    CONSTRAINT creatives_status_check CHECK (status IN ('DRAFT','APPROVED','ARCHIVED')),
    CONSTRAINT creatives_name_check CHECK (char_length(name) BETWEEN 1 AND 200),
    CONSTRAINT creatives_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX creatives_campaign_idx
    ON growth.creatives (tenant_id, campaign_id);

COMMIT;
