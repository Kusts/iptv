-- AI Revenue & Operations Platform
-- Migration 001: control plane + platform reliability primitives
-- PostgreSQL

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS control;
CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS security;

CREATE TABLE control.tenants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    default_currency char(3) NOT NULL DEFAULT 'BRL',
    timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tenants_slug_not_blank CHECK (btrim(slug) <> ''),
    CONSTRAINT tenants_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT tenants_status_check CHECK (status IN ('ACTIVE','SUSPENDED','OFFBOARDING','CLOSED')),
    CONSTRAINT tenants_slug_unique UNIQUE (slug)
);

CREATE TABLE control.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_subject text NOT NULL,
    display_name text,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_auth_subject_not_blank CHECK (btrim(auth_subject) <> ''),
    CONSTRAINT users_auth_subject_unique UNIQUE (auth_subject),
    CONSTRAINT users_status_check CHECK (status IN ('ACTIVE','SUSPENDED','DISABLED'))
);

CREATE TABLE control.tenant_memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    user_id uuid NOT NULL REFERENCES control.users(id),
    role_key text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tenant_memberships_status_check CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED')),
    CONSTRAINT tenant_memberships_unique UNIQUE (tenant_id, user_id)
);

CREATE INDEX tenant_memberships_user_idx
    ON control.tenant_memberships (user_id, status);

CREATE TABLE control.feature_flags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid REFERENCES control.tenants(id),
    flag_key text NOT NULL,
    enabled boolean NOT NULL DEFAULT false,
    config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_by_user_id uuid REFERENCES control.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT feature_flags_key_not_blank CHECK (btrim(flag_key) <> '')
);

CREATE UNIQUE INDEX feature_flags_scope_key_unique
    ON control.feature_flags (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), flag_key);

CREATE TABLE security.risk_assessments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    subject_type text NOT NULL,
    subject_id uuid,
    decision text NOT NULL,
    score numeric(6,3),
    reason_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
    policy_version text NOT NULL,
    evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT risk_assessments_decision_check CHECK (decision IN ('ALLOW','REVIEW','DENY')),
    CONSTRAINT risk_assessments_score_check CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
    CONSTRAINT risk_assessments_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX risk_assessments_subject_idx
    ON security.risk_assessments (tenant_id, subject_type, subject_id, created_at DESC);

CREATE TABLE platform.idempotency_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    scope text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text,
    resource_type text,
    resource_id uuid,
    response_status integer,
    response_json jsonb,
    state text NOT NULL DEFAULT 'IN_PROGRESS',
    locked_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    expires_at timestamptz,
    CONSTRAINT idempotency_keys_state_check CHECK (state IN ('IN_PROGRESS','SUCCEEDED','FAILED')),
    CONSTRAINT idempotency_keys_scope_key_unique UNIQUE (tenant_id, scope, idempotency_key)
);

CREATE INDEX idempotency_keys_expiry_idx
    ON platform.idempotency_keys (expires_at)
    WHERE expires_at IS NOT NULL;

CREATE TABLE platform.audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    actor_type text NOT NULL,
    actor_id text,
    action_key text NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid,
    correlation_id uuid,
    metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT audit_actor_type_check CHECK (actor_type IN ('system','agent','human','external'))
);

CREATE INDEX audit_log_resource_idx
    ON platform.audit_log (tenant_id, resource_type, resource_id, occurred_at DESC);
CREATE INDEX audit_log_correlation_idx
    ON platform.audit_log (tenant_id, correlation_id)
    WHERE correlation_id IS NOT NULL;

CREATE TABLE platform.domain_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    event_type text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    aggregate_version bigint NOT NULL,
    occurred_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    correlation_id uuid NOT NULL,
    causation_id uuid,
    actor_type text NOT NULL,
    actor_id text,
    schema_version integer NOT NULL DEFAULT 1,
    data_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT domain_events_event_id_unique UNIQUE (event_id),
    CONSTRAINT domain_events_aggregate_version_unique UNIQUE (tenant_id, aggregate_type, aggregate_id, aggregate_version),
    CONSTRAINT domain_events_actor_type_check CHECK (actor_type IN ('system','agent','human','external')),
    CONSTRAINT domain_events_schema_version_positive CHECK (schema_version > 0),
    CONSTRAINT domain_events_aggregate_version_positive CHECK (aggregate_version > 0)
);

CREATE INDEX domain_events_type_time_idx
    ON platform.domain_events (tenant_id, event_type, recorded_at DESC);
CREATE INDEX domain_events_correlation_idx
    ON platform.domain_events (tenant_id, correlation_id, recorded_at);

CREATE TABLE platform.outbox_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    domain_event_id uuid NOT NULL REFERENCES platform.domain_events(id),
    topic text NOT NULL,
    message_key text,
    payload_json jsonb NOT NULL,
    headers_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    state text NOT NULL DEFAULT 'PENDING',
    attempt_count integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    last_error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT outbox_state_check CHECK (state IN ('PENDING','PUBLISHING','PUBLISHED','FAILED')),
    CONSTRAINT outbox_attempt_nonnegative CHECK (attempt_count >= 0),
    CONSTRAINT outbox_one_per_event_topic UNIQUE (tenant_id, domain_event_id, topic)
);

CREATE INDEX outbox_pending_idx
    ON platform.outbox_messages (next_attempt_at, created_at)
    WHERE state IN ('PENDING','FAILED');

CREATE TABLE platform.inbox_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    provider text NOT NULL,
    external_event_id text NOT NULL,
    event_type text,
    payload_hash text NOT NULL,
    payload_json jsonb,
    received_at timestamptz NOT NULL DEFAULT now(),
    state text NOT NULL DEFAULT 'RECEIVED',
    attempt_count integer NOT NULL DEFAULT 0,
    processed_at timestamptz,
    last_error_code text,
    correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
    CONSTRAINT inbox_state_check CHECK (state IN ('RECEIVED','PROCESSING','PROCESSED','FAILED','IGNORED')),
    CONSTRAINT inbox_attempt_nonnegative CHECK (attempt_count >= 0),
    CONSTRAINT inbox_external_event_unique UNIQUE (tenant_id, provider, external_event_id)
);

CREATE INDEX inbox_processing_idx
    ON platform.inbox_messages (tenant_id, state, received_at)
    WHERE state IN ('RECEIVED','FAILED');

CREATE OR REPLACE FUNCTION platform.reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'table %.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON platform.audit_log
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

CREATE TRIGGER domain_events_append_only
BEFORE UPDATE OR DELETE ON platform.domain_events
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

COMMIT;
