-- 026 RLS domain rollout (migration 059): analytics.* + experiments.* +
-- security.risk_assessments (tenant-scoped) as iptv_app.
-- Representative sample, one table per schema: analytics.metric_snapshots,
-- experiments.experiments, security.risk_assessments. Plus:
-- grant/policy/RLS preconditions on ALL 6 enrolled tables, allow-list
-- assertion (zero unenrolled tenant_id tables and zero tenant_id-less
-- GLOBAL tables across the 3-schema scope — each schema holds exactly
-- its enrolled set, asserted explicitly), outbox-role boundary assertion
-- (050 EXECUTE-only: outbox_worker/outbox_executor hold NOTHING on these
-- tables), and owner bypass. Covers: own CRUD on all 3 sampled tables +
-- assignment/exposure chain, cross-tenant 0 rows, tenant_id rewrite
-- rejected (WITH CHECK => 42501), cross-tenant INSERT rejected,
-- no-context fail-closed (SELECT 0 rows + INSERT rejected). The remaining
-- 3 enrolled tables are covered by the preconditions (RLS +
-- tenant_isolation + DML) plus the allow-list sweep — declared coverage, not
-- row-exhaustive.
-- Fixture rows ROLLBACK; role/policy/grants persist.
-- Execute: cat file | docker exec -i iptv-pg-test psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
-- (Regression: db/tests/022, 025.)
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 059 preconditions on all 6 enforced tables.
DO $$
DECLARE
    tables text[] := ARRAY[
        'analytics.metric_definitions',
        'analytics.metric_snapshots',
        'experiments.experiments',
        'experiments.experiment_assignments',
        'experiments.experiment_exposures',
        'security.risk_assessments'
    ];
    t text;
BEGIN
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'iptv_app') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'app role iptv_app must exist with NOBYPASSRLS';
    END IF;
    FOREACH t IN ARRAY tables LOOP
        IF (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'RLS is not enabled on %', t;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = split_part(t, '.', 1)
              AND tablename = split_part(t, '.', 2)
              AND policyname = 'tenant_isolation'
        ) THEN
            RAISE EXCEPTION 'tenant_isolation policy missing on %', t;
        END IF;
        IF has_table_privilege('iptv_app', t, 'SELECT') IS DISTINCT FROM true
            OR has_table_privilege('iptv_app', t, 'INSERT') IS DISTINCT FROM true
            OR has_table_privilege('iptv_app', t, 'UPDATE') IS DISTINCT FROM true
            OR has_table_privilege('iptv_app', t, 'DELETE') IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'app role lacks full DML grants on %', t;
        END IF;
    END LOOP;
    RAISE NOTICE 'rollout preconditions OK: iptv_app NOBYPASSRLS, RLS + tenant_isolation + DML grants on 6 tables';
END $$;

-- 2) Allow-list assertion: every tenant_id-bearing table in the 3-schema
-- scope must carry the enrolled tenant template (zero unenrolled — the
-- full 059 set is enrolled here); every tenant_id-less table in scope must
-- be exactly NONE (no GLOBAL table exists in these schemas by design, so
-- a silent nullable-tenant or tenant-less table fails loudly).
DO $$
DECLARE
    n_unenrolled_tenant integer;
    unenrolled_tenant text;
    n_global integer;
    global_list text;
BEGIN
    SELECT count(*), coalesce(string_agg(pt.schemaname || '.' || pt.tablename, ', ' ORDER BY 1), '')
      INTO n_unenrolled_tenant, unenrolled_tenant
    FROM pg_tables pt
    WHERE pt.schemaname IN ('analytics', 'experiments', 'security')
      AND EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
          WHERE n.nspname = pt.schemaname AND c.relname = pt.tablename AND c.relkind = 'r'
      )
      AND NOT EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = pt.schemaname AND c.relname = pt.tablename
            AND c.relrowsecurity
      );
    IF n_unenrolled_tenant <> 0 THEN
        RAISE EXCEPTION 'tenant template violated: % tenant_id table(s) without RLS outside the documented exception: %', n_unenrolled_tenant, unenrolled_tenant;
    END IF;

    SELECT count(*), coalesce(string_agg(pt.schemaname || '.' || pt.tablename, ', ' ORDER BY pt.schemaname, pt.tablename), '')
      INTO n_global, global_list
    FROM pg_tables pt
    WHERE pt.schemaname IN ('analytics', 'experiments', 'security')
      AND NOT EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
          WHERE n.nspname = pt.schemaname AND c.relname = pt.tablename AND c.relkind = 'r'
      );
    IF n_global <> 0 THEN
        RAISE EXCEPTION 'global-table allow-list violated: expected zero tenant_id-less tables in scope, saw % (%)', n_global, global_list;
    END IF;
    RAISE NOTICE 'allow-list OK: 6 enrolled, zero tenant_id-less tables in scope';
