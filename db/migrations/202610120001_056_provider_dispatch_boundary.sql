-- 056 Provider dispatch boundary: GLOBAL providers + hybrid app_profiles +
-- dispatcher claim/recover/reconcile functions (append-only; never edit
-- 001-055).
--
-- SCOPE (P1.4 slice 056; closes the two 055 allow-list exceptions):
--   * `provider.providers` — GLOBAL catalog (no `tenant_id` column at all):
--     GRANT SELECT + INSERT to `iptv_app` WITHOUT RLS (047 precedent: the
--     GLOBAL control tables and RBAC catalogs receive grants, never the
--     tenant template — RLS with no ownership column could only fail-close
--     every read). INSERT (not full DML) is the documented minimum: the
--     runtime `ensureTrialProviderAccount` find-or-create path
--     (`trial-store.ts`) SELECTs `provider_key = 'cinevision'` and INSERTs
--     the singleton when absent; no runtime path UPDATEs or DELETEs a
--     catalog row, so those stay owner-only.
--   * `trial.app_profiles` — HYBRID (`tenant_id` NULLABLE): RLS-enrolled
--     with per-command policies (owner-only writes on shared rows) —
--       SELECT: USING (tenant_id IS NULL OR tenant_id = <app.tenant_id>)
--         (keeps the `tenant_isolation` name so the 022 allow-list, which
--         asserts that name + NULL-tolerant USING, stays green unmodified)
--       INSERT: WITH CHECK (tenant_id = <app.tenant_id>)
--       UPDATE: USING (tenant_id = <app.tenant_id>)
--               WITH CHECK (tenant_id = <app.tenant_id>)
--       DELETE: USING (tenant_id = <app.tenant_id>)
--     so a tenant reads shared (NULL) + own rows, while writes touch only
--     the caller's own rows: shared rows are read-only for tenants
--     (creating, claiming, or deleting a shared row stays an owner/operator
--     concern). Full DML grants to `iptv_app`.
--   * BACKFILL-vs-HYBRID DECISION (evidence, 2026-10-07): NO backfill.
--     `handleRecordAppProfile` (`trial.commands.ts`) always persists
--     `tenant_id = ctx.tenantId`; `db/seeds` and `apps/api/test` contain
--     ZERO `app_profiles` inserts, so no application path can have produced
--     legacy NULL rows — NULL rows are only possible from manual/operator
--     inserts, which the hybrid policy deliberately keeps readable as
--     shared. The read site (`handleRecordObservation`) already treats NULL
--     as shared (`app.tenant_id !== null && <> ctx` rejects), so no
--     command-path change is needed.
--   * THREE narrow dispatcher functions, owner-held, SECURITY DEFINER,
--     pinned `search_path`, REVOKE PUBLIC, EXECUTE to `iptv_app` ONLY
--     (043/049/054 precedent) — the ONLY cross-tenant reads the scheduler
--     tick and the admin drain may perform:
--       - `provider.dispatch_claim(p_limit, p_lease_secs, p_claimed_by)`:
--         the global claim (REQUESTED + unclaimed + `secret-required-v1`
--         provenance, oldest first, `FOR UPDATE SKIP LOCKED`), atomically
--         promoting to QUEUED with `claimed_by`/`claimed_at`/`lease_expires_at`
--         and returning (operation id, tenant id) so the caller never
--         SELECTs back. Fencing preserved: every acquisition mints a fresh
--         `claimed_by` token (045 `claimed_by` text column, no new column).
--       - `provider.dispatch_expired_list(p_limit)`: READ-ONLY detection for
--         expired-lease QUEUED/RUNNING rows (id, tenant, status, frontier
--         polarity). Pure SELECT — calling it never moves any row; the
--         decision stays the conditional UPDATE's WHERE in `recoverOnce`.
--       - `provider.dispatch_verifying_list(p_limit)`: READ-ONLY candidate
--         list for VERIFYING secret-required `trial.provision` rows with the
--         columns `reconcileOnce` needs. Same read-only contract.
--     Each function touches NOTHING outside `provider.provider_operations`.
--
-- ATOMIC-PAIR INVARIANT: the 055 enrollment of `provider.provider_operations`
-- (tenant template) WITHOUT these functions stalls the dispatcher silently
-- under `iptv_app` (global claim SELECT fail-closes to 0 rows); the functions
-- WITHOUT the enrollment would leak cross-tenant rows. 055 + 056 land the
-- pair across the slice boundary, and the service swaps (same change) move
-- `drainOnce`/`recoverOnce`/`reconcileOnce` onto the functions — enrolling
-- without the pair is PROHIBITED (see runbook analysis 2026-10-06).
-- Per-tenant follow-up reads inside `dispatchOne` (operation load, trial-gate
-- account check, `secret_ref` load) run inside `withTenantTransaction` for
-- the claimed tenant instead — they need no function. `platform.capabilities`
-- reads stay direct: GLOBAL catalog, no RLS by 014 design (asserted in 019),
-- full DML grants already in 053.
--
-- Deliberately NOT in this migration:
--   * No BYPASSRLS anywhere; no grants to `outbox_worker`/`outbox_executor`
--     (their 050 EXECUTE-only boundary is asserted, not widened).
--   * No GRANT to PUBLIC; no UPDATE/DELETE on `provider.providers` to
--     `iptv_app` (owner-only catalog mutation).
--   * No change to the 055-enrolled tables, policies, or grants.
-- Migrations keep running as the owner role on a direct connection.
BEGIN;

