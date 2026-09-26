-- AI Revenue & Operations Platform
-- Migration 003: Trial, Retrial & technical compatibility baseline

BEGIN;

CREATE SCHEMA IF NOT EXISTS trial;

CREATE TABLE trial.trial_eligibility_decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    person_id uuid NOT NULL,
    outcome text NOT NULL,
    policy_version text NOT NULL,
    risk_assessment_id uuid,
    previous_trial_id uuid,
    reason_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
    evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    actor_type text NOT NULL,
    actor_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT trial_eligibility_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT trial_eligibility_risk_fk FOREIGN KEY (tenant_id, risk_assessment_id)
        REFERENCES security.risk_assessments (tenant_id, id),
    CONSTRAINT trial_eligibility_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT trial_eligibility_outcome_check CHECK (outcome IN ('ALLOW','ALLOW_RETRIAL','REVIEW','DENY')),
    CONSTRAINT trial_eligibility_actor_check CHECK (actor_type IN ('system','agent','human','external')),
    CONSTRAINT trial_eligibility_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX trial_eligibility_person_idx
    ON trial.trial_eligibility_decisions (tenant_id, person_id, created_at DESC);

CREATE TABLE trial.trials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    person_id uuid NOT NULL,
    lead_id uuid,
    previous_trial_id uuid,
    trial_kind text NOT NULL,
    retrial_reason text,
    lifecycle_status text NOT NULL DEFAULT 'REQUESTED',
    technical_outcome text NOT NULL DEFAULT 'PENDING',
    requested_duration_minutes integer NOT NULL,
    adult_content_enabled boolean NOT NULL DEFAULT false,
    provider_account_id uuid,
    provider_binding_id uuid,
    activated_at timestamptz,
    expires_at timestamptz,
    ended_at timestamptz,
    invalidated_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT trials_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT trials_lead_fk FOREIGN KEY (tenant_id, lead_id)
        REFERENCES crm.leads (tenant_id, id),
    CONSTRAINT trials_previous_fk FOREIGN KEY (tenant_id, previous_trial_id)
        REFERENCES trial.trials (tenant_id, id),
    CONSTRAINT trials_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT trials_kind_check CHECK (trial_kind IN ('TRIAL','RETRIAL')),
    CONSTRAINT trials_lifecycle_check CHECK (lifecycle_status IN ('REQUESTED','PROVISIONING','ACTIVE','ENDED','INVALIDATED','CANCELLED')),
    CONSTRAINT trials_technical_check CHECK (technical_outcome IN ('PENDING','PASSED','FAILED','INCONCLUSIVE')),
    CONSTRAINT trials_duration_positive CHECK (requested_duration_minutes > 0),
    CONSTRAINT trials_retrial_shape_check CHECK (
        (trial_kind = 'TRIAL' AND previous_trial_id IS NULL AND retrial_reason IS NULL)
        OR
        (trial_kind = 'RETRIAL' AND previous_trial_id IS NOT NULL AND retrial_reason IS NOT NULL AND btrim(retrial_reason) <> '')
    ),
    CONSTRAINT trials_activation_time_check CHECK (activated_at IS NULL OR expires_at IS NULL OR expires_at > activated_at),
    CONSTRAINT trials_tenant_id_id_unique UNIQUE (tenant_id, id)
);

-- A Person receives one primary Trial record. Any legitimate later exception is a RETRIAL.
CREATE UNIQUE INDEX trials_one_primary_per_person
    ON trial.trials (tenant_id, person_id)
    WHERE trial_kind = 'TRIAL';

-- Prevent concurrent free-access windows/races for the same Person.
CREATE UNIQUE INDEX trials_one_open_access_per_person
    ON trial.trials (tenant_id, person_id)
    WHERE lifecycle_status IN ('REQUESTED','PROVISIONING','ACTIVE');

CREATE INDEX trials_person_history_idx
    ON trial.trials (tenant_id, person_id, created_at DESC);
CREATE INDEX trials_active_expiry_idx
    ON trial.trials (tenant_id, expires_at)
    WHERE lifecycle_status = 'ACTIVE';

ALTER TABLE trial.trial_eligibility_decisions
    ADD CONSTRAINT trial_eligibility_previous_trial_fk
    FOREIGN KEY (tenant_id, previous_trial_id)
    REFERENCES trial.trials (tenant_id, id);

CREATE TABLE trial.trial_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    trial_id uuid NOT NULL,
    attempt_type text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    outcome text,
    error_code text,
    context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT trial_attempts_trial_fk FOREIGN KEY (tenant_id, trial_id)
        REFERENCES trial.trials (tenant_id, id),
    CONSTRAINT trial_attempts_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT trial_attempts_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX trial_attempts_trial_idx
    ON trial.trial_attempts (tenant_id, trial_id, started_at DESC);

CREATE TABLE trial.trial_technical_results (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    trial_id uuid NOT NULL,
    installation_success boolean,
    authentication_success boolean,
    playback_success boolean,
    buffering_observed boolean,
    summary_outcome text NOT NULL,
    assessed_at timestamptz NOT NULL DEFAULT now(),
    assessment_version text NOT NULL,
    CONSTRAINT trial_technical_trial_fk FOREIGN KEY (tenant_id, trial_id)
        REFERENCES trial.trials (tenant_id, id),
    CONSTRAINT trial_technical_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT trial_technical_summary_check CHECK (summary_outcome IN ('PENDING','PASSED','FAILED','INCONCLUSIVE')),
    CONSTRAINT trial_technical_one_per_trial UNIQUE (tenant_id, trial_id)
);

CREATE TABLE trial.device_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    person_id uuid NOT NULL,
    device_type text NOT NULL,
    manufacturer text,
    model text,
    os_name text,
    os_version text,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT device_profiles_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT device_profiles_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT device_profiles_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX device_profiles_person_idx
    ON trial.device_profiles (tenant_id, person_id, last_seen_at DESC);

CREATE TABLE trial.app_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid REFERENCES control.tenants(id),
    name text NOT NULL,
    platform text NOT NULL,
    version text,
    license_type text,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX app_profiles_lookup_idx
    ON trial.app_profiles (tenant_id, platform, name, version);

CREATE TABLE trial.network_observations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    person_id uuid NOT NULL,
    trial_id uuid,
    isp_name text,
    network_type text,
    ipv6_state text,
    dns_profile text,
    observed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT network_observations_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT network_observations_trial_fk FOREIGN KEY (tenant_id, trial_id)
        REFERENCES trial.trials (tenant_id, id),
    CONSTRAINT network_observations_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id)
);

CREATE INDEX network_observations_trial_idx
    ON trial.network_observations (tenant_id, trial_id, observed_at DESC)
    WHERE trial_id IS NOT NULL;

CREATE TABLE trial.compatibility_observations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    person_id uuid,
    trial_id uuid,
    device_profile_id uuid,
    app_profile_id uuid,
    provider_server_key text,
    network_context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    procedure_key text,
    outcome text NOT NULL,
    metrics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    observed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT compatibility_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT compatibility_trial_fk FOREIGN KEY (tenant_id, trial_id)
        REFERENCES trial.trials (tenant_id, id),
    CONSTRAINT compatibility_device_fk FOREIGN KEY (tenant_id, device_profile_id)
        REFERENCES trial.device_profiles (tenant_id, id),
    CONSTRAINT compatibility_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id)
);

CREATE INDEX compatibility_trial_idx
    ON trial.compatibility_observations (tenant_id, trial_id, observed_at DESC)
    WHERE trial_id IS NOT NULL;

COMMIT;
