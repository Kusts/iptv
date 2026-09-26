-- AI Revenue & Operations Platform
-- Migration 014: Policy/Configuration + Capability/Tool Registry foundation (W1-09/W1-10)
--
-- Design notes:
-- - `platform.capabilities` is a GLOBAL catalog (platform-owned, like
--   `control.roles`): no tenant_id. Tenant scoping lives in the RESOLUTION
--   (actor + tenant policy), never in the capability row itself.
-- - `platform.capability_events` is append-only (availability/certification
--   change log) via the shared `reject_append_only_mutation` trigger.
-- - `platform.policy_documents` stores generic jsonb family documents with
--   versioned rows: publishing a new version = new row with version+1.
--   PUBLISHED/RETIRED rows are IMMUTABLE (update-guard trigger); only DRAFT
--   rows may change. RETIRED rows keep history (terminal markers).
-- - scope/class coherence is enforced in SQL: PLATFORM_INVARIANT and
--   PLATFORM_POLICY <=> PLATFORM scope (tenant_id IS NULL); TENANT_POLICY
--   <=> TENANT scope; PARTNER_POLICY <=> PARTNER scope (tenant_id NOT NULL).
-- - RUNTIME_FACT is observed state and is NEVER stored here.
-- - No Postgres ENUM types: all constrained text uses CHECK constraints.

BEGIN;

CREATE TABLE platform.capabilities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key text NOT NULL,
    owner_context text NOT NULL,
    availability text NOT NULL DEFAULT 'AVAILABLE',
    certification_status text NOT NULL DEFAULT 'UNCERTIFIED',
    risk_level text NOT NULL DEFAULT 'LOW',
    mvp_phase text NOT NULL DEFAULT '',
    manual_equivalent text NOT NULL DEFAULT '',
    policy_family text NOT NULL,
    degradation text NOT NULL DEFAULT '',
    permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT capabilities_key_not_blank CHECK (btrim(key) <> ''),
    CONSTRAINT capabilities_owner_not_blank CHECK (btrim(owner_context) <> ''),
    CONSTRAINT capabilities_family_not_blank CHECK (btrim(policy_family) <> ''),
    CONSTRAINT capabilities_key_unique UNIQUE (key),
    CONSTRAINT capabilities_availability_check CHECK (availability IN ('AVAILABLE','DEGRADED','UNAVAILABLE')),
    CONSTRAINT capabilities_certification_check CHECK (certification_status IN ('UNCERTIFIED','SANDBOX_CERTIFIED','CERTIFIED')),
    CONSTRAINT capabilities_risk_check CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL'))
);

CREATE TABLE platform.capability_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    capability_key text NOT NULL,
    from_availability text,
    to_availability text NOT NULL,
    reason text NOT NULL DEFAULT '',
    actor_id text,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT capability_events_to_check CHECK (to_availability IN ('AVAILABLE','DEGRADED','UNAVAILABLE')),
    CONSTRAINT capability_events_from_check CHECK (from_availability IS NULL OR from_availability IN ('AVAILABLE','DEGRADED','UNAVAILABLE'))
);

CREATE INDEX capability_events_key_idx
    ON platform.capability_events (capability_key, occurred_at DESC);

CREATE TRIGGER capability_events_append_only
BEFORE UPDATE OR DELETE ON platform.capability_events
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

CREATE TABLE platform.policy_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid REFERENCES control.tenants(id),
    family text NOT NULL,
    scope text NOT NULL,
    class text NOT NULL,
    version integer NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT',
    document jsonb NOT NULL DEFAULT '{}'::jsonb,
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT policy_documents_family_not_blank CHECK (btrim(family) <> ''),
    CONSTRAINT policy_documents_scope_check CHECK (scope IN ('PLATFORM','TENANT','PARTNER')),
    CONSTRAINT policy_documents_class_check CHECK (class IN ('PLATFORM_INVARIANT','PLATFORM_POLICY','TENANT_POLICY','PARTNER_POLICY')),
    CONSTRAINT policy_documents_status_check CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
    CONSTRAINT policy_documents_version_positive CHECK (version > 0),
    CONSTRAINT policy_documents_scope_class_match CHECK (
        (class = 'PLATFORM_INVARIANT' AND scope = 'PLATFORM')
        OR (class = 'PLATFORM_POLICY' AND scope = 'PLATFORM')
        OR (class = 'TENANT_POLICY' AND scope = 'TENANT')
        OR (class = 'PARTNER_POLICY' AND scope = 'PARTNER')
    ),
    CONSTRAINT policy_documents_tenant_scope_match CHECK (
        (scope = 'PLATFORM' AND tenant_id IS NULL)
        OR ((scope = 'TENANT' OR scope = 'PARTNER') AND tenant_id IS NOT NULL)
    ),
    CONSTRAINT policy_documents_published_at_match CHECK (
        (status = 'DRAFT' AND published_at IS NULL)
        OR (status IN ('PUBLISHED','RETIRED') AND published_at IS NOT NULL)
    ),
    CONSTRAINT policy_documents_tenant_family_version_unique UNIQUE (tenant_id, family, version)
);

-- Platform rows all carry tenant_id IS NULL, which the UNIQUE above cannot
-- isolate (NULLs never compare equal); this partial index scopes the
-- (family, version) uniqueness to the platform catalog instead.
CREATE UNIQUE INDEX policy_documents_platform_family_version_unique
    ON platform.policy_documents (family, version)
    WHERE tenant_id IS NULL;

CREATE INDEX policy_documents_lookup_idx
    ON platform.policy_documents (family, scope, status, version DESC);

-- Published/retired versions are immutable history: only DRAFT rows may be
-- updated or deleted. Publishing = insert a new row with version+1.
CREATE OR REPLACE FUNCTION platform.reject_published_policy_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status IN ('PUBLISHED','RETIRED') THEN
        RAISE EXCEPTION 'policy_documents row % v% is immutable once %', OLD.family, OLD.version, OLD.status;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER policy_documents_published_immutable
BEFORE UPDATE OR DELETE ON platform.policy_documents
FOR EACH ROW EXECUTE FUNCTION platform.reject_published_policy_mutation();

COMMIT;
