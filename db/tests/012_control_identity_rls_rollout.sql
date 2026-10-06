-- 012 RLS domain rollout (migrations 047 + 049): control.* + identity.* as iptv_app.
-- Enrolled surface: identity.persons, identity.identities,
-- identity.identity_merge_reviews (plain tenant template) +
-- control.feature_flags (hybrid global+own read / own-tenant write) +
-- control.tenant_memberships + control.membership_roles (plain tenant
-- template since 049, reached via the 043-style resolvers — the former
-- deliberate pre-context exception is CLOSED, see below).
-- Also asserts: grants on the global control catalogs (grant-without-RLS
-- rationale) and the global-table allow-list (no tenant_id-bearing
-- control/identity table may stay unenrolled anymore).
-- Isolation sample: identity.persons (tenant A/B, fail-closed, cross-tenant
-- write blocked) plus control.feature_flags (global + own read, cross-tenant
-- and GLOBAL writes blocked), then owner bypass. The membership-table
-- isolation sample (resolvers + enrolled policies + login->switch->guard
-- rehearsal) lives in db/tests/013.
-- Fixture rows ROLLBACK; role/policy/grants persist.
-- Regression: db/tests/006 (spike), 007 (pilot), 008 (crm/communication),
-- 009 (pre-context resolver), 013 (membership resolvers). Run all six.
-- Execute: cat file | docker exec -i iptv-postgres-1 psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 047 preconditions: role NOBYPASSRLS + grants + RLS/policy on
-- every enrolled table.
DO $$
DECLARE
    enforced text[] := ARRAY[
        'identity.persons',
        'identity.identities',
        'identity.identity_merge_reviews',
        'control.feature_flags',
        'control.tenant_memberships',
        'control.membership_roles'
    ];
    granted_full_dml text[] := ARRAY[
        'identity.persons',
        'identity.identities',
        'identity.identity_merge_reviews',
        'control.feature_flags',
        'control.tenants',
        'control.users',
        'control.auth_credentials',
        'control.auth_sessions',
        'control.tenant_memberships',
        'control.membership_roles'
    ];
    granted_read_only text[] := ARRAY[
        'control.permissions',
        'control.roles',
        'control.role_permissions'
    ];
    t text;
    n_policy text;
    split_policies text[] := ARRAY[
        'feature_flags_select',
        'feature_flags_insert',
        'feature_flags_update',
        'feature_flags_delete'
    ];
BEGIN
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'iptv_app') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'app role iptv_app must exist with NOBYPASSRLS';
    END IF;
    FOREACH t IN ARRAY enforced LOOP
        IF (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'RLS is not enabled on %', t;
        END IF;
        IF t = 'control.feature_flags' THEN
            -- 048 split the single all-command policy into per-command
            -- policies (adversarial review: one USING admitting NULL tenant
            -- let the app role steal/delete global rows). Assert the split.
            FOREACH n_policy IN ARRAY split_policies LOOP
                IF NOT EXISTS (
                    SELECT 1 FROM pg_policies
                    WHERE schemaname = 'control'
                      AND tablename = 'feature_flags'
                      AND policyname = n_policy
                ) THEN
                    RAISE EXCEPTION 'feature_flags split policy missing: %', n_policy;
                END IF;
            END LOOP;
        ELSE
            IF NOT EXISTS (
                SELECT 1 FROM pg_policies
                WHERE schemaname = split_part(t, '.', 1)
                  AND tablename = split_part(t, '.', 2)
                  AND policyname = 'tenant_isolation'
            ) THEN
                RAISE EXCEPTION 'tenant_isolation policy missing on %', t;
            END IF;
        END IF;
    END LOOP;
    FOREACH t IN ARRAY granted_full_dml LOOP
        IF has_table_privilege('iptv_app', t, 'SELECT') IS DISTINCT FROM true
            OR has_table_privilege('iptv_app', t, 'INSERT') IS DISTINCT FROM true
            OR has_table_privilege('iptv_app', t, 'UPDATE') IS DISTINCT FROM true
            OR has_table_privilege('iptv_app', t, 'DELETE') IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'app role lacks full DML grants on %', t;
        END IF;
    END LOOP;
    FOREACH t IN ARRAY granted_read_only LOOP
        IF has_table_privilege('iptv_app', t, 'SELECT') IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'app role lacks SELECT on global catalog %', t;
        END IF;
        IF has_table_privilege('iptv_app', t, 'INSERT') IS NOT DISTINCT FROM true
            OR has_table_privilege('iptv_app', t, 'UPDATE') IS NOT DISTINCT FROM true
            OR has_table_privilege('iptv_app', t, 'DELETE') IS NOT DISTINCT FROM true THEN
            RAISE EXCEPTION 'global catalog % must stay read-only for iptv_app', t;
        END IF;
    END LOOP;
    RAISE NOTICE 'rollout preconditions OK: iptv_app NOBYPASSRLS, RLS + tenant_isolation on 6 tables, DML/read-only grants as designed';
END $$;

-- 2) Allow-list assertion: every tenant_id-bearing table in control/identity
-- is RLS-enforced. The 047 pre-context exception pair
-- (control.tenant_memberships + control.membership_roles) enrolled via
-- migration 049, so the documented-exception list is EMPTY — the mechanism
-- stays (a new tenant_id-bearing table appearing here without a policy fails
-- the test), but nothing may hide behind it anymore.
DO $$
DECLARE
    pre_context_exceptions text[] := ARRAY[]::text[];
    unenrolled text[];
    t text;
