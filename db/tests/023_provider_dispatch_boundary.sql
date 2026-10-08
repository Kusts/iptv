-- 023 Provider dispatch boundary (migration 056): GLOBAL providers +
-- hybrid app_profiles + dispatcher claim/recover/reconcile functions as
-- iptv_app.
-- Proves the 056 installed boundary: function shape (SECURITY DEFINER,
-- pinned search_path, revoked from PUBLIC, EXECUTE to iptv_app only, outbox
-- lifecycle roles excluded, narrow bodies touching only
-- provider.provider_operations), GLOBAL provider.providers (no RLS,
-- SELECT+INSERT to iptv_app, UPDATE/DELETE refused), hybrid
-- trial.app_profiles (RLS + per-command policies + full DML:
-- shared NULL rows visible to every tenant, own rows isolated, cross-tenant
-- denied, writes owner-only so shared rows are read-only for tenants:
-- WITH CHECK forbids creating shared rows, UPDATE/DELETE USING forbids
-- claiming or deleting them), the claim behavior
-- (ordered REQUESTED -> QUEUED with claimed_by + lease, SKIP LOCKED
-- disjointness single-session, secret-provenance only, terminal/HUMAN rows
-- untouched), the read-only candidate lists (expired leases with frontier
-- polarity, VERIFYING trial.provision only), no-context fail-closed on the
-- tenant tables, outbox-role boundary on both tables, and owner bypass.
-- Fixture rows ROLLBACK; functions/grants/policy/RLS persist.
-- Execute: cat file | docker exec -i iptv-pg-test psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
-- (Regression: db/tests/017, 018, 019, 020, 021, 022.)
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 056 preconditions: function shape, security, grants, scope.
DO $$
DECLARE
    v_secdef boolean;
    v_config text[];
    v_src text;
    v_owner name;
    fns text[] := ARRAY[
        'provider.dispatch_claim(integer, integer, text)',
        'provider.dispatch_expired_list(integer)',
        'provider.dispatch_verifying_list(integer)'
    ];
    f text;
