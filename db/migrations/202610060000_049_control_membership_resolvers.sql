-- 049 Control membership resolvers + RLS enrollment (append-only; never edit
-- 001/002/012/047). Closes the 047 pre-context caveat via the certified 043
-- pattern (`communication.resolve_tenant_channel`): `control.tenant_memberships`
-- and `control.membership_roles` are read BEFORE any tenant context exists
-- (`auth.listMemberships` on the login/resolveSession path, the `setActiveTenant`
-- switch check, `PermissionsGuard` on every guarded request), so under `iptv_app`
-- a plain tenant policy would fail-close every login to zero memberships.
-- This migration adds THREE narrow escape hatches, all owner-held,
-- SECURITY DEFINER, fixed `search_path`, revoked from PUBLIC, EXECUTE granted
-- to `iptv_app` only, touching NO table outside the control membership graph:
--   * `control.list_memberships_for_session(p_token_hash)` — the exact columns
--     `auth.listMemberships` consumes today (tenant id/slug/name, role, status),
--     bound to the opaque session token hash (never the raw token): join
--     `auth_sessions -> tenant_memberships -> tenants`, session unexpired,
--     user ACTIVE, memberships in ALL statuses (full parity with the pre-049
--     `auth.listMemberships`, whose rows carried non-ACTIVE statuses filtered
--     at the login call site via `.find()`; the switch/guard resolvers below
--     stay ACTIVE-only). Unknown or expired tokens yield zero rows; a session
--     never yields another tenant's rows beyond the caller's own memberships.
--     The `user_id`-parameterized variant is deliberately NOT provided (it
--     would allow membership enumeration by any app-role caller).
--   * `control.check_membership_active(p_user_id, p_tenant_id)` — single
--     EXISTS, ACTIVE-membership AND ACTIVE-user gated, for the `setActiveTenant`
--     switch check (closes the suspended-user oracle at the DB layer).
--   * `control.resolve_membership_roles(p_user_id, p_tenant_id)` — ONE row
--     (membership id, base role key, extra role keys array) for the ACTIVE
--     membership of the pair of an ACTIVE user, zero rows otherwise. A single
--     function (not a check+keys pair) keeps the hot guarded-request path to
--     one round trip; the guard adapts it into the existing `MembershipLoader`
--     contract, so `packages/auth` needs no interface change.
-- Then both tables are RLS-enrolled with the plain 042/047 `tenant_isolation`
-- template (`USING`/`WITH CHECK` on `app.tenant_id`, fail-closed when unset).
-- GRANT surface is UNCHANGED (047 already granted full DML to `iptv_app`).
-- The three membership INSERT paths acquire tenant context equal to the row
-- being created (register, `POST /v1/tenants`, partners provision) in the
-- same change, so `WITH CHECK` passes there.
--
-- ATOMIC-PAIR INVARIANT: this migration MUST land in the same commit as the
-- resolver call-site swaps; enrolling without the swaps breaks
-- login->switch->all guarded routes (see runbook analysis 2026-10-06).
-- Migrations keep running as the owner role on a direct connection.
BEGIN;

CREATE OR REPLACE FUNCTION control.list_memberships_for_session(p_token_hash text)
RETURNS TABLE (
    tenant_id uuid,
    tenant_slug text,
    tenant_name text,
    role_key text,
    status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = control, pg_temp
AS $$
    SELECT m.tenant_id, t.slug, t.name, m.role_key, m.status
    FROM control.auth_sessions AS s
    JOIN control.users AS u ON u.id = s.user_id
    JOIN control.tenant_memberships AS m ON m.user_id = s.user_id
    JOIN control.tenants AS t ON t.id = m.tenant_id
    WHERE s.token_hash = p_token_hash
      AND s.expires_at > now()
      AND u.status = 'ACTIVE'
    ORDER BY t.created_at ASC;
$$;

CREATE OR REPLACE FUNCTION control.check_membership_active(p_user_id uuid, p_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = control, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM control.tenant_memberships AS m
        WHERE m.user_id = p_user_id
          AND m.tenant_id = p_tenant_id
          AND m.status = 'ACTIVE'
          AND EXISTS (SELECT 1 FROM control.users u WHERE u.id = p_user_id AND u.status = 'ACTIVE')
    );
$$;

CREATE OR REPLACE FUNCTION control.resolve_membership_roles(p_user_id uuid, p_tenant_id uuid)
RETURNS TABLE (
    membership_id uuid,
    base_role_key text,
    extra_role_keys text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = control, pg_temp
AS $$
    SELECT m.id,
           m.role_key,
           COALESCE((
               SELECT array_agg(r.role_key ORDER BY r.role_key)
               FROM control.membership_roles AS r
               WHERE r.membership_id = m.id
                 AND r.tenant_id = m.tenant_id
           ), '{}'::text[])
    FROM control.tenant_memberships AS m
    WHERE m.user_id = p_user_id
      AND m.tenant_id = p_tenant_id
      AND m.status = 'ACTIVE'
      AND EXISTS (SELECT 1 FROM control.users u WHERE u.id = p_user_id AND u.status = 'ACTIVE')
    LIMIT 1;
$$;

-- Fixed owner: the migration (owner) role must own the definer functions,
-- otherwise the RLS bypass runs with the wrong identity. The runner connects
-- as the owner, so this is a no-op in the normal path and a hard guarantee
-- after privileged restores (043 pattern).
DO $$
DECLARE
    v_owner name;
BEGIN
    SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'control' AND c.relname = 'tenant_memberships';
    IF v_owner IS NOT NULL THEN
        EXECUTE format(
            'ALTER FUNCTION control.list_memberships_for_session(text) OWNER TO %I',
            v_owner
        );
        EXECUTE format(
            'ALTER FUNCTION control.check_membership_active(uuid, uuid) OWNER TO %I',
            v_owner
        );
        EXECUTE format(
            'ALTER FUNCTION control.resolve_membership_roles(uuid, uuid) OWNER TO %I',
            v_owner
        );
    END IF;
END $$;

REVOKE ALL ON FUNCTION control.list_memberships_for_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.list_memberships_for_session(text) TO iptv_app;

REVOKE ALL ON FUNCTION control.check_membership_active(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.check_membership_active(uuid, uuid) TO iptv_app;

REVOKE ALL ON FUNCTION control.resolve_membership_roles(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.resolve_membership_roles(uuid, uuid) TO iptv_app;

-- Enrollment: plain tenant template (042/047 shape), fail-closed when unset.
ALTER TABLE control.tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.membership_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON control.tenant_memberships;
CREATE POLICY tenant_isolation ON control.tenant_memberships
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON control.membership_roles;
CREATE POLICY tenant_isolation ON control.membership_roles
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