END $$;

-- 3) Outbox-role boundary (migration 050 EXECUTE-only): neither the worker
-- identity nor the executor may hold ANY direct privilege on the 6 tables
-- (050 grants live on platform.* only; an injected GRANT here would silently
-- widen the worker past its lifecycle functions).
DO $$
DECLARE
    tables text[] := ARRAY[
        'analytics.metric_definitions',
        'analytics.metric_snapshots',
        'experiments.experiments',
        'experiments.experiment_assignments',
        'experiments.experiment_exposures',
        'security.risk_assessments'
    ];
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
    RAISE NOTICE 'outbox boundary OK: worker/executor hold nothing on analytical tables';
END $$;

-- 4) Fixture: two tenants, one metric chain (definition -> snapshot), one
-- experiment chain (experiment -> assignment -> exposure) and one risk
-- assessment each, as owner.
CREATE TEMP TABLE analytical_rollout_ids (
    ta uuid, tb uuid,
    defa uuid, defb uuid,
    snapa uuid, snapb uuid,
    expa uuid, expb uuid,
    assigna uuid, assignb uuid,
    exposa uuid, exposb uuid,
    riska uuid, riskb uuid
);

DO $$
DECLARE
    ta uuid; tb uuid;
    defa uuid; defb uuid;
    snapa uuid; snapb uuid;
    expa uuid; expb uuid;
    assigna uuid; assignb uuid;
    exposa uuid; exposb uuid;
    riska uuid; riskb uuid;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-an-a-' || gen_random_uuid(), 'RLS Analytical A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-an-b-' || gen_random_uuid(), 'RLS Analytical B') RETURNING id INTO tb;

    INSERT INTO analytics.metric_definitions (tenant_id, metric_key, family, formula_ref, unit)
    VALUES (ta, 'roll-an-a', 'REVENUE', 'rev/v1', 'BRL_MINOR') RETURNING id INTO defa;
    INSERT INTO analytics.metric_definitions (tenant_id, metric_key, family, formula_ref, unit)
    VALUES (tb, 'roll-an-b', 'REVENUE', 'rev/v1', 'BRL_MINOR') RETURNING id INTO defb;
    INSERT INTO analytics.metric_snapshots (tenant_id, metric_key, bucket_start, value_minor)
    VALUES (ta, 'roll-an-a', now(), 1000) RETURNING id INTO snapa;
    INSERT INTO analytics.metric_snapshots (tenant_id, metric_key, bucket_start, value_minor)
    VALUES (tb, 'roll-an-b', now(), 2000) RETURNING id INTO snapb;

    INSERT INTO experiments.experiments (tenant_id, experiment_key, name)
    VALUES (ta, 'roll-an-a', 'Rollout experiment A') RETURNING id INTO expa;
    INSERT INTO experiments.experiments (tenant_id, experiment_key, name)
    VALUES (tb, 'roll-an-b', 'Rollout experiment B') RETURNING id INTO expb;
    INSERT INTO experiments.experiment_assignments (tenant_id, experiment_id, subject_type, subject_id, variant, assignment_version)
    VALUES (ta, expa, 'TENANT', ta::text, 'control', 1) RETURNING id INTO assigna;
    INSERT INTO experiments.experiment_assignments (tenant_id, experiment_id, subject_type, subject_id, variant, assignment_version)
    VALUES (tb, expb, 'TENANT', tb::text, 'control', 1) RETURNING id INTO assignb;
    INSERT INTO experiments.experiment_exposures (tenant_id, experiment_assignment_id, exposure_point, dedupe_key)
    VALUES (ta, assigna, 'checkout', 'roll-an-a') RETURNING id INTO exposa;
    INSERT INTO experiments.experiment_exposures (tenant_id, experiment_assignment_id, exposure_point, dedupe_key)
    VALUES (tb, assignb, 'checkout', 'roll-an-b') RETURNING id INTO exposb;

    INSERT INTO security.risk_assessments (tenant_id, subject_type, decision, policy_version)
    VALUES (ta, 'TENANT', 'ALLOW', 'v1') RETURNING id INTO riska;
    INSERT INTO security.risk_assessments (tenant_id, subject_type, decision, policy_version)
    VALUES (tb, 'TENANT', 'ALLOW', 'v1') RETURNING id INTO riskb;

    INSERT INTO analytical_rollout_ids
    VALUES (ta, tb, defa, defb, snapa, snapb, expa, expb,
            assigna, assignb, exposa, exposb, riska, riskb);
    RAISE NOTICE 'analytical fixture ready: tenants % / %', ta, tb;