BEGIN
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'iptv_app') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'app role iptv_app must exist with NOBYPASSRLS';
    END IF;

    SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class AS c WHERE c.oid = 'provider.provider_operations'::regclass;

    FOREACH f IN ARRAY fns LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f::regprocedure) THEN
            RAISE EXCEPTION 'migration 056 not applied: % is missing', f;
        END IF;
        SELECT p.prosecdef, p.proconfig INTO v_secdef, v_config
        FROM pg_proc p WHERE p.oid = f::regprocedure;
        IF v_secdef IS DISTINCT FROM true THEN
            RAISE EXCEPTION '056 function % must be SECURITY DEFINER', f;
        END IF;
        IF v_config IS NULL OR NOT EXISTS (
            SELECT 1 FROM unnest(v_config) g WHERE g = 'search_path=provider, pg_temp'
        ) THEN
            RAISE EXCEPTION '056 function % must pin search_path=provider, pg_temp (saw %)', f, v_config;
        END IF;
        IF EXISTS (
            SELECT 1 FROM pg_proc p
            WHERE p.oid = f::regprocedure
              AND (p.proacl::text LIKE '{=X/%' OR p.proacl::text LIKE '%,=X/%')
        ) THEN
            RAISE EXCEPTION '056 function % must be revoked from PUBLIC', f;
        END IF;
        IF has_function_privilege('iptv_app', f, 'EXECUTE') IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'iptv_app must have EXECUTE on %', f;
        END IF;
        IF EXISTS (
            SELECT 1 FROM pg_proc AS p
            WHERE p.oid = f::regprocedure
              AND pg_get_userbyid(p.proowner) IS DISTINCT FROM v_owner
        ) THEN
            RAISE EXCEPTION '056 function % must be owned by the migration owner (not a lifecycle role)', f;
        END IF;
        IF has_function_privilege('outbox_worker', f, 'EXECUTE') IS DISTINCT FROM false THEN
            RAISE EXCEPTION 'outbox_worker must NOT have EXECUTE on % (050 EXECUTE-only boundary)', f;
        END IF;
        IF has_function_privilege('outbox_executor', f, 'EXECUTE') IS DISTINCT FROM false THEN
            RAISE EXCEPTION 'outbox_executor must NOT have EXECUTE on % (050 EXECUTE-only boundary)', f;
        END IF;
    END LOOP;

    -- Narrow bodies: only provider.provider_operations, never outbox/inbox/
    -- capability/tenant-registry side reads; the claim uses SKIP LOCKED.
    FOREACH f IN ARRAY fns LOOP
        SELECT pg_get_functiondef(p.oid) INTO v_src
        FROM pg_proc p WHERE p.oid = f::regprocedure;
        IF v_src NOT ILIKE '%provider.provider_operations%' THEN
            RAISE EXCEPTION '% body must transition provider.provider_operations', f;
        END IF;
        IF v_src ILIKE '%outbox%' OR v_src ILIKE '%inbox%'
            OR v_src ILIKE '%capabilit%' OR v_src ILIKE '%control.tenants%'
            OR v_src ILIKE '%tenant_memberships%' THEN
            RAISE EXCEPTION '% body must not reference tables outside provider.provider_operations', f;
        END IF;
    END LOOP;
    SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    WHERE p.oid = 'provider.dispatch_claim(integer, integer, text)'::regprocedure;
    IF v_src NOT ILIKE '%SKIP LOCKED%' THEN
        RAISE EXCEPTION 'dispatch_claim body must use SKIP LOCKED (disjoint concurrent drains)';
    END IF;
    IF v_src NOT ILIKE '%''REQUESTED''%' OR v_src NOT ILIKE '%''QUEUED''%' THEN
        RAISE EXCEPTION 'dispatch_claim body must move REQUESTED -> QUEUED explicitly';
    END IF;
    IF v_src NOT ILIKE '%secret-required-v1%' THEN
        RAISE EXCEPTION 'dispatch_claim body must filter the secret-required provenance';
    END IF;

    -- GLOBAL providers: no RLS, no policies, minimal SELECT+INSERT surface.
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'provider.providers'::regclass) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'provider.providers (GLOBAL) must stay without RLS';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'provider' AND tablename = 'providers') THEN
        RAISE EXCEPTION 'provider.providers (GLOBAL) must carry no policies';
    END IF;
    IF has_table_privilege('iptv_app', 'provider.providers', 'SELECT') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'provider.providers', 'INSERT') IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'iptv_app needs SELECT+INSERT on provider.providers (ensure-path)';
    END IF;
    IF has_table_privilege('iptv_app', 'provider.providers', 'UPDATE') IS DISTINCT FROM false
        OR has_table_privilege('iptv_app', 'provider.providers', 'DELETE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'iptv_app must NOT hold UPDATE/DELETE on provider.providers (owner-only catalog mutation)';
    END IF;

    -- Hybrid app_profiles: RLS + per-command policies + full DML.
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'trial.app_profiles'::regclass) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'RLS is not enabled on trial.app_profiles';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'trial' AND tablename = 'app_profiles'
          AND policyname = 'tenant_isolation' AND cmd = 'SELECT'
    ) THEN
        RAISE EXCEPTION 'tenant_isolation SELECT policy missing on trial.app_profiles';
    END IF;
    IF (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'trial' AND tablename = 'app_profiles'
          AND policyname IN ('tenant_isolation_insert', 'tenant_isolation_update', 'tenant_isolation_delete')
    ) <> 3 THEN
        RAISE EXCEPTION 'per-command write policies missing on trial.app_profiles';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'trial' AND tablename = 'app_profiles'
          AND cmd = '*'
    ) THEN
        RAISE EXCEPTION 'FOR ALL policy on trial.app_profiles would reopen shared-row writes';
    END IF;
    IF (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polname = 'tenant_isolation'
        AND polrelid = 'trial.app_profiles'::regclass) NOT ILIKE '%IS NULL%' THEN
        RAISE EXCEPTION 'app_profiles SELECT USING must stay NULL-tolerant (shared rows visible)';
    END IF;
    IF (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polname = 'tenant_isolation_update'
        AND polrelid = 'trial.app_profiles'::regclass) ILIKE '%IS NULL%'
        OR (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polname = 'tenant_isolation_delete'
        AND polrelid = 'trial.app_profiles'::regclass) ILIKE '%IS NULL%' THEN
        RAISE EXCEPTION 'app_profiles UPDATE/DELETE USING must be owner-only (shared rows not writable)';
    END IF;
    IF has_table_privilege('iptv_app', 'trial.app_profiles', 'SELECT') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'trial.app_profiles', 'INSERT') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'trial.app_profiles', 'UPDATE') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'trial.app_profiles', 'DELETE') IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'app role lacks full DML grants on trial.app_profiles';
    END IF;

    RAISE NOTICE 'boundary preconditions OK: 3 definer functions, GLOBAL providers, hybrid app_profiles';