-- GLOBAL catalog: minimal DML for the runtime find-or-create path, no RLS
-- (no tenant_id column exists to isolate on).
GRANT SELECT, INSERT ON provider.providers TO iptv_app;

-- Hybrid shared catalog: full DML behind per-command policies. SELECT stays
-- NULL-tolerant (shared + own visible); INSERT/UPDATE/DELETE are owner-only
-- (shared rows are read-only for tenants — no minting, claiming, migrating,
-- or deleting shared rows through the app role).
GRANT SELECT, INSERT, UPDATE, DELETE ON trial.app_profiles TO iptv_app;

ALTER TABLE trial.app_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON trial.app_profiles;
DROP POLICY IF EXISTS tenant_isolation_select ON trial.app_profiles;
DROP POLICY IF EXISTS tenant_isolation_insert ON trial.app_profiles;
DROP POLICY IF EXISTS tenant_isolation_update ON trial.app_profiles;
DROP POLICY IF EXISTS tenant_isolation_delete ON trial.app_profiles;
CREATE POLICY tenant_isolation ON trial.app_profiles FOR SELECT
    USING (tenant_id IS NULL OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON trial.app_profiles FOR INSERT
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON trial.app_profiles FOR UPDATE
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON trial.app_profiles FOR DELETE
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Global dispatch claim: exactly the `drainOnce` acquisition, moved behind
-- the definer so the tenant-agnostic scheduler/admin paths claim disjoint
-- sets under `iptv_app` exactly as they do as owner. Non-secret provenance
-- rows never match (same `adapter_version` filter as the service).
CREATE OR REPLACE FUNCTION provider.dispatch_claim(
    p_limit integer,
    p_lease_secs integer,
    p_claimed_by text
)
RETURNS TABLE (o_operation_id uuid, o_tenant_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = provider, pg_temp
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'dispatch_claim: p_limit must be between 1 and 100';
    END IF;
    IF p_lease_secs IS NULL OR p_lease_secs < 1 OR p_lease_secs > 3600 THEN
        RAISE EXCEPTION 'dispatch_claim: p_lease_secs must be between 1 and 3600';
    END IF;
    IF p_claimed_by IS NULL OR btrim(p_claimed_by) = '' THEN
        RAISE EXCEPTION 'dispatch_claim: p_claimed_by must be non-blank';
    END IF;

    -- The CTE lock is the concurrency fix (054 claim precedent):
    -- concurrent drains serialize on the same REQUESTED rows and SKIP LOCKED
    -- hands each drain a disjoint set, so two drains never dispatch the same
    -- operation. The outer UPDATE is the REQUESTED -> QUEUED transition with
    -- the 045 lease stamped; terminal rows are never matched.
    RETURN QUERY
    WITH c AS (
        SELECT q.id
        FROM provider.provider_operations AS q
        WHERE q.status = 'REQUESTED'
          AND q.claimed_by IS NULL
          AND q.adapter_version = 'secret-required-v1'
        ORDER BY q.requested_at ASC, q.id ASC
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    UPDATE provider.provider_operations AS m
    SET status = 'QUEUED',
        claimed_by = p_claimed_by,
        claimed_at = now(),
        lease_expires_at = now() + make_interval(secs => p_lease_secs)
    FROM c
    WHERE m.id = c.id
    RETURNING m.id, m.tenant_id;
END;
$$;

-- Expired-lease detection (recoverOnce candidate list). READ-ONLY by
-- construction: a pure SELECT over in-flight rows whose lease lapsed, oldest
-- lease first. Calling it NEVER moves, releases, or parks any row — the
-- pre-send requeue vs post-send VERIFYING decision stays the conditional
-- UPDATE's WHERE + affected-rows check in the service.
CREATE OR REPLACE FUNCTION provider.dispatch_expired_list(
    p_limit integer
)
RETURNS TABLE (
    o_operation_id uuid,
    o_tenant_id uuid,
    o_status text,
    o_started boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = provider, pg_temp
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'dispatch_expired_list: p_limit must be between 1 and 500';
    END IF;

    RETURN QUERY
    SELECT m.id, m.tenant_id, m.status,
        (m.dispatch_started_at IS NOT NULL)
    FROM provider.provider_operations AS m
    WHERE m.status IN ('QUEUED', 'RUNNING')
      AND m.claimed_by IS NOT NULL
      AND m.lease_expires_at IS NOT NULL
      AND m.lease_expires_at <= now()
    ORDER BY m.lease_expires_at ASC, m.id ASC
    LIMIT p_limit;
END;
$$;

-- VERIFYING reconcile candidates (reconcileOnce candidate list). READ-ONLY
-- by construction: only secret-required `trial.provision` rows in VERIFYING,
-- oldest first, with the columns the bounded readback + CAS-fenced outcome
-- need. Synthetic rows and other actions never match.
CREATE OR REPLACE FUNCTION provider.dispatch_verifying_list(
    p_limit integer
)
RETURNS TABLE (
    o_operation_id uuid,
    o_tenant_id uuid,
    o_provider_account_id uuid,
    o_entity_id uuid,
    o_requested_payload jsonb,
    o_adapter_version text,
    o_result_summary jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = provider, pg_temp
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'dispatch_verifying_list: p_limit must be between 1 and 500';
    END IF;

    RETURN QUERY
    SELECT m.id, m.tenant_id, m.provider_account_id, m.entity_id,
        m.requested_payload_json, m.adapter_version, m.result_summary_json
    FROM provider.provider_operations AS m
    WHERE m.status = 'VERIFYING'
      AND m.adapter_version = 'secret-required-v1'
      AND m.action = 'trial.provision'
      AND m.entity_type = 'trial'
    ORDER BY m.requested_at ASC, m.id ASC
    LIMIT p_limit;
END;
$$;

-- Fixed owner (043/049/053/054 pattern): the migration (owner) role must own
-- the definer functions, otherwise the bypass runs with the wrong identity.
DO $$
DECLARE
    v_owner name;
BEGIN
    SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'provider' AND c.relname = 'provider_operations';
    IF v_owner IS NOT NULL THEN
        EXECUTE format(
            'ALTER FUNCTION provider.dispatch_claim(integer, integer, text) OWNER TO %I',
            v_owner
        );
        EXECUTE format(
            'ALTER FUNCTION provider.dispatch_expired_list(integer) OWNER TO %I',
            v_owner
        );
        EXECUTE format(
            'ALTER FUNCTION provider.dispatch_verifying_list(integer) OWNER TO %I',
            v_owner
        );
    END IF;
END $$;

REVOKE ALL ON FUNCTION provider.dispatch_claim(integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provider.dispatch_claim(integer, integer, text) TO iptv_app;

REVOKE ALL ON FUNCTION provider.dispatch_expired_list(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provider.dispatch_expired_list(integer) TO iptv_app;

REVOKE ALL ON FUNCTION provider.dispatch_verifying_list(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provider.dispatch_verifying_list(integer) TO iptv_app;

-- Install verification (same transaction: any failure rolls EVERYTHING back).
DO $$
DECLARE
    v_fn text;
    v_owner name;
BEGIN
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'iptv_app') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'migration 056 refused: app role iptv_app must exist with NOBYPASSRLS';
    END IF;

    -- GLOBAL providers: no RLS by design, minimal SELECT+INSERT surface.
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'provider.providers'::regclass) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'migration 056 refused: provider.providers must stay without RLS (GLOBAL catalog)';
    END IF;
    IF has_table_privilege('iptv_app', 'provider.providers', 'SELECT') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'provider.providers', 'INSERT') IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'migration 056 refused: iptv_app needs SELECT+INSERT on provider.providers (ensure-path)';
    END IF;
    IF has_table_privilege('iptv_app', 'provider.providers', 'UPDATE') IS DISTINCT FROM false
        OR has_table_privilege('iptv_app', 'provider.providers', 'DELETE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'migration 056 refused: iptv_app must NOT hold UPDATE/DELETE on provider.providers (owner-only catalog mutation)';
    END IF;

    -- Hybrid app_profiles: RLS + per-command policies + full DML.
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'trial.app_profiles'::regclass) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'migration 056 refused: RLS is not enabled on trial.app_profiles';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'trial' AND tablename = 'app_profiles'
          AND policyname = 'tenant_isolation' AND cmd = 'SELECT'
    ) THEN
        RAISE EXCEPTION 'migration 056 refused: tenant_isolation SELECT policy missing on trial.app_profiles';
    END IF;
    IF (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'trial' AND tablename = 'app_profiles'
          AND policyname IN ('tenant_isolation_insert', 'tenant_isolation_update', 'tenant_isolation_delete')
    ) <> 3 THEN
        RAISE EXCEPTION 'migration 056 refused: per-command write policies missing on trial.app_profiles';
    END IF;
    -- No FOR ALL policy may remain: it would OR its NULL-tolerant USING
    -- into UPDATE/DELETE and reopen shared-row writes.
    IF EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'trial' AND tablename = 'app_profiles'
          AND cmd = '*'
    ) THEN
        RAISE EXCEPTION 'migration 056 refused: FOR ALL policy on trial.app_profiles would reopen shared-row writes (use per-command policies)';
    END IF;
    IF (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polname = 'tenant_isolation'
        AND polrelid = 'trial.app_profiles'::regclass) NOT ILIKE '%IS NULL%' THEN
        RAISE EXCEPTION 'migration 056 refused: app_profiles SELECT USING must stay NULL-tolerant (shared rows visible)';
    END IF;
    -- UPDATE/DELETE USING must be owner-only (no IS NULL): shared rows are
    -- read-only for tenants.
    IF (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polname = 'tenant_isolation_update'
        AND polrelid = 'trial.app_profiles'::regclass) ILIKE '%IS NULL%' THEN
        RAISE EXCEPTION 'migration 056 refused: app_profiles UPDATE USING must be owner-only (shared rows not writable)';
    END IF;
    IF (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polname = 'tenant_isolation_delete'
        AND polrelid = 'trial.app_profiles'::regclass) ILIKE '%IS NULL%' THEN
        RAISE EXCEPTION 'migration 056 refused: app_profiles DELETE USING must be owner-only (shared rows not writable)';
    END IF;
    -- INSERT/UPDATE WITH CHECK must pin the caller tenant (no IS NULL):
    -- minting shared rows or migrating rows across tenants is refused.
    IF (SELECT pg_get_expr(polwithcheck, polrelid) FROM pg_policy WHERE polname = 'tenant_isolation_insert'
        AND polrelid = 'trial.app_profiles'::regclass) ILIKE '%IS NULL%' THEN
        RAISE EXCEPTION 'migration 056 refused: app_profiles INSERT WITH CHECK must pin own tenant (no shared minting)';
    END IF;
    IF (SELECT pg_get_expr(polwithcheck, polrelid) FROM pg_policy WHERE polname = 'tenant_isolation_update'
        AND polrelid = 'trial.app_profiles'::regclass) ILIKE '%IS NULL%' THEN
        RAISE EXCEPTION 'migration 056 refused: app_profiles UPDATE WITH CHECK must pin own tenant (no cross-tenant migration)';
    END IF;
    IF has_table_privilege('iptv_app', 'trial.app_profiles', 'SELECT') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'trial.app_profiles', 'INSERT') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'trial.app_profiles', 'UPDATE') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'trial.app_profiles', 'DELETE') IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'migration 056 refused: app role lacks full DML grants on trial.app_profiles';
    END IF;

    -- Functions: SECURITY DEFINER, pinned search_path, owner-held,
    -- EXECUTE iptv_app-only (plus tolerated owner entries), never PUBLIC,
    -- never the outbox lifecycle roles.
    SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class AS c WHERE c.oid = 'provider.provider_operations'::regclass;
    FOR v_fn IN
        SELECT unnest(ARRAY[
            'provider.dispatch_claim(integer, integer, text)',
            'provider.dispatch_expired_list(integer)',
            'provider.dispatch_verifying_list(integer)'
        ])
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_proc AS p WHERE p.oid = v_fn::regprocedure) THEN
            RAISE EXCEPTION 'migration 056 refused: % is missing', v_fn;
        END IF;
        IF EXISTS (
            SELECT 1 FROM pg_proc AS p
            WHERE p.oid = v_fn::regprocedure
              AND (p.prosecdef IS DISTINCT FROM true
                    OR p.proconfig IS DISTINCT FROM ARRAY['search_path=provider, pg_temp'])
        ) THEN
            RAISE EXCEPTION 'migration 056 refused: % must stay SECURITY DEFINER with pinned search_path', v_fn;
        END IF;
        IF EXISTS (
            SELECT 1 FROM pg_proc AS p
            WHERE p.oid = v_fn::regprocedure
              AND pg_get_userbyid(p.proowner) IS DISTINCT FROM v_owner
        ) THEN
            RAISE EXCEPTION 'migration 056 refused: % must be owned by the migration owner (not a lifecycle role)', v_fn;
        END IF;
        IF EXISTS (
            SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS a
            WHERE p.oid = v_fn::regprocedure
              AND NOT ((a.grantee = p.proowner)
                    OR (a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'iptv_app')
                        AND a.privilege_type = 'EXECUTE'
                        AND NOT a.is_grantable))
        ) THEN
            RAISE EXCEPTION 'migration 056 refused: % carries an unexpected grant (only iptv_app=EXECUTE without grant option is allowed)', v_fn;
        END IF;
        IF (SELECT p.proacl::text FROM pg_proc AS p WHERE p.oid = v_fn::regprocedure) ~ '([,{])=X/' THEN
            RAISE EXCEPTION 'migration 056 refused: % is still executable by PUBLIC', v_fn;
        END IF;
        IF has_function_privilege('outbox_worker', v_fn, 'EXECUTE') IS DISTINCT FROM false THEN
            RAISE EXCEPTION 'migration 056 refused: outbox_worker must NOT have EXECUTE on % (050 EXECUTE-only boundary)', v_fn;
        END IF;
        IF has_function_privilege('outbox_executor', v_fn, 'EXECUTE') IS DISTINCT FROM false THEN
            RAISE EXCEPTION 'migration 056 refused: outbox_executor must NOT have EXECUTE on % (050 EXECUTE-only boundary)', v_fn;
        END IF;
    END LOOP;

    -- Narrow bodies: the dispatcher functions touch NOTHING outside
    -- provider.provider_operations (no outbox, no inbox, no capability or
    -- tenant-registry side reads).
    FOR v_fn IN
        SELECT unnest(ARRAY[
            'provider.dispatch_claim(integer, integer, text)',
            'provider.dispatch_expired_list(integer)',
            'provider.dispatch_verifying_list(integer)'
        ])
    LOOP
        IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc AS p WHERE p.oid = v_fn::regprocedure)
            ILIKE ANY (ARRAY['%outbox%', '%inbox%', '%capabilit%', '%control.tenants%', '%tenant_memberships%']) THEN
            RAISE EXCEPTION 'migration 056 refused: % body must not reference tables outside provider.provider_operations', v_fn;
        END IF;
    END LOOP;
    IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc AS p
        WHERE p.oid = 'provider.dispatch_claim(integer, integer, text)'::regprocedure)
        NOT ILIKE '%SKIP LOCKED%' THEN
        RAISE EXCEPTION 'migration 056 refused: dispatch_claim body must use SKIP LOCKED (disjoint concurrent drains)';
    END IF;
END $$;

COMMIT;