BEGIN
    SELECT array_agg(n.nspname || '.' || c.relname ORDER BY n.nspname, c.relname)
      INTO unenrolled
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('control', 'identity')
       AND c.relkind = 'r'
       AND EXISTS (
           SELECT 1 FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
       )
       AND (SELECT relrowsecurity FROM pg_class WHERE oid = c.oid) IS DISTINCT FROM true;
    FOREACH t IN ARRAY coalesce(unenrolled, '{}'::text[]) LOOP
        IF NOT (t = ANY (pre_context_exceptions)) THEN
            RAISE EXCEPTION 'tenant_id-bearing table % is not RLS-enrolled and is not a documented exception', t;
        END IF;
    END LOOP;
    RAISE NOTICE 'allow-list OK: % unenrolled tenant_id table(s), exception list is empty by design (049 closed it)', coalesce(array_length(unenrolled, 1), 0);
END $$;

-- 3) Global-table assertion: the grant-without-RLS control tables really have
-- no tenant_id ownership column (so RLS could not isolate them).
DO $$
DECLARE
    globals text[] := ARRAY[
        'control.tenants',
        'control.users',
        'control.auth_credentials',
        'control.auth_sessions',
        'control.roles',
        'control.permissions',
        'control.role_permissions'
    ];
    t text;
BEGIN
    FOREACH t IN ARRAY globals LOOP
        IF EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = t::regclass AND a.attname = 'tenant_id' AND NOT a.attisdropped
        ) THEN
            RAISE EXCEPTION 'declared global table % carries a tenant_id column', t;
        END IF;
        IF (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) IS NOT DISTINCT FROM true THEN
            RAISE EXCEPTION 'global table % must not have RLS enabled (nothing to isolate)', t;
        END IF;
    END LOOP;
    RAISE NOTICE 'global tables OK: % control tables are tenant-less and RLS-free', array_length(globals, 1);
END $$;

-- 4) Former pre-context exception now ENROLLED (migration 049 closed it with
-- the 043-style resolvers + same-commit call-site swaps): both tables must
-- carry RLS + tenant_isolation. This block is the tripwire in reverse — if a
-- future migration ever drops the enrollment, the test fails loudly.
DO $$
DECLARE
    enrolled text[] := ARRAY[
        'control.tenant_memberships',
        'control.membership_roles'
    ];
    t text;
BEGIN
    FOREACH t IN ARRAY enrolled LOOP
        IF (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) IS DISTINCT FROM true THEN
            RAISE EXCEPTION '% lost its RLS enrollment; the 049 resolver contract requires it', t;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'control'
              AND tablename = split_part(t, '.', 2)
              AND policyname = 'tenant_isolation'
        ) THEN
            RAISE EXCEPTION 'tenant_isolation policy missing on %', t;
        END IF;
    END LOOP;
    RAISE NOTICE 'membership enrollment OK: tenant_memberships + membership_roles are RLS-enrolled (049 resolvers carry the pre-context reads)';