END $$;

-- 2) Outbox-role boundary (050 EXECUTE-only): worker/executor hold NOTHING
-- on either boundary table and no EXECUTE on the three functions (covered in
-- block 1; tables covered here).
DO $$
DECLARE
    tables text[] := ARRAY['provider.providers', 'trial.app_profiles'];
    t text;
BEGIN
    FOREACH t IN ARRAY tables LOOP
        IF has_table_privilege('outbox_worker', t, 'SELECT') IS DISTINCT FROM false
            OR has_table_privilege('outbox_worker', t, 'INSERT') IS DISTINCT FROM false
            OR has_table_privilege('outbox_worker', t, 'UPDATE') IS DISTINCT FROM false
            OR has_table_privilege('outbox_worker', t, 'DELETE') IS DISTINCT FROM false THEN
            RAISE EXCEPTION 'outbox_worker must hold no privilege on % (050 EXECUTE-only boundary)', t;
        END IF;
        IF has_table_privilege('outbox_executor', t, 'SELECT') IS DISTINCT FROM false
            OR has_table_privilege('outbox_executor', t, 'INSERT') IS DISTINCT FROM false
            OR has_table_privilege('outbox_executor', t, 'UPDATE') IS DISTINCT FROM false
            OR has_table_privilege('outbox_executor', t, 'DELETE') IS DISTINCT FROM false THEN
            RAISE EXCEPTION 'outbox_executor must hold no privilege on % (050 EXECUTE-only boundary)', t;
        END IF;
    END LOOP;
    RAISE NOTICE 'outbox boundary OK: worker/executor hold nothing on providers + app_profiles';
END $$;

-- 3) Fixture: two tenants sharing one GLOBAL provider row (accounts per
-- tenant), one shared + two owned app_profiles, and operations spanning
-- every claim/list bucket, as owner.
CREATE TEMP TABLE dispatch_boundary_ids (
    ta uuid, tb uuid, prov uuid, acca uuid, accb uuid,
    op_a uuid, op_b uuid, op_echo uuid, op_queued uuid, op_human uuid,
    op_pre uuid, op_post uuid, op_fresh uuid, op_ver uuid, op_done uuid,
    prof_null uuid, prof_a uuid, prof_b uuid
);

