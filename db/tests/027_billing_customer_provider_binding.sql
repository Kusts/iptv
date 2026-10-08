-- 027 Billing customer<->provider binding proof (migration 060, GAP-LOOP-1).
-- RLS `tenant_isolation` + DML grants on `billing.customer_provider_bindings`,
-- global-table allow-list re-assertion (0 globals in billing scope — the new
-- table carries tenant_id NOT NULL, so no exception policy is expected),
-- outbox-role boundary on the new table (050 EXECUTE-only), tenant A/B
-- isolation, BOTH uniques (person_unique + external_unique, incl.
-- cross-tenant external-id reuse allowed), no-context fail-closed, owner
-- bypass. Fixture rows ROLLBACK; role/policy/grants persist.
-- Execute: cat file | docker exec -i iptv-postgres-1 psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 060 preconditions on the new table.
DO $$
BEGIN
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'iptv_app') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'app role iptv_app must exist with NOBYPASSRLS';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'billing.customer_provider_bindings'::regclass) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'RLS is not enabled on billing.customer_provider_bindings';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'billing'
          AND tablename = 'customer_provider_bindings'
          AND policyname = 'tenant_isolation'
    ) THEN
        RAISE EXCEPTION 'tenant_isolation policy missing on billing.customer_provider_bindings';
    END IF;
    IF has_table_privilege('iptv_app', 'billing.customer_provider_bindings', 'SELECT') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'billing.customer_provider_bindings', 'INSERT') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'billing.customer_provider_bindings', 'UPDATE') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'billing.customer_provider_bindings', 'DELETE') IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'app role lacks full DML grants on billing.customer_provider_bindings';
    END IF;
    -- Both uniques exist with the documented tenant-scoped shape.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'customer_provider_bindings_person_unique'
          AND conrelid = 'billing.customer_provider_bindings'::regclass
    ) THEN
        RAISE EXCEPTION 'customer_provider_bindings_person_unique missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'customer_provider_bindings_external_unique'
          AND conrelid = 'billing.customer_provider_bindings'::regclass
    ) THEN
        RAISE EXCEPTION 'customer_provider_bindings_external_unique missing';
    END IF;
    RAISE NOTICE 'preconditions OK: iptv_app NOBYPASSRLS, RLS + tenant_isolation + DML + both uniques';
END $$;

-- 2) Allow-list assertion: no global (tenant_id-less) table may exist in
-- billing scope without an explicit exception policy. Stays 0 after 060 —
-- the new table carries tenant_id NOT NULL and uses the tenant template.
DO $$
DECLARE
    n_global integer;
BEGIN
    SELECT count(*) INTO n_global
    FROM pg_tables pt
    WHERE pt.schemaname = 'billing'
      AND pt.tablename NOT IN (
          SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
          WHERE n.nspname = 'billing' AND c.relkind = 'r'
      );
    IF n_global <> 0 THEN
        RAISE EXCEPTION 'global-table allow-list violated: % table(s) without tenant_id need an explicit exception policy', n_global;
    END IF;
    RAISE NOTICE 'allow-list OK: 0 global tables in billing scope (no exception policy needed)';
END $$;

