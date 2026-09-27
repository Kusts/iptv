-- AI Revenue & Operations Platform
-- Migration 017: Wave 4 Trial/Provider effect certainty + command permissions
--
-- Design notes:
-- - `provider.provider_operations` gains the orthogonal effect certainty
--   (`KNOWN_APPLIED | KNOWN_NOT_APPLIED | UNKNOWN`, default `UNKNOWN`) that
--   the canonical state machine requires alongside the lifecycle statuses
--   from migration 007. The status/certainty coherence shape mirrors
--   `billing.refunds`: SUCCEEDED implies KNOWN_APPLIED; FAILED/CANCELLED
--   imply KNOWN_NOT_APPLIED; every in-flight status implies UNKNOWN. An
--   uncertain external effect reconciles (VERIFYING + readback) before any
--   retry — never blind retry.
-- - Wave 4 command permission catalog extension (roll-forward INSERT-only,
--   mirrors `packages/auth/src/permissions.ts` ROLE_PERMISSIONS).
-- - No Postgres ENUM types: all constrained text uses CHECK constraints.

BEGIN;

ALTER TABLE provider.provider_operations
    ADD COLUMN effect_certainty text NOT NULL DEFAULT 'UNKNOWN';

ALTER TABLE provider.provider_operations
    ADD CONSTRAINT provider_operations_effect_check
    CHECK (effect_certainty IN ('KNOWN_APPLIED','KNOWN_NOT_APPLIED','UNKNOWN'));

ALTER TABLE provider.provider_operations
    ADD CONSTRAINT provider_operations_effect_status_shape_check CHECK (
        (status = 'SUCCEEDED' AND effect_certainty = 'KNOWN_APPLIED')
        OR
        (status IN ('FAILED','CANCELLED') AND effect_certainty = 'KNOWN_NOT_APPLIED')
        OR
        (status IN ('REQUESTED','QUEUED','RUNNING','VERIFYING','RETRY_WAIT','HUMAN_REQUIRED') AND effect_certainty = 'UNKNOWN')
    );

INSERT INTO control.permissions (key, description) VALUES
    ('trial.read', 'Read trials, technical results and compatibility observations'),
    ('trial.write', 'Request and manage trials and compatibility observations'),
    ('provider.operation.read', 'Read provider operations'),
    ('provider.operation.write', 'Request, resolve and reconcile provider operations')
ON CONFLICT (key) DO NOTHING;

INSERT INTO control.role_permissions (role_key, permission_key) VALUES
    ('platform_admin', 'trial.read'),
    ('platform_admin', 'trial.write'),
    ('platform_admin', 'provider.operation.read'),
    ('platform_admin', 'provider.operation.write'),
    ('tenant_owner', 'trial.read'),
    ('tenant_owner', 'trial.write'),
    ('tenant_owner', 'provider.operation.read'),
    ('tenant_owner', 'provider.operation.write'),
    ('tenant_admin', 'trial.read'),
    ('tenant_admin', 'trial.write'),
    ('tenant_admin', 'provider.operation.read'),
    ('tenant_admin', 'provider.operation.write'),
    ('tenant_operator', 'trial.read'),
    ('tenant_operator', 'trial.write')
ON CONFLICT DO NOTHING;

COMMIT;