DO $$
DECLARE
    ta uuid; tb uuid; prov uuid; acca uuid; accb uuid;
    op_a uuid; op_b uuid; op_echo uuid; op_queued uuid; op_human uuid;
    op_pre uuid; op_post uuid; op_fresh uuid; op_ver uuid; op_done uuid;
    prof_null uuid; prof_a uuid; prof_b uuid;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-dsp-a-' || gen_random_uuid(), 'RLS Dispatch A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-dsp-b-' || gen_random_uuid(), 'RLS Dispatch B') RETURNING id INTO tb;

    INSERT INTO provider.providers (provider_key, name, provider_type)
    VALUES ('dsp-bound-' || gen_random_uuid(), 'Dispatch boundary provider', 'IPTV')
    RETURNING id INTO prov;
    INSERT INTO provider.provider_accounts (tenant_id, provider_id, name, secret_ref)
    VALUES (ta, prov, 'Dispatch account A', 'secret-a') RETURNING id INTO acca;
    INSERT INTO provider.provider_accounts (tenant_id, provider_id, name, secret_ref)
    VALUES (tb, prov, 'Dispatch account B', 'secret-b') RETURNING id INTO accb;

    -- Shared + owned app profiles.
    INSERT INTO trial.app_profiles (tenant_id, name, platform, version)
    VALUES (NULL, 'SharedApp', 'ANDROID', '1.0') RETURNING id INTO prof_null;
    INSERT INTO trial.app_profiles (tenant_id, name, platform, version)
    VALUES (ta, 'TenantAppA', 'ANDROID', '1.0') RETURNING id INTO prof_a;
    INSERT INTO trial.app_profiles (tenant_id, name, platform, version)
    VALUES (tb, 'TenantAppB', 'ANDROID', '1.0') RETURNING id INTO prof_b;

    -- Claim bucket: two REQUESTED secret rows (A older than B), one
    -- synthetic echo row (never claimable), one already-QUEUED row (never
    -- re-claimed), one HUMAN_REQUIRED row (terminal to the claim).
    INSERT INTO provider.provider_operations
        (tenant_id, provider_account_id, action, entity_type, entity_id,
         idempotency_key, adapter_version, correlation_id, requested_at)
    VALUES (ta, acca, 'trial.provision', 'trial', gen_random_uuid(),
            'dsp-a-' || gen_random_uuid(), 'secret-required-v1', gen_random_uuid(),
            now() - interval '10 minutes')
    RETURNING id INTO op_a;
    INSERT INTO provider.provider_operations
        (tenant_id, provider_account_id, action, entity_type, entity_id,
         idempotency_key, adapter_version, correlation_id, requested_at)
    VALUES (tb, accb, 'trial.provision', 'trial', gen_random_uuid(),
            'dsp-b-' || gen_random_uuid(), 'secret-required-v1', gen_random_uuid(),
            now() - interval '5 minutes')
    RETURNING id INTO op_b;
    INSERT INTO provider.provider_operations
        (tenant_id, provider_account_id, action, entity_type, entity_id,
         idempotency_key, adapter_version, correlation_id)
    VALUES (ta, acca, 'trial.provision', 'trial', gen_random_uuid(),
            'dsp-echo-' || gen_random_uuid(), 'echo-v1', gen_random_uuid())
    RETURNING id INTO op_echo;
    INSERT INTO provider.provider_operations
        (tenant_id, provider_account_id, action, entity_type, entity_id,
         status, claimed_by, claimed_at, lease_expires_at,
         idempotency_key, adapter_version, correlation_id)
    VALUES (ta, acca, 'trial.provision', 'trial', gen_random_uuid(),
            'QUEUED', 'other-worker', now(), now() + interval '5 minutes',
            'dsp-q-' || gen_random_uuid(), 'secret-required-v1', gen_random_uuid())
    RETURNING id INTO op_queued;
    INSERT INTO provider.provider_operations
        (tenant_id, provider_account_id, action, entity_type, entity_id,
         status, idempotency_key, adapter_version, correlation_id)
    VALUES (ta, acca, 'trial.provision', 'trial', gen_random_uuid(),
            'HUMAN_REQUIRED', 'dsp-h-' || gen_random_uuid(), 'secret-required-v1',
            gen_random_uuid())
    RETURNING id INTO op_human;

    -- Recovery buckets: expired pre-send (frontier NULL), expired post-send
    -- (frontier set), vigorous lease (not expired), plus a VERIFYING
    -- secret trial.provision row and a SUCCEEDED row for the reconcile list.
    INSERT INTO provider.provider_operations
        (tenant_id, provider_account_id, action, entity_type, entity_id,
         status, claimed_by, claimed_at, lease_expires_at,
         idempotency_key, adapter_version, correlation_id)
    VALUES (ta, acca, 'trial.provision', 'trial', gen_random_uuid(),
            'QUEUED', 'stale-pre', now() - interval '10 minutes',
            now() - interval '5 minutes',
            'dsp-pre-' || gen_random_uuid(), 'secret-required-v1', gen_random_uuid())
    RETURNING id INTO op_pre;
    INSERT INTO provider.provider_operations
        (tenant_id, provider_account_id, action, entity_type, entity_id,
         status, claimed_by, claimed_at, lease_expires_at, dispatch_started_at,
         idempotency_key, adapter_version, correlation_id)
    VALUES (tb, accb, 'trial.provision', 'trial', gen_random_uuid(),
            'RUNNING', 'stale-post', now() - interval '10 minutes',
            now() - interval '5 minutes', now() - interval '9 minutes',
            'dsp-post-' || gen_random_uuid(), 'secret-required-v1', gen_random_uuid())
    RETURNING id INTO op_post;
    INSERT INTO provider.provider_operations
        (tenant_id, provider_account_id, action, entity_type, entity_id,
         status, claimed_by, claimed_at, lease_expires_at,
         idempotency_key, adapter_version, correlation_id)
    VALUES (ta, acca, 'trial.provision', 'trial', gen_random_uuid(),
            'RUNNING', 'fresh-worker', now(), now() + interval '5 minutes',
            'dsp-fresh-' || gen_random_uuid(), 'secret-required-v1', gen_random_uuid())
    RETURNING id INTO op_fresh;
    INSERT INTO provider.provider_operations
        (tenant_id, provider_account_id, action, entity_type, entity_id,
         status, idempotency_key, adapter_version, correlation_id)
    VALUES (ta, acca, 'trial.provision', 'trial', gen_random_uuid(),
            'VERIFYING', 'dsp-v-' || gen_random_uuid(), 'secret-required-v1',
            gen_random_uuid())
    RETURNING id INTO op_ver;
    INSERT INTO provider.provider_operations
        (tenant_id, provider_account_id, action, entity_type, entity_id,
         status, effect_certainty, idempotency_key, adapter_version, correlation_id)
    VALUES (tb, accb, 'trial.provision', 'trial', gen_random_uuid(),
            'SUCCEEDED', 'KNOWN_APPLIED', 'dsp-d-' || gen_random_uuid(), 'secret-required-v1',
            gen_random_uuid())
    RETURNING id INTO op_done;

    INSERT INTO dispatch_boundary_ids
    VALUES (ta, tb, prov, acca, accb,
            op_a, op_b, op_echo, op_queued, op_human,
            op_pre, op_post, op_fresh, op_ver, op_done,
            prof_null, prof_a, prof_b);
    RAISE NOTICE 'dispatch boundary fixture ready: tenants % / %', ta, tb;