-- 3) Outbox-role boundary (migration 050 EXECUTE-only): neither the worker
-- identity nor the executor may hold ANY direct privilege on the new table.
DO $$
BEGIN
    IF has_table_privilege('outbox_worker', 'billing.customer_provider_bindings', 'SELECT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_worker', 'billing.customer_provider_bindings', 'INSERT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_worker', 'billing.customer_provider_bindings', 'UPDATE') IS DISTINCT FROM false
        OR has_table_privilege('outbox_worker', 'billing.customer_provider_bindings', 'DELETE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_worker must hold no privilege on billing.customer_provider_bindings (050 EXECUTE-only boundary)';
    END IF;
    IF has_table_privilege('outbox_executor', 'billing.customer_provider_bindings', 'SELECT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_executor', 'billing.customer_provider_bindings', 'INSERT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_executor', 'billing.customer_provider_bindings', 'UPDATE') IS DISTINCT FROM false
        OR has_table_privilege('outbox_executor', 'billing.customer_provider_bindings', 'DELETE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_executor must hold no privilege on billing.customer_provider_bindings (050 EXECUTE-only boundary)';
    END IF;
    RAISE NOTICE 'outbox boundary OK: worker/executor hold nothing on the binding table';
END $$;

-- 4) Fixture: two tenants, one person + one binding each, as owner.
CREATE TEMP TABLE binding_proof_ids (ta uuid, tb uuid, pa uuid, pb uuid);

DO $$
DECLARE
    ta uuid; tb uuid; pa uuid; pb uuid;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('bind-proof-a-' || gen_random_uuid(), 'Binding Proof A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('bind-proof-b-' || gen_random_uuid(), 'Binding Proof B') RETURNING id INTO tb;
    INSERT INTO identity.persons (tenant_id) VALUES (ta) RETURNING id INTO pa;
    INSERT INTO identity.persons (tenant_id) VALUES (tb) RETURNING id INTO pb;
    INSERT INTO billing.customer_provider_bindings (tenant_id, person_id, provider, external_customer_id)
    VALUES (ta, pa, 'ASAAS', 'cus-proof-a-' || gen_random_uuid()),
           (tb, pb, 'ASAAS', 'cus-proof-b-' || gen_random_uuid());
    INSERT INTO binding_proof_ids VALUES (ta, tb, pa, pb);
    RAISE NOTICE 'binding fixture ready: tenants % / %', ta, tb;
END $$;

-- 5) Tenant A context sees ONLY tenant A bindings.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM binding_proof_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM billing.customer_provider_bindings;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'tenant A app role must see exactly 1 binding, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM billing.customer_provider_bindings WHERE tenant_id = tb;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'cross-tenant binding read must return 0 rows, saw %', n_other;
    END IF;
    RAISE NOTICE 'tenant A isolation OK: 1 own binding, 0 cross-tenant rows';
END $$;

-- 6) Tenant B context sees ONLY tenant B bindings.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM binding_proof_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM billing.customer_provider_bindings;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'tenant B app role must see exactly 1 binding, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM billing.customer_provider_bindings WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'cross-tenant binding read must return 0 rows, saw %', n_other;
    END IF;
    RAISE NOTICE 'tenant B isolation OK: 1 own binding, 0 cross-tenant rows';
END $$;

-- 7) Uniqueness: second binding for the same (tenant, person, provider) is
-- rejected; second person claiming the same (tenant, provider, external id)
-- is rejected; the SAME external id under the OTHER tenant is allowed
-- (uniques are tenant-scoped by design — see 060 header).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    pa uuid;
    pb uuid;
    pa2 uuid;
    pb2 uuid;
    exta text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.pa, s.pb INTO ta, tb, pa, pb FROM binding_proof_ids s LIMIT 1;
    SELECT external_customer_id INTO exta FROM billing.customer_provider_bindings
    WHERE tenant_id = ta LIMIT 1;

    -- Duplicate (tenant, person, provider).
    BEGIN
        INSERT INTO billing.customer_provider_bindings (tenant_id, person_id, provider, external_customer_id)
        VALUES (ta, pa, 'ASAAS', 'cus-other-' || gen_random_uuid());
        RAISE EXCEPTION 'expected person_unique violation for duplicate (tenant, person, provider)';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    -- Duplicate (tenant, provider, external id) claimed by another person.
    BEGIN
        INSERT INTO identity.persons (tenant_id) VALUES (ta) RETURNING id INTO pa2;
        INSERT INTO billing.customer_provider_bindings (tenant_id, person_id, provider, external_customer_id)
        VALUES (ta, pa2, 'ASAAS', exta);
        RAISE EXCEPTION 'expected external_unique violation for duplicate (tenant, provider, external id)';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    -- Same external id under the OTHER tenant: allowed (tenant-scoped).
    INSERT INTO identity.persons (tenant_id) VALUES (tb) RETURNING id INTO pb2;
    INSERT INTO billing.customer_provider_bindings (tenant_id, person_id, provider, external_customer_id)
    VALUES (tb, pb2, 'ASAAS', exta);
    RAISE NOTICE 'uniques OK: person + external enforced per tenant, cross-tenant external reuse allowed';
