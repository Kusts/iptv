-- 047 RLS rollout per domain: control.* + identity.* (append-only; never edit
-- 001/002/012). Template from 042: ENABLE ROW LEVEL SECURITY +
-- tenant_isolation policy (USING/WITH CHECK on app.tenant_id, fail-closed
-- when unset) + DML grants to iptv_app. Migrations keep running as the owner
-- role on a direct connection; the app connects as iptv_app (see runbook
-- docs/10-operations/runbooks/rls-role-split-cutover.md).
--
-- Scope inventory (real, from db/migrations):
--   identity (tenant-scoped, migration 002): persons, identities,
--     identity_merge_reviews. Every identity table carries `tenant_id uuid NOT
--     NULL`, so each gets the plain tenant template.
--   control (migrations 001 + 012): feature_flags (nullable tenant_id —
--     hybrid policy below), tenant_memberships + membership_roles
--     (tenant-scoped, see the PRE-CONTEXT caveat), and the global catalogs /
--     user-scoped auth tables.
--
-- GLOBAL TABLES — GRANT WITHOUT RLS (deliberate, nothing to isolate):
--   control.tenants, control.users, control.auth_credentials,
--   control.auth_sessions, control.roles, control.permissions,
--   control.role_permissions.
--   Rationale: none of these has a `tenant_id` ownership column, so the
--   `tenant_isolation` template has nothing to match. They are the
--   pre-context identity/authentication surface (`auth.ts` resolves session +
--   credential + membership state BEFORE any tenant context exists) plus the
--   GLOBAL RBAC catalogs, whose tenant scoping lives in the ASSIGNMENTS
--   (`tenant_memberships` / `membership_roles`), not in the catalogs
--   themselves. Enabling RLS with no tenant column could only ever
--   fail-closed every login. Isolation for these tables is enforced in the
--   application (row filters by `user_id` / `token_hash`) plus the catalog
--   invariants documented in migration 012 — RLS would add no tenant boundary
--   here, only an outage. They DO receive DML grants so `iptv_app` can run the
--   auth path after cutover.
--
-- PRE-CONTEXT CAVEAT (cutover blocker, NOT solved here):
--   `control.tenant_memberships` and `control.membership_roles` carry
--   `tenant_id uuid NOT NULL` but are read BEFORE any tenant context exists:
--   `auth.listMemberships` (login / resolveSession) filters by `user_id`
--   only, and `PermissionsGuard.findActiveMembership` /
--   `listExtraRoleKeys` run on the raw pool — outside
--   `withTenantTransaction`, so `app.tenant_id` is unset. Enrolling the plain
--   tenant template on them today would therefore make every login return
--   zero memberships and every guarded request 403: the auth path could never
--   establish the context it needs. They are granted but NOT RLS-enrolled
--   until a migration mirroring 043 (`communication.resolve_tenant_channel`)
--   exists for the membership lookups, or until the membership read moves
--   inside a tenant transaction. `db/tests/012` asserts this state explicitly
--   so the exception cannot silently grow.
--
-- FEATURE FLAGS (nullable tenant_id — hybrid policy):
--   `control.feature_flags.tenant_id` is NULLABLE: NULL = GLOBAL default
--   flag, non-NULL = tenant override. The read path
--   (`ExperimentsController.evaluateFlag`) resolves the tenant row first and
--   falls back to the GLOBAL row, so the policy must let a tenant read both
--   its own overrides and the global defaults:
--     USING      (tenant_id IS NULL OR tenant_id = <app.tenant_id>)
--     WITH CHECK (tenant_id = <app.tenant_id>)
--   The WITH CHECK side intentionally forbids the app role from CREATING or
--   OVERWRITING a GLOBAL (NULL tenant) flag: writes may only claim the
--   caller's own tenant, so global defaults stay an owner/operator concern.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iptv_app') THEN
        CREATE ROLE iptv_app LOGIN NOBYPASSRLS;
    END IF;
END $$;

GRANT USAGE ON SCHEMA control TO iptv_app;
GRANT USAGE ON SCHEMA identity TO iptv_app;

-- GLOBAL / user-scoped control tables: DML, no RLS (see header rationale).
GRANT SELECT, INSERT, UPDATE, DELETE ON control.tenants TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON control.users TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON control.auth_credentials TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON control.auth_sessions TO iptv_app;

-- GLOBAL RBAC catalogs: read-only. `packages/auth/src/permissions.ts` resolves
-- permissions from the compiled ROLE_PERMISSIONS map, so the runtime never
-- writes these; the catalogs are seeded by migrations (owner connection).
GRANT SELECT ON control.permissions TO iptv_app;
GRANT SELECT ON control.roles TO iptv_app;
GRANT SELECT ON control.role_permissions TO iptv_app;

-- Tenant-scoped control tables: grants now, RLS deferred (pre-context caveat).
GRANT SELECT, INSERT, UPDATE, DELETE ON control.tenant_memberships TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON control.membership_roles TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON control.feature_flags TO iptv_app;

-- identity.*: full DML behind the tenant policy (mirrors 042's tenant tables).
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.persons TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.identities TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.identity_merge_reviews TO iptv_app;

ALTER TABLE identity.persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.identity_merge_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.feature_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON identity.persons;
CREATE POLICY tenant_isolation ON identity.persons
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON identity.identities;
CREATE POLICY tenant_isolation ON identity.identities
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON identity.identity_merge_reviews;
CREATE POLICY tenant_isolation ON identity.identity_merge_reviews
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Hybrid: reads see GLOBAL defaults + the caller's own tenant overrides;
-- writes may only claim the caller's own tenant (never a GLOBAL row).
DROP POLICY IF EXISTS tenant_isolation ON control.feature_flags;
CREATE POLICY tenant_isolation ON control.feature_flags
    USING (tenant_id IS NULL OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;