END $$;

-- 4) GLOBAL providers as iptv_app: the catalog row is visible under tenant
-- A, tenant B, AND with no context; INSERT works (ensure-path).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    prov uuid;
    n integer;
    scratch uuid;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.prov INTO ta, tb, prov FROM dispatch_boundary_ids s LIMIT 1;

    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM provider.providers WHERE id = prov;
    IF n <> 1 THEN
        RAISE EXCEPTION 'providers: tenant A app role must see the GLOBAL row, saw %', n;
    END IF;
    INSERT INTO provider.providers (provider_key, name, provider_type)
    VALUES ('dsp-ensure-' || gen_random_uuid(), 'Ensure-path probe', 'IPTV')
    RETURNING id INTO scratch;
    SELECT count(*) INTO n FROM provider.providers WHERE id = scratch;
    IF n <> 1 THEN
        RAISE EXCEPTION 'providers: ensure-path INSERT must be visible, saw % rows', n;
    END IF;
    BEGIN
        UPDATE provider.providers SET name = 'Mutated' WHERE id = scratch;
        RAISE EXCEPTION 'expected providers UPDATE to fail (owner-only catalog mutation)';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        DELETE FROM provider.providers WHERE id = scratch;
        RAISE EXCEPTION 'expected providers DELETE to fail (owner-only catalog mutation)';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'providers GLOBAL OK (tenant A): visible + INSERT works, UPDATE/DELETE refused';
END $$;

DO $$
DECLARE
    tb uuid;
    prov uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.tb, s.prov INTO tb, prov FROM dispatch_boundary_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM provider.providers WHERE id = prov;
    IF n <> 1 THEN
        RAISE EXCEPTION 'providers: tenant B app role must see the SAME global row, saw %', n;
    END IF;
    RAISE NOTICE 'providers GLOBAL OK (tenant B): same row visible cross-tenant by design';
END $$;

DO $$
DECLARE
    prov uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.prov INTO prov FROM dispatch_boundary_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM provider.providers WHERE id = prov;
    IF n <> 1 THEN
        RAISE EXCEPTION 'providers: app role with NO context must still see the GLOBAL row, saw %', n;
    END IF;
    RAISE NOTICE 'providers GLOBAL OK (no context): catalog readable without tenant context';
END $$;

