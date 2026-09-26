-- AI Revenue & Operations Platform
-- Migration 007: Provider fulfillment, operations, evidence & health

BEGIN;

CREATE SCHEMA IF NOT EXISTS provider;

CREATE TABLE provider.providers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_key text NOT NULL UNIQUE,
    name text NOT NULL,
    provider_type text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT providers_status_check CHECK (status IN ('ACTIVE','DEGRADED','INACTIVE','RETIRED')),
    CONSTRAINT providers_key_not_blank CHECK (btrim(provider_key) <> '')
);

CREATE TABLE provider.provider_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    provider_id uuid NOT NULL REFERENCES provider.providers(id),
    name text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    secret_ref text NOT NULL,
    settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_recharge_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT provider_accounts_status_check CHECK (status IN ('ACTIVE','DEGRADED','SUSPENDED','DISABLED')),
    CONSTRAINT provider_accounts_secret_not_blank CHECK (btrim(secret_ref) <> ''),
    CONSTRAINT provider_accounts_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX provider_accounts_provider_idx ON provider.provider_accounts (tenant_id, provider_id, status);

CREATE TABLE provider.provider_bindings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    provider_account_id uuid NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    external_id text NOT NULL,
    external_secondary_id text,
    status text NOT NULL DEFAULT 'ACTIVE',
    metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_verified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT provider_bindings_account_fk FOREIGN KEY (tenant_id, provider_account_id)
        REFERENCES provider.provider_accounts (tenant_id, id),
    CONSTRAINT provider_bindings_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT provider_bindings_status_check CHECK (status IN ('ACTIVE','DEGRADED','STALE','RETIRED')),
    CONSTRAINT provider_bindings_entity_unique UNIQUE (tenant_id, provider_account_id, entity_type, entity_id),
    CONSTRAINT provider_bindings_external_unique UNIQUE (tenant_id, provider_account_id, entity_type, external_id),
    CONSTRAINT provider_bindings_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE provider.provider_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    provider_account_id uuid NOT NULL,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'REQUESTED',
    idempotency_key text NOT NULL,
    execution_channel text,
    adapter_version text,
    requested_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    result_summary_json jsonb,
    requested_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    correlation_id uuid NOT NULL,
    CONSTRAINT provider_operations_account_fk FOREIGN KEY (tenant_id, provider_account_id)
        REFERENCES provider.provider_accounts (tenant_id, id),
    CONSTRAINT provider_operations_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT provider_operations_status_check CHECK (status IN ('REQUESTED','QUEUED','RUNNING','VERIFYING','RETRY_WAIT','HUMAN_REQUIRED','SUCCEEDED','FAILED','CANCELLED')),
    CONSTRAINT provider_operations_channel_check CHECK (execution_channel IS NULL OR execution_channel IN ('API','BROWSER','MANUAL')),
    CONSTRAINT provider_operations_idempotency_unique UNIQUE (tenant_id, provider_account_id, idempotency_key),
    CONSTRAINT provider_operations_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX provider_operations_queue_idx
    ON provider.provider_operations (tenant_id, status, requested_at)
    WHERE status IN ('REQUESTED','QUEUED','RETRY_WAIT');
CREATE INDEX provider_operations_entity_idx
    ON provider.provider_operations (tenant_id, entity_type, entity_id, requested_at DESC);

CREATE TABLE provider.provider_operation_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    provider_operation_id uuid NOT NULL,
    attempt_no integer NOT NULL,
    status text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    error_class text,
    error_code text,
    trace_ref text,
    CONSTRAINT provider_operation_attempts_operation_fk FOREIGN KEY (tenant_id, provider_operation_id)
        REFERENCES provider.provider_operations (tenant_id, id),
    CONSTRAINT provider_operation_attempts_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT provider_operation_attempts_attempt_positive CHECK (attempt_no > 0),
    CONSTRAINT provider_operation_attempts_unique UNIQUE (tenant_id, provider_operation_id, attempt_no),
    CONSTRAINT provider_operation_attempts_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE provider.provider_evidence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    provider_operation_id uuid NOT NULL,
    evidence_type text NOT NULL,
    object_ref text,
    structured_json jsonb,
    captured_at timestamptz NOT NULL DEFAULT now(),
    classification text NOT NULL DEFAULT 'C2',
    CONSTRAINT provider_evidence_operation_fk FOREIGN KEY (tenant_id, provider_operation_id)
        REFERENCES provider.provider_operations (tenant_id, id),
    CONSTRAINT provider_evidence_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT provider_evidence_classification_check CHECK (classification IN ('C0','C1','C2','C3')),
    CONSTRAINT provider_evidence_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX provider_evidence_operation_idx
    ON provider.provider_evidence (tenant_id, provider_operation_id, captured_at DESC);

CREATE TABLE provider.provider_health_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    provider_account_id uuid,
    provider_server_key text,
    score numeric(6,3) NOT NULL,
    status text NOT NULL,
    signals_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    calculated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT provider_health_account_fk FOREIGN KEY (tenant_id, provider_account_id)
        REFERENCES provider.provider_accounts (tenant_id, id),
    CONSTRAINT provider_health_score_check CHECK (score >= 0 AND score <= 100),
    CONSTRAINT provider_health_status_check CHECK (status IN ('HEALTHY','DEGRADED','UNHEALTHY','UNKNOWN'))
);

CREATE INDEX provider_health_latest_idx
    ON provider.provider_health_snapshots (tenant_id, provider_account_id, provider_server_key, calculated_at DESC);

-- Now that provider tables exist, bind Trial references with tenant-safe foreign keys.
ALTER TABLE trial.trials
    ADD CONSTRAINT trials_provider_account_fk
    FOREIGN KEY (tenant_id, provider_account_id)
    REFERENCES provider.provider_accounts (tenant_id, id);

ALTER TABLE trial.trials
    ADD CONSTRAINT trials_provider_binding_fk
    FOREIGN KEY (tenant_id, provider_binding_id)
    REFERENCES provider.provider_bindings (tenant_id, id);

COMMIT;