END $$;

-- 8) Write path as tenant A: own INSERT/UPDATE/DELETE succeed; cross-tenant
-- UPDATE touches 0 rows; tenant_id rewrite rejected (WITH CHECK => 42501);
-- cross-tenant INSERT rejected the same way.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    pa uuid;
    pb uuid;
    scratch uuid;
    affected integer;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.pa, s.pb INTO ta, tb, pa, pb FROM binding_proof_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;

    INSERT INTO identity.persons (tenant_id) VALUES (ta) RETURNING id INTO scratch;
    INSERT INTO billing.customer_provider_bindings (tenant_id, person_id, provider, external_customer_id)
    VALUES (ta, scratch, 'ASAAS', 'cus-scratch-' || gen_random_uuid()) RETURNING id INTO scratch;
    SELECT count(*) INTO n FROM billing.customer_provider_bindings WHERE id = scratch;
    IF n <> 1 THEN
        RAISE EXCEPTION 'own binding INSERT must be visible, saw % rows', n;
    END IF;
    UPDATE billing.customer_provider_bindings SET external_customer_id = 'cus-moved-' || gen_random_uuid() WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own binding UPDATE must affect 1 row, affected %', affected;
    END IF;
    UPDATE billing.customer_provider_bindings SET external_customer_id = 'cus-x' WHERE tenant_id = tb;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'cross-tenant binding UPDATE must touch 0 rows, touched %', affected;
    END IF;
    BEGIN
        UPDATE billing.customer_provider_bindings SET tenant_id = tb WHERE id = scratch;
        RAISE EXCEPTION 'expected tenant_id rewrite to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO billing.customer_provider_bindings (tenant_id, person_id, provider, external_customer_id)
        VALUES (tb, pb, 'ASAAS', 'cus-x-' || gen_random_uuid());
        RAISE EXCEPTION 'expected cross-tenant binding INSERT to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    DELETE FROM billing.customer_provider_bindings WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch binding DELETE must affect 1 row, affected %', affected;
    END IF;
    RAISE NOTICE 'write path OK: own CRUD lands, cross-tenant filtered, tenant_id rewrite + cross-tenant INSERT rejected (42501)';
END $$;

-- 9) Fail-closed: app role with NO tenant context sees nothing and cannot insert.
DO $$
DECLARE
    ta uuid;
    pa uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.pa INTO ta, pa FROM binding_proof_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM billing.customer_provider_bindings;
    IF n <> 0 THEN
        RAISE EXCEPTION 'app role without tenant context must see 0 bindings, saw %', n;
    END IF;
    BEGIN
        INSERT INTO billing.customer_provider_bindings (tenant_id, person_id, provider, external_customer_id)
        VALUES (ta, pa, 'ASAAS', 'cus-noctx-' || gen_random_uuid());
        RAISE EXCEPTION 'expected no-context binding INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'fail-closed OK: no tenant context => 0 rows + INSERT rejected';
END $$;

-- 10) Owner bypasses RLS: sees BOTH tenants regardless of context.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM binding_proof_ids s LIMIT 1;
    SELECT count(*) INTO n FROM billing.customer_provider_bindings WHERE tenant_id IN (ta, tb);
    IF n < 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see both tenants bindings, saw %', n;
    END IF;
    RAISE NOTICE 'owner bypass OK: superuser sees all tenants (BYPASSRLS)';
END $$;

ROLLBACK;