-- 5) Hybrid app_profiles as iptv_app: shared NULL + own visible, cross
-- denied; WITH CHECK forbids minting shared rows.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    prof_null uuid;
    prof_a uuid;
    prof_b uuid;
    n integer;
    scratch uuid;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.prof_null, s.prof_a, s.prof_b
      INTO ta, tb, prof_null, prof_a, prof_b
      FROM dispatch_boundary_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;

    SELECT count(*) INTO n FROM trial.app_profiles WHERE id = prof_null;
    IF n <> 1 THEN
        RAISE EXCEPTION 'app_profiles: tenant A must see the SHARED row, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM trial.app_profiles WHERE id = prof_a;
    IF n <> 1 THEN
        RAISE EXCEPTION 'app_profiles: tenant A must see its OWN row, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM trial.app_profiles WHERE id = prof_b;
    IF n <> 0 THEN
        RAISE EXCEPTION 'app_profiles: cross-tenant read must return 0 rows, saw %', n;
    END IF;

    INSERT INTO trial.app_profiles (tenant_id, name, platform)
    VALUES (ta, 'ScratchA', 'IOS') RETURNING id INTO scratch;
    DELETE FROM trial.app_profiles WHERE id = scratch;

    BEGIN
        INSERT INTO trial.app_profiles (tenant_id, name, platform)
        VALUES (NULL, 'SharedMint', 'IOS');
        RAISE EXCEPTION 'expected shared-row INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO trial.app_profiles (tenant_id, name, platform)
        VALUES (tb, 'CrossMint', 'IOS');
        RAISE EXCEPTION 'expected cross-tenant INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    -- Owner-only writes on shared rows: DELETE of the shared row matches
    -- 0 rows even with a tenant context, and claiming it (NULL -> own)
    -- matches 0 rows too; the row survives both.
    DELETE FROM trial.app_profiles WHERE id = prof_null;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
        RAISE EXCEPTION 'app_profiles: DELETE of shared row must affect 0 rows, saw %', n;
    END IF;
    UPDATE trial.app_profiles SET tenant_id = ta WHERE id = prof_null;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
        RAISE EXCEPTION 'app_profiles: UPDATE NULL->own (appropriation) must affect 0 rows, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM trial.app_profiles WHERE id = prof_null;
    IF n <> 1 THEN
        RAISE EXCEPTION 'app_profiles: shared row must survive refused writes, saw %', n;
    END IF;
    -- Owned rows cannot migrate across tenants or back to shared (WITH CHECK).
    BEGIN
        UPDATE trial.app_profiles SET tenant_id = tb WHERE id = prof_a;
        RAISE EXCEPTION 'expected cross-tenant UPDATE to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        UPDATE trial.app_profiles SET tenant_id = NULL WHERE id = prof_a;
        RAISE EXCEPTION 'expected own->shared UPDATE to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    -- Legitimate own-row UPDATE works.
    UPDATE trial.app_profiles SET name = 'TenantAppA2' WHERE id = prof_a;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN
        RAISE EXCEPTION 'app_profiles: own-row UPDATE must affect 1 row, saw %', n;
    END IF;
    RAISE NOTICE 'app_profiles hybrid OK (tenant A): shared + own visible, cross denied, shared/cross INSERT refused (42501)';
END $$;

DO $$
DECLARE
    tb uuid;
    prof_null uuid;
    prof_b uuid;
    prof_a uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.tb, s.prof_null, s.prof_b, s.prof_a
      INTO tb, prof_null, prof_b, prof_a
      FROM dispatch_boundary_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM trial.app_profiles WHERE id IN (prof_null, prof_b);
    IF n <> 2 THEN
        RAISE EXCEPTION 'app_profiles: tenant B must see shared + own (2 rows), saw %', n;
    END IF;
    SELECT count(*) INTO n FROM trial.app_profiles WHERE id = prof_a;
    IF n <> 0 THEN
        RAISE EXCEPTION 'app_profiles: tenant B must not see tenant A row, saw %', n;
    END IF;
    RAISE NOTICE 'app_profiles hybrid OK (tenant B): shared + own visible, cross denied';
END $$;

DO $$
DECLARE
    prof_null uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.prof_null INTO prof_null FROM dispatch_boundary_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    -- Hybrid nuance (documented): with NO context only shared rows match
    -- (`tenant_id IS NULL`); owned rows stay fail-closed.
    SELECT count(*) INTO n FROM trial.app_profiles WHERE id = prof_null;
    IF n <> 1 THEN
        RAISE EXCEPTION 'app_profiles: no-context read must still see the SHARED row, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM trial.app_profiles WHERE tenant_id IS NOT NULL;
    IF n <> 0 THEN
        RAISE EXCEPTION 'app_profiles: no-context read must see 0 owned rows, saw %', n;
    END IF;
    -- No context, no writes: DELETE of the shared row matches 0 rows.
    DELETE FROM trial.app_profiles WHERE id = prof_null;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
        RAISE EXCEPTION 'app_profiles: no-context DELETE of shared row must affect 0 rows, saw %', n;
    END IF;
    RAISE NOTICE 'app_profiles hybrid OK (no context): shared visible, owned fail-closed';
