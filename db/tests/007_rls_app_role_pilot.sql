-- 007 RLS app-role pilot (persistent policy from migration 041).
-- Proves the production path on crm.customers: iptv_app (NOBYPASSRLS) is
-- isolated per tenant via SET LOCAL app.tenant_id, fail-closed without
-- context, owner bypass intact. Fixture rows ROLLBACK; role/policy persist.
-- Execute: cat file | docker exec -i iptv-postgres-1 psql -U iptv -d iptv -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 041 preconditions: role exists, NOBYPASSRLS, pilot grants.
DO $$
DECLARE
    v_bypass boolean;
BEGIN
    SELECT rolbypassrls INTO v_bypass FROM pg_roles WHERE rolname = 'iptv_app';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'migration 041 not applied: role iptv_app is missing';
    END IF;
    IF v_bypass IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'app role must NOT have BYPASSRLS';
    END IF;
    IF has_table_privilege('iptv_app', 'crm.customers', 'SELECT') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'crm.customers', 'INSERT') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'crm.customers', 'UPDATE') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'crm.customers', 'DELETE') IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'app role lacks full DML grants on crm.customers';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'crm.customers'::regclass) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'RLS is not enabled on crm.customers';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname = 'crm' AND tablename = 'customers' AND policyname = 'tenant_isolation'
    ) THEN
        RAISE EXCEPTION 'tenant_isolation policy missing on crm.customers';
    END IF;
    RAISE NOTICE 'pilot preconditions OK: iptv_app NOBYPASSRLS with DML grants, RLS + policy on crm.customers';
END $$;

-- 2) Fixture: two tenants, one person/customer each (as owner, bypasses RLS).
CREATE TEMP TABLE pilot_ids (
    ta uuid, tb uuid, pa uuid, pb uuid, pa2 uuid, pb2 uuid
);

DO $$
DECLARE
    ta uuid;
    tb uuid;
    pa uuid;
    pb uuid;
    pa2 uuid;
    pb2 uuid;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-pilot-a-' || gen_random_uuid(), 'RLS Pilot A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-pilot-b-' || gen_random_uuid(), 'RLS Pilot B') RETURNING id INTO tb;
    INSERT INTO identity.persons (tenant_id) VALUES (ta) RETURNING id INTO pa;
    INSERT INTO identity.persons (tenant_id) VALUES (tb) RETURNING id INTO pb;
    INSERT INTO identity.persons (tenant_id) VALUES (ta) RETURNING id INTO pa2;
    INSERT INTO identity.persons (tenant_id) VALUES (tb) RETURNING id INTO pb2;
    INSERT INTO crm.customers (tenant_id, person_id) VALUES (ta, pa);
    INSERT INTO crm.customers (tenant_id, person_id) VALUES (tb, pb);
    INSERT INTO pilot_ids (ta, tb, pa, pb, pa2, pb2) VALUES (ta, tb, pa, pb, pa2, pb2);
    RAISE NOTICE 'pilot fixture ready: tenants % / %', ta, tb;
END $$;

-- 3) Tenant A context sees ONLY tenant A rows.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM pilot_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM crm.customers;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'tenant A app role must see exactly 1 customer, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM crm.customers WHERE tenant_id = tb;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'cross-tenant customer read must return 0 rows, saw %', n_other;
    END IF;
    RAISE NOTICE 'tenant A isolation OK: 1 own row, 0 cross-tenant rows';
END $$;

-- 4) Tenant B context sees ONLY tenant B rows (proves RESET between blocks).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM pilot_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM crm.customers;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'tenant B app role must see exactly 1 customer, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM crm.customers WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'cross-tenant customer read must return 0 rows, saw %', n_other;
    END IF;
    RAISE NOTICE 'tenant B isolation OK: 1 own row, 0 cross-tenant rows';
END $$;

-- 5) Fail-closed: app role with NO tenant context sees nothing.
DO $$
DECLARE
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM crm.customers;
    IF n <> 0 THEN
        RAISE EXCEPTION 'app role without tenant context must see 0 customers, saw %', n;
    END IF;
    RAISE NOTICE 'fail-closed OK: no tenant context => 0 rows';
END $$;

-- 6) Own-tenant write succeeds; cross-tenant write blocked by WITH CHECK.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    pa2 uuid;
    pb2 uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.pa2, s.pb2 INTO ta, tb, pa2, pb2 FROM pilot_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;
    INSERT INTO crm.customers (tenant_id, person_id) VALUES (ta, pa2);
    SELECT count(*) INTO n FROM crm.customers;
    IF n <> 2 THEN
        RAISE EXCEPTION 'tenant A app role must see 2 customers after own insert, saw %', n;
    END IF;
    BEGIN
        INSERT INTO crm.customers (tenant_id, person_id) VALUES (tb, pb2);
        RAISE EXCEPTION 'expected cross-tenant customer insert to fail';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    RAISE NOTICE 'write path OK: own-tenant insert visible, cross-tenant blocked (WITH CHECK => insufficient_privilege)';
END $$;

-- 7) Owner/superuser bypasses RLS: sees BOTH tenants regardless of context.
DO $$
DECLARE
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT count(*) INTO n FROM crm.customers
    WHERE tenant_id IN (SELECT s.ta FROM pilot_ids s UNION SELECT s.tb FROM pilot_ids s);
    IF n <> 3 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 3 pilot customers, saw %', n;
    END IF;
    RAISE NOTICE 'owner bypass OK: superuser sees all tenants (BYPASSRLS)';
END $$;

ROLLBACK;