END $$;

-- 5) Fixture: two tenants, one person each (as owner), one GLOBAL feature flag
-- plus a tenant-scoped flag for each tenant.
CREATE TEMP TABLE ci_ids (
    ta uuid, tb uuid, pa uuid, pb uuid, global_flag uuid, fa uuid, fb uuid
);

DO $$
DECLARE
    ta uuid;
    tb uuid;
    pa uuid;
    pb uuid;
    gf uuid;
    fa uuid;
    fb uuid;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-ci-a-' || gen_random_uuid(), 'RLS ControlIdentity A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-ci-b-' || gen_random_uuid(), 'RLS ControlIdentity B') RETURNING id INTO tb;
    INSERT INTO identity.persons (tenant_id) VALUES (ta) RETURNING id INTO pa;
    INSERT INTO identity.persons (tenant_id) VALUES (tb) RETURNING id INTO pb;
    INSERT INTO control.feature_flags (tenant_id, flag_key, enabled)
    VALUES (NULL, 'ci.global.flag', false) RETURNING id INTO gf;
    INSERT INTO control.feature_flags (tenant_id, flag_key, enabled)
    VALUES (ta, 'ci.tenant.flag', true) RETURNING id INTO fa;
    INSERT INTO control.feature_flags (tenant_id, flag_key, enabled)
    VALUES (tb, 'ci.tenant.flag', false) RETURNING id INTO fb;
    INSERT INTO ci_ids (ta, tb, pa, pb, global_flag, fa, fb)
    VALUES (ta, tb, pa, pb, gf, fa, fb);
    RAISE NOTICE 'control/identity fixture ready: tenants % / %', ta, tb;
END $$;

-- 6) Tenant A sees ONLY tenant A rows on identity.* and its OWN flag override
-- plus the GLOBAL default on control.feature_flags.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    gf uuid;
    fa uuid;
    fb uuid;
    n_all integer;
    n_other integer;
    n_own integer;
    n_global integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    -- All fixture ids are read BEFORE SET LOCAL ROLE: the temp table belongs to
    -- the owner, so iptv_app cannot read it.
    SELECT s.ta, s.tb, s.global_flag, s.fa, s.fb INTO ta, tb, gf, fa, fb FROM ci_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM identity.persons;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'identity.persons: tenant A must see exactly 1 row, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM identity.persons WHERE tenant_id = tb;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'identity.persons: cross-tenant read must return 0 rows, saw %', n_other;
    END IF;
    SELECT count(*) INTO n_own FROM control.feature_flags WHERE id IN (fa, fb);
    IF n_own <> 1 THEN
        RAISE EXCEPTION 'control.feature_flags: tenant A must see exactly 1 own flag, saw %', n_own;
    END IF;
    SELECT count(*) INTO n_global FROM control.feature_flags WHERE id = gf;
    IF n_global <> 1 THEN
        RAISE EXCEPTION 'control.feature_flags: tenant A must see the 1 GLOBAL flag, saw %', n_global;
    END IF;
    RAISE NOTICE 'tenant A isolation OK: 1 own person, 1 own flag + 1 global flag, 0 cross-tenant rows';
END $$;

-- 7) Tenant B sees ONLY tenant B rows (proves RESET between blocks).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM ci_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM identity.persons;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'identity.persons: tenant B must see exactly 1 row, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM identity.persons WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'identity.persons: cross-tenant read must return 0 rows, saw %', n_other;
    END IF;
    RAISE NOTICE 'tenant B isolation OK: 1 own person, 0 cross-tenant rows';
END $$;

-- 8) Fail-closed: app role with NO tenant context sees no tenant row, but
-- still sees the GLOBAL flag defaults (there is no context to match them to).
DO $$
DECLARE
    gf uuid;
    n integer;
    n_global integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.global_flag INTO gf FROM ci_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM identity.persons;
    IF n <> 0 THEN
        RAISE EXCEPTION 'identity.persons: app role without tenant context must see 0 rows, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM identity.identities;
    IF n <> 0 THEN
        RAISE EXCEPTION 'identity.identities: app role without tenant context must see 0 rows, saw %', n;
    END IF;
    SELECT count(*) INTO n_global FROM control.feature_flags
    WHERE tenant_id IS NULL AND id = gf;
    IF n_global <> 1 THEN
        RAISE EXCEPTION 'control.feature_flags: GLOBAL flags stay readable without context, expected 1, saw %', n_global;
    END IF;
    RAISE NOTICE 'fail-closed OK: no tenant context => 0 tenant rows, GLOBAL flags still readable';