END $$;

-- 6) Claim via the definer as iptv_app with NO tenant context (the
-- scheduler/admin path): ordered oldest-first, secret-provenance only,
-- disjoint second claim, fencing + lease stamped, foreign rows untouched.
DO $$
DECLARE
    op_a uuid;
    op_b uuid;
    op_echo uuid;
    op_queued uuid;
    op_human uuid;
    n integer;
    got_ids uuid[];
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.op_a, s.op_b, s.op_echo, s.op_queued, s.op_human
      INTO op_a, op_b, op_echo, op_queued, op_human
      FROM dispatch_boundary_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;

    -- ONE claim takes both REQUESTED secret rows, oldest-first (op_a is 10
    -- min old, op_b 5 min); a second claim with a fresh token sees none of
    -- the first claim's rows (SKIP LOCKED disjointness).
    SELECT array_agg(o_operation_id) INTO got_ids
    FROM provider.dispatch_claim(10, 300, 'dsp-test-token-1');
    IF got_ids IS NULL OR cardinality(got_ids) <> 2
        OR got_ids[1] IS DISTINCT FROM op_a OR got_ids[2] IS DISTINCT FROM op_b THEN
        RAISE EXCEPTION 'claim must return exactly [op_a, op_b] oldest-first (saw %)', got_ids;
    END IF;
    SELECT count(*) INTO n
    FROM provider.dispatch_claim(10, 300, 'dsp-test-token-1b');
    IF n <> 0 THEN
        RAISE EXCEPTION 'second claim must see none of the first claim rows (disjointness), saw %', n;
    END IF;
    RAISE NOTICE 'claim disjointness OK: oldest-first + second claim empty';
END $$;

DO $$
DECLARE
    op_a uuid;
    op_b uuid;
    op_echo uuid;
    op_queued uuid;
    op_human uuid;
    n integer;
    c text;
    l timestamptz;
    st text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.op_a, s.op_b, s.op_echo, s.op_queued, s.op_human
      INTO op_a, op_b, op_echo, op_queued, op_human
      FROM dispatch_boundary_ids s LIMIT 1;

    -- Claimed rows: QUEUED + fencing token + live lease (owner view; the
    -- claim ran as iptv_app in the block above).
    SELECT status, claimed_by, lease_expires_at INTO st, c, l
    FROM provider.provider_operations WHERE id = op_a;
    IF st <> 'QUEUED' OR c <> 'dsp-test-token-1' OR l IS NULL OR l <= now() THEN
        RAISE EXCEPTION 'op_a must be QUEUED + fenced + leased (saw %, %, %)', st, c, l;
    END IF;
    SELECT status, claimed_by INTO st, c
    FROM provider.provider_operations WHERE id = op_b;
    IF st <> 'QUEUED' OR c <> 'dsp-test-token-1' THEN
        RAISE EXCEPTION 'op_b must be QUEUED + fenced (saw %, %)', st, c;
    END IF;

    -- Foreign rows untouched: echo stays REQUESTED/unclaimed, the
    -- pre-claimed QUEUED row keeps its token, HUMAN_REQUIRED never matches.
    SELECT status, claimed_by INTO st, c
    FROM provider.provider_operations WHERE id = op_echo;
    IF st <> 'REQUESTED' OR c IS NOT NULL THEN
        RAISE EXCEPTION 'echo row must stay REQUESTED + unclaimed (saw %, %)', st, c;
    END IF;
    SELECT claimed_by INTO c FROM provider.provider_operations WHERE id = op_queued;
    IF c <> 'other-worker' THEN
        RAISE EXCEPTION 'pre-claimed row must keep its token (saw %)', c;
    END IF;
    SELECT status, claimed_by INTO st, c
    FROM provider.provider_operations WHERE id = op_human;
    IF st <> 'HUMAN_REQUIRED' OR c IS NOT NULL THEN
        RAISE EXCEPTION 'HUMAN_REQUIRED row must never be claimed (saw %, %)', st, c;
    END IF;
    RAISE NOTICE 'claim fencing OK: QUEUED + token + lease stamped, echo/queued/HITL preserved';