END $$;

-- 5) Tenant A context sees ONLY tenant A rows on every sampled table
-- (one per schema) + the full experiment chain.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
    sampled text[] := ARRAY[
        'analytics.metric_snapshots',
        'experiments.experiments',
        'experiments.experiment_assignments',
        'experiments.experiment_exposures',
        'security.risk_assessments'
    ];
    t text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM analytical_rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;
    FOREACH t IN ARRAY sampled LOOP
        EXECUTE format('SELECT count(*) FROM %s', t) INTO n_all;
        IF n_all <> 1 THEN
            RAISE EXCEPTION '%: tenant A app role must see exactly 1 row, saw %', t, n_all;
        END IF;
        EXECUTE format('SELECT count(*) FROM %s WHERE tenant_id = %L', t, tb) INTO n_other;
        IF n_other <> 0 THEN
            RAISE EXCEPTION '%: cross-tenant read must return 0 rows, saw %', t, n_other;
        END IF;
    END LOOP;
    RAISE NOTICE 'tenant A isolation OK: 1 own row per sampled table, 0 cross-tenant rows';
END $$;

-- 6) Tenant B context sees ONLY tenant B rows (proves RESET between blocks).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM analytical_rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM analytics.metric_snapshots;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'analytics.metric_snapshots: tenant B must see exactly 1 row, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM analytics.metric_snapshots WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'analytics.metric_snapshots: cross-tenant read must return 0 rows, saw %', n_other;
    END IF;
    SELECT count(*) INTO n_all FROM security.risk_assessments;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'security.risk_assessments: tenant B must see exactly 1 row, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM security.risk_assessments WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'security.risk_assessments: cross-tenant read must return 0 rows, saw %', n_other;
    END IF;
    RAISE NOTICE 'tenant B isolation OK: 1 own snapshot + 1 own risk assessment, 0 cross-tenant rows';
END $$;