END $$;

-- 9) Writes: own tenant allowed; cross-tenant AND global writes blocked.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    pb uuid;
    fb uuid;
    gf uuid;
    fa uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.pb, s.fb, s.global_flag, s.fa
      INTO ta, tb, pb, fb, gf, fa
      FROM ci_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;
    INSERT INTO identity.persons (tenant_id) VALUES (ta);
    SELECT count(*) INTO n FROM identity.persons;
    IF n <> 2 THEN
        RAISE EXCEPTION 'identity.persons: tenant A must see 2 rows after its own insert, saw %', n;
    END IF;
    BEGIN
        INSERT INTO identity.persons (tenant_id) VALUES (tb);
        RAISE EXCEPTION 'expected cross-tenant person insert to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO identity.identities (tenant_id, person_id, identity_type, normalized_value)
        VALUES (tb, pb, 'EMAIL', 'cross-' || gen_random_uuid()::text);
        RAISE EXCEPTION 'expected cross-tenant identity insert to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO control.feature_flags (tenant_id, flag_key, enabled)
        VALUES (tb, 'ci.cross.flag', true);
        RAISE EXCEPTION 'expected cross-tenant feature flag insert to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        -- GLOBAL (NULL tenant) write must be refused: the app role may only
        -- claim its own tenant, so global defaults stay owner-managed.
        INSERT INTO control.feature_flags (tenant_id, flag_key, enabled)
        VALUES (NULL, 'ci.attempted.global', true);
        RAISE EXCEPTION 'expected global feature flag insert to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    -- RLS filters UPDATE targets silently (no error, zero rows touched), so the
    -- cross-tenant UPDATE is asserted by row count, not by an exception.
    UPDATE control.feature_flags SET enabled = true WHERE id = fb;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
        RAISE EXCEPTION 'cross-tenant feature flag UPDATE must touch 0 rows, touched %', n;
    END IF;
    -- REGRESSION (048 policy split): 047's single all-command policy let the
    -- app role STEAL a global row via UPDATE (WITH CHECK validated only the
    -- new row) and DELETE global rows (USING admitted NULL tenant; DELETE has
    -- no WITH CHECK). Both must touch 0 rows under the split policy.
    UPDATE control.feature_flags SET tenant_id = ta WHERE id = gf;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
        RAISE EXCEPTION 'global feature flag must NOT be claimable via UPDATE, touched %', n;
    END IF;
    DELETE FROM control.feature_flags WHERE id = gf;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
        RAISE EXCEPTION 'global feature flag must NOT be deletable by the app role, deleted %', n;
    END IF;
    -- Own-tenant UPDATE stays legitimate under the split policy.
    UPDATE control.feature_flags SET enabled = false WHERE id = fa;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN
        RAISE EXCEPTION 'own-tenant feature flag UPDATE must touch exactly 1 row, touched %', n;
    END IF;
    RAISE NOTICE 'write path OK: own-tenant insert visible; cross-tenant + GLOBAL writes blocked (WITH CHECK => insufficient_privilege)';
END $$;

-- 10) Owner/superuser bypasses RLS: sees BOTH tenants regardless of context.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    gf uuid;
    fa uuid;
    fb uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.global_flag, s.fa, s.fb INTO ta, tb, gf, fa, fb FROM ci_ids s LIMIT 1;
    -- 2 fixture persons + the 1 own-tenant insert from block 9.
    SELECT count(*) INTO n FROM identity.persons WHERE tenant_id = ta;
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 tenant A persons, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM identity.persons WHERE tenant_id = tb;
    IF n <> 1 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 1 tenant B person, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM control.feature_flags WHERE id IN (gf, fa, fb);
    IF n <> 3 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 3 rollout feature flags, saw %', n;
    END IF;
    RAISE NOTICE 'owner bypass OK: superuser sees all tenants (BYPASSRLS)';
END $$;

ROLLBACK;