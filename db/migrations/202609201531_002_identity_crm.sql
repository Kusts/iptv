-- AI Revenue & Operations Platform
-- Migration 002: Identity & CRM core

BEGIN;

CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS crm;

CREATE TABLE identity.persons (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    status text NOT NULL DEFAULT 'ACTIVE',
    canonical_name text,
    locale text,
    timezone text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    anonymized_at timestamptz,
    CONSTRAINT persons_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX persons_tenant_created_idx
    ON identity.persons (tenant_id, created_at DESC);
CREATE INDEX persons_tenant_status_idx
    ON identity.persons (tenant_id, status);

CREATE TABLE identity.identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    person_id uuid NOT NULL,
    identity_type text NOT NULL,
    normalized_value text NOT NULL,
    external_provider text,
    external_id text,
    verification_status text NOT NULL DEFAULT 'UNVERIFIED',
    link_confidence numeric(5,4),
    metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    verified_at timestamptz,
    detached_at timestamptz,
    CONSTRAINT identities_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT identities_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT identities_verification_status_check CHECK (verification_status IN ('UNVERIFIED','VERIFIED','LINKED','DISPUTED','DETACHED')),
    CONSTRAINT identities_link_confidence_check CHECK (link_confidence IS NULL OR (link_confidence >= 0 AND link_confidence <= 1)),
    CONSTRAINT identities_normalized_value_not_blank CHECK (btrim(normalized_value) <> ''),
    CONSTRAINT identities_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX identities_active_normalized_unique
    ON identity.identities (tenant_id, identity_type, normalized_value)
    WHERE detached_at IS NULL;

CREATE INDEX identities_person_idx
    ON identity.identities (tenant_id, person_id, created_at DESC);

CREATE TABLE identity.identity_merge_reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    source_person_id uuid NOT NULL,
    target_person_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'REQUESTED',
    reason_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
    requested_by text NOT NULL,
    resolved_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    CONSTRAINT identity_merge_source_fk FOREIGN KEY (tenant_id, source_person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT identity_merge_target_fk FOREIGN KEY (tenant_id, target_person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT identity_merge_distinct_people CHECK (source_person_id <> target_person_id),
    CONSTRAINT identity_merge_reviews_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX identity_merge_reviews_open_idx
    ON identity.identity_merge_reviews (tenant_id, status, created_at)
    WHERE resolved_at IS NULL;

CREATE TABLE crm.leads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    person_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'NEW',
    stage text,
    source_attribution_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    qualified_at timestamptz,
    lost_at timestamptz,
    closed_reason text,
    CONSTRAINT leads_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT leads_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT leads_status_check CHECK (status IN ('NEW','CONTACTED','QUALIFIED','ENGAGED','OFFERED','CONVERTED','NURTURE','LOST','DISQUALIFIED')),
    CONSTRAINT leads_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX leads_person_history_idx
    ON crm.leads (tenant_id, person_id, created_at DESC);
CREATE INDEX leads_status_idx
    ON crm.leads (tenant_id, status, created_at DESC);

CREATE TABLE crm.customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    person_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    customer_since timestamptz NOT NULL DEFAULT now(),
    last_reactivated_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT customers_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT customers_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT customers_status_check CHECK (status IN ('ACTIVE','LAPSED','CHURNED','REACTIVATING')),
    CONSTRAINT customers_tenant_person_unique UNIQUE (tenant_id, person_id),
    CONSTRAINT customers_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX customers_status_idx
    ON crm.customers (tenant_id, status, updated_at DESC);

CREATE TABLE crm.customer_health_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    score numeric(6,3) NOT NULL,
    risk_level text NOT NULL,
    model_or_rule_version text NOT NULL,
    features_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    calculated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT customer_health_customer_fk FOREIGN KEY (tenant_id, customer_id)
        REFERENCES crm.customers (tenant_id, id),
    CONSTRAINT customer_health_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT customer_health_score_check CHECK (score >= 0 AND score <= 100)
);

CREATE INDEX customer_health_latest_idx
    ON crm.customer_health_snapshots (tenant_id, customer_id, calculated_at DESC);

COMMIT;