-- 7) Write path as tenant A: own INSERT/UPDATE/DELETE on every sampled
-- table + the assignment/exposure chain; cross-tenant UPDATE touches 0
-- rows; tenant_id rewrite and cross-tenant INSERT are rejected by WITH
-- CHECK (42501).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    expa uuid;
    expb uuid;
    assigna uuid;
    snapa uuid;
    scratch uuid;
    scratch_assign uuid;
    affected integer;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.expa, s.expb, s.assigna, s.snapa
      INTO ta, tb, expa, expb, assigna, snapa
      FROM analytical_rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;

    -- analytics.metric_snapshots scratch lifecycle (childless: definition
    -- rows never reference snapshots).
    INSERT INTO analytics.metric_snapshots (tenant_id, metric_key, bucket_start, value_minor)
    VALUES (ta, 'roll-an-scratch', now(), 50) RETURNING id INTO scratch;
    UPDATE analytics.metric_snapshots SET data_quality = 'PARTIAL' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own snapshot UPDATE must affect 1 row, affected %', affected;
    END IF;
    BEGIN
        UPDATE analytics.metric_snapshots SET tenant_id = tb WHERE id = scratch;
        RAISE EXCEPTION 'expected tenant_id rewrite to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO analytics.metric_snapshots (tenant_id, metric_key, bucket_start, value_minor)
        VALUES (tb, 'roll-an-cross', now(), 60);
        RAISE EXCEPTION 'expected cross-tenant snapshot INSERT to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    DELETE FROM analytics.metric_snapshots WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch snapshot DELETE must affect 1 row, affected %', affected;
    END IF;

    -- experiments.experiments scratch lifecycle (childless: no assignments
    -- reference it).
    INSERT INTO experiments.experiments (tenant_id, experiment_key, name)
    VALUES (ta, 'roll-an-scratch', 'Scratch') RETURNING id INTO scratch;
    UPDATE experiments.experiments SET name = 'Scratch 2' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own experiment UPDATE must affect 1 row, affected %', affected;
    END IF;
    UPDATE experiments.experiments SET name = 'Scratch X' WHERE id = expb;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'cross-tenant experiment UPDATE must touch 0 rows, touched %', affected;
    END IF;
    DELETE FROM experiments.experiments WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch experiment DELETE must affect 1 row, affected %', affected;
    END IF;

    -- experiment_assignments + experiment_exposures scratch chain under
    -- the fixture experiment (deleted in reverse FK order).
    INSERT INTO experiments.experiment_assignments (tenant_id, experiment_id, subject_type, subject_id, variant, assignment_version)
    VALUES (ta, expa, 'TENANT', ta::text || '-scratch', 'treatment', 1) RETURNING id INTO scratch_assign;
    INSERT INTO experiments.experiment_exposures (tenant_id, experiment_assignment_id, exposure_point, dedupe_key)
    VALUES (ta, scratch_assign, 'checkout', 'roll-an-scratch') RETURNING id INTO scratch;
    UPDATE experiments.experiment_exposures SET exposure_point = 'paywall' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own exposure UPDATE must affect 1 row, affected %', affected;
    END IF;
    DELETE FROM experiments.experiment_exposures WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch exposure DELETE must affect 1 row, affected %', affected;
    END IF;
    DELETE FROM experiments.experiment_assignments WHERE id = scratch_assign;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch assignment DELETE must affect 1 row, affected %', affected;
    END IF;

    -- security.risk_assessments scratch lifecycle (childless).
    INSERT INTO security.risk_assessments (tenant_id, subject_type, decision, policy_version)
    VALUES (ta, 'TENANT', 'REVIEW', 'v1') RETURNING id INTO scratch;
    UPDATE security.risk_assessments SET decision = 'DENY' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own risk assessment UPDATE must affect 1 row, affected %', affected;
    END IF;
    DELETE FROM security.risk_assessments WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch risk assessment DELETE must affect 1 row, affected %', affected;
    END IF;

    RAISE NOTICE 'write path OK: own CRUD on sampled tables + assignment/exposure chain, cross-tenant UPDATE filtered, rewrite + cross-tenant INSERT rejected (42501)';
END $$;

-- 8) Fail-closed: app role with NO tenant context sees nothing and cannot insert.
DO $$
DECLARE
    ta uuid;
    expa uuid;
    assigna uuid;
    n integer;
    sampled text[] := ARRAY[
        'analytics.metric_definitions',
        'analytics.metric_snapshots',
        'experiments.experiments',
        'experiments.experiment_assignments',
        'experiments.experiment_exposures',
        'security.risk_assessments'
    ];
    t text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.expa, s.assigna INTO ta, expa, assigna FROM analytical_rollout_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    FOREACH t IN ARRAY sampled LOOP
        EXECUTE format('SELECT count(*) FROM %s', t) INTO n;
        IF n <> 0 THEN
            RAISE EXCEPTION '%: app role without tenant context must see 0 rows, saw %', t, n;
        END IF;
    END LOOP;
    BEGIN
        INSERT INTO analytics.metric_snapshots (tenant_id, metric_key, bucket_start, value_minor)
        VALUES (ta, 'roll-an-noctx', now(), 10);
        RAISE EXCEPTION 'expected no-context snapshot INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO experiments.experiments (tenant_id, experiment_key, name)
        VALUES (ta, 'roll-an-noctx', 'No-context');
        RAISE EXCEPTION 'expected no-context experiment INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO security.risk_assessments (tenant_id, subject_type, decision, policy_version)
        VALUES (ta, 'TENANT', 'ALLOW', 'v1');
        RAISE EXCEPTION 'expected no-context risk assessment INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'fail-closed OK: no tenant context => 0 rows + INSERTs rejected';
END $$;

-- 9) Owner/superuser bypasses RLS: sees BOTH tenants regardless of context.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM analytical_rollout_ids s LIMIT 1;
    SELECT count(*) INTO n FROM analytics.metric_snapshots WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout snapshots, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM experiments.experiments WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout experiments, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM experiments.experiment_exposures WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout exposures, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM security.risk_assessments WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout risk assessments, saw %', n;
    END IF;
    RAISE NOTICE 'owner bypass OK: superuser sees all tenants (BYPASSRLS)';
END $$;

ROLLBACK;
