-- AI Revenue & Operations Platform
-- Migration 039: Experiments instrumentation MVP (Wave 16)
--
-- Tenant-scoped experiment substrate (bounded context `experiments`):
-- - `experiments.experiments`: definition + lifecycle
--   (DRAFT/RUNNING/COMPLETED/STOPPED), arm/variant spec (jsonb),
--   primary metric ref + guardrail refs (read from the W14-A analytics
--   read-model, never written by experiments), minimum-evidence rule
--   (MVP: count-based, no invented statistics — POST-MVP stats stay out).
-- - `experiments.experiment_assignments`: deterministic assignment facts,
--   unique per (tenant, experiment, subject). Rows exist ONLY for
--   assignments made while RUNNING; fallback-to-control is a read-path
--   answer, never a persisted row.
-- - `experiments.experiment_exposures`: append-only exposure facts,
--   idempotent by (tenant, assignment, dedupe_key) so replays never
--   double-count.
-- F14: no FK FROM any domain table TO experiments, no trigger, no shared
-- write path — an unavailable experiments surface degrades (fail-open to
-- control) without ever blocking sale/payment/fulfillment.
-- Permission catalog extension (roll-forward INSERT-only, mirrors
-- `packages/auth/src/permissions.ts`): `experiments.read` (all tenant
-- roles), `experiments.write` (owner/admin/operator — operational
-- surface; pricing/discount decisions stay human-gated by design).

BEGIN;

CREATE SCHEMA IF NOT EXISTS experiments;

CREATE TABLE experiments.experiments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    experiment_key text NOT NULL,
    name text NOT NULL,
    hypothesis text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'DRAFT',
    arm_variant_spec_json jsonb NOT NULL DEFAULT '[]'::jsonb,
    assignment_version integer NOT NULL DEFAULT 1,
    primary_metric_ref text,
    guardrail_refs text[] NOT NULL DEFAULT ARRAY[]::text[],
    minimum_evidence_exposures integer NOT NULL DEFAULT 100,
    started_at timestamptz,
    ended_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT experiments_status_check CHECK (status IN ('DRAFT','RUNNING','COMPLETED','STOPPED')),
    CONSTRAINT experiments_key_not_blank CHECK (btrim(experiment_key) <> ''),
    CONSTRAINT experiments_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT experiments_assignment_version_positive CHECK (assignment_version >= 1),
    CONSTRAINT experiments_minimum_evidence_positive CHECK (minimum_evidence_exposures >= 1),
    CONSTRAINT experiments_key_unique UNIQUE (tenant_id, experiment_key),
    CONSTRAINT experiments_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX experiments_tenant_status_idx
    ON experiments.experiments (tenant_id, status);

CREATE TABLE experiments.experiment_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    experiment_id uuid NOT NULL,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    variant text NOT NULL,
    assignment_version integer NOT NULL,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT experiment_assignments_experiment_fk FOREIGN KEY (tenant_id, experiment_id)
        REFERENCES experiments.experiments (tenant_id, id),
    CONSTRAINT experiment_assignments_subject_check CHECK (subject_type IN ('PERSON','CUSTOMER','CONVERSATION','TENANT')),
    CONSTRAINT experiment_assignments_subject_not_blank CHECK (btrim(subject_id) <> ''),
    CONSTRAINT experiment_assignments_variant_not_blank CHECK (btrim(variant) <> ''),
    CONSTRAINT experiment_assignments_unique UNIQUE (tenant_id, experiment_id, subject_type, subject_id),
    CONSTRAINT experiment_assignments_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX experiment_assignments_experiment_variant_idx
    ON experiments.experiment_assignments (tenant_id, experiment_id, variant);

CREATE TABLE experiments.experiment_exposures (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    experiment_assignment_id uuid NOT NULL,
    exposure_point text NOT NULL,
    dedupe_key text NOT NULL,
    context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    exposed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT experiment_exposures_assignment_fk FOREIGN KEY (tenant_id, experiment_assignment_id)
        REFERENCES experiments.experiment_assignments (tenant_id, id),
    CONSTRAINT experiment_exposures_point_not_blank CHECK (btrim(exposure_point) <> ''),
    CONSTRAINT experiment_exposures_dedupe_not_blank CHECK (btrim(dedupe_key) <> ''),
    CONSTRAINT experiment_exposures_idempotent_unique UNIQUE (tenant_id, experiment_assignment_id, dedupe_key),
    CONSTRAINT experiment_exposures_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX experiment_exposures_assignment_idx
    ON experiments.experiment_exposures (tenant_id, experiment_assignment_id, exposed_at);

INSERT INTO control.permissions (key, description) VALUES
    ('experiments.read', 'Read experiments, assignments, exposures and aggregates'),
    ('experiments.write', 'Manage experiment lifecycle, assignments and exposures (never authorizes price/discount changes)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO control.role_permissions (role_key, permission_key) VALUES
    ('platform_admin', 'experiments.read'),
    ('platform_admin', 'experiments.write'),
    ('tenant_owner', 'experiments.read'),
    ('tenant_owner', 'experiments.write'),
    ('tenant_admin', 'experiments.read'),
    ('tenant_admin', 'experiments.write'),
    ('tenant_operator', 'experiments.read'),
    ('tenant_operator', 'experiments.write')
ON CONFLICT DO NOTHING;

COMMIT;