END $$;

-- 7) Read-only candidate lists as iptv_app with NO context: expired leases
-- with frontier polarity; VERIFYING secret trial.provision only; vigorous,
-- terminal and foreign rows excluded.
DO $$
DECLARE
    op_pre uuid;
    op_post uuid;
    op_fresh uuid;
    op_human uuid;
    op_ver uuid;
    op_done uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.op_pre, s.op_post, s.op_fresh, s.op_human, s.op_ver, s.op_done
      INTO op_pre, op_post, op_fresh, op_human, op_ver, op_done
      FROM dispatch_boundary_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;

    SELECT count(*) INTO n FROM provider.dispatch_expired_list(100)
    WHERE o_operation_id IN (op_pre, op_post);
    IF n <> 2 THEN
        RAISE EXCEPTION 'expired_list must return both expired rows, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM provider.dispatch_expired_list(100)
    WHERE o_operation_id = op_pre AND o_started = false;
    IF n <> 1 THEN
        RAISE EXCEPTION 'pre-send expired row must report started=false';
    END IF;
    SELECT count(*) INTO n FROM provider.dispatch_expired_list(100)
    WHERE o_operation_id = op_post AND o_started = true;
    IF n <> 1 THEN
        RAISE EXCEPTION 'post-send expired row must report started=true';
    END IF;
    SELECT count(*) INTO n FROM provider.dispatch_expired_list(100)
    WHERE o_operation_id IN (op_fresh, op_human, op_ver, op_done);
    IF n <> 0 THEN
        RAISE EXCEPTION 'expired_list must exclude vigorous/HITL/VERIFYING/terminal rows, saw %', n;
    END IF;

    SELECT count(*) INTO n FROM provider.dispatch_verifying_list(100)
    WHERE o_operation_id = op_ver;
    IF n <> 1 THEN
        RAISE EXCEPTION 'verifying_list must return the VERIFYING secret trial.provision row';
    END IF;
    SELECT count(*) INTO n FROM provider.dispatch_verifying_list(100)
    WHERE o_operation_id IN (op_pre, op_post, op_human, op_done);
    IF n <> 0 THEN
        RAISE EXCEPTION 'verifying_list must exclude non-VERIFYING rows, saw %', n;
    END IF;
    RAISE NOTICE 'candidate lists OK: expired polarity + VERIFYING-only, foreign rows excluded';
END $$;

-- 8) Fail-closed: app role with NO tenant context sees nothing on the
-- tenant tables and cannot insert.
DO $$
DECLARE
    ta uuid;
    acca uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.acca INTO ta, acca FROM dispatch_boundary_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM provider.provider_operations;
    IF n <> 0 THEN
        RAISE EXCEPTION 'provider_operations: no-context read must return 0 rows, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM provider.provider_accounts;
    IF n <> 0 THEN
        RAISE EXCEPTION 'provider_accounts: no-context read must return 0 rows, saw %', n;
    END IF;
    BEGIN
        INSERT INTO provider.provider_operations
            (tenant_id, provider_account_id, action, entity_type, entity_id,
             idempotency_key, correlation_id)
        VALUES (ta, acca, 'trial.provision', 'trial', gen_random_uuid(),
                'dsp-nc-' || gen_random_uuid(), gen_random_uuid());
        RAISE EXCEPTION 'expected no-context operation INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'fail-closed OK: no tenant context => 0 rows + INSERT rejected';
END $$;

-- 9) Owner bypasses RLS: sees every tenant row regardless of context.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM dispatch_boundary_ids s LIMIT 1;
    SELECT count(*) INTO n FROM provider.provider_operations WHERE tenant_id IN (ta, tb);
    IF n <> 10 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 10 fixture operations, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM trial.app_profiles
    WHERE tenant_id IN (ta, tb) OR tenant_id IS NULL;
    IF n < 3 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see all fixture app profiles, saw %', n;
    END IF;
    RAISE NOTICE 'owner bypass OK: superuser sees all tenants (BYPASSRLS)';
END $$;

ROLLBACK;
