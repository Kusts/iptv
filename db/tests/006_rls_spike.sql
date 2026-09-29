-- Wave 0 spike: RLS multi-tenant isolation proof (PostgreSQL 17, local).
-- Representative core tables: crm.customers + communication.conversations
-- (both tenant_id + composite (tenant_id, person_id) FK to identity.persons).
-- Runs inside ONE transaction and ROLLBACKs: proves the pattern with ZERO
-- persistent schema change (no production migration in this spike).
-- Execute: cat file | docker exec -i iptv-postgres-1 psql -U iptv -d iptv -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on
BEGIN;

-- 1) Non-privileged app role: NOLOGIN + NOBYPASSRLS (vs owner/superuser iptv).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iptv_app_spike') THEN
        CREATE ROLE iptv_app_spike NOLOGIN NOBYPASSRLS;
    END IF;
END $$;

DO $$
DECLARE
    v_bypass boolean;
BEGIN
    SELECT rolbypassrls INTO v_bypass FROM pg_roles WHERE rolname = 'iptv_app_spike';
    IF v_bypass IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'spike app role must NOT have BYPASSRLS';
    END IF;
    RAISE NOTICE 'spike app role iptv_app_spike confirmed NOBYPASSRLS';
END $$;

GRANT USAGE ON SCHEMA crm TO iptv_app_spike;
GRANT USAGE ON SCHEMA communication TO iptv_app_spike;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm.customers TO iptv_app_spike;
GRANT SELECT, INSERT, UPDATE, DELETE ON communication.conversations TO iptv_app_spike;

-- 2) Enable RLS + tenant policy on the two representative tables.
ALTER TABLE crm.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication.conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON crm.customers;
CREATE POLICY tenant_isolation ON crm.customers
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON communication.conversations;
CREATE POLICY tenant_isolation ON communication.conversations
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- 3) Fixture: two tenants, one person/customer/conversation each (as owner).
CREATE TEMP TABLE spike_ids (
    ta uuid, tb uuid, pa uuid, pb uuid
);

DO $$
DECLARE
    ta uuid;
    tb uuid;
    pa uuid;
    pb uuid;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-spike-a-' || gen_random_uuid(), 'RLS Spike A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-spike-b-' || gen_random_uuid(), 'RLS Spike B') RETURNING id INTO tb;
    INSERT INTO identity.persons (tenant_id) VALUES (ta) RETURNING id INTO pa;
    INSERT INTO identity.persons (tenant_id) VALUES (tb) RETURNING id INTO pb;
    INSERT INTO crm.customers (tenant_id, person_id) VALUES (ta, pa);
    INSERT INTO crm.customers (tenant_id, person_id) VALUES (tb, pb);
    INSERT INTO communication.conversations (tenant_id, person_id, channel)
    VALUES (ta, pa, 'WHATSAPP');
    INSERT INTO communication.conversations (tenant_id, person_id, channel)
    VALUES (tb, pb, 'WHATSAPP');
    INSERT INTO spike_ids (ta, tb, pa, pb) VALUES (ta, tb, pa, pb);
    RAISE NOTICE 'spike fixture ready: tenants % / %', ta, tb;
END $$;

-- 4) App role with tenant A context sees ONLY tenant A rows.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
BEGIN
    SELECT s.ta, s.tb INTO ta, tb FROM spike_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app_spike;
    SELECT count(*) INTO n_all FROM crm.customers;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'tenant A app role must see exactly 1 customer, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM crm.customers WHERE tenant_id = tb;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'cross-tenant customer read must return 0 rows, saw %', n_other;
    END IF;
    SELECT count(*) INTO n_all FROM communication.conversations;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'tenant A app role must see exactly 1 conversation, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM communication.conversations WHERE tenant_id = tb;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'cross-tenant conversation read must return 0 rows, saw %', n_other;
    END IF;
    RAISE NOTICE 'tenant A isolation OK: 1 own row per table, 0 cross-tenant rows';
END $$;

-- 5) App role with tenant B context sees ONLY tenant B rows.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
BEGIN
    RESET ROLE;
    SELECT s.ta, s.tb INTO ta, tb FROM spike_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    SET LOCAL ROLE iptv_app_spike;
    SELECT count(*) INTO n_all FROM crm.customers;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'tenant B app role must see exactly 1 customer, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM crm.customers WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'cross-tenant customer read must return 0 rows, saw %', n_other;
    END IF;
    SELECT count(*) INTO n_all FROM communication.conversations;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'tenant B app role must see exactly 1 conversation, saw %', n_all;
    END IF;
    RAISE NOTICE 'tenant B isolation OK: 1 own row per table, 0 cross-tenant rows';
END $$;

-- 6) Fail-closed: app role with NO tenant context sees nothing.
DO $$
DECLARE
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SET LOCAL ROLE iptv_app_spike;
    SELECT count(*) INTO n FROM crm.customers;
    IF n <> 0 THEN
        RAISE EXCEPTION 'app role without tenant context must see 0 customers, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM communication.conversations;
    IF n <> 0 THEN
        RAISE EXCEPTION 'app role without tenant context must see 0 conversations, saw %', n;
    END IF;
    RAISE NOTICE 'fail-closed OK: no tenant context => 0 rows';
END $$;

-- 7) Cross-tenant WRITE blocked by WITH CHECK (tenant A context, tenant B row).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    pb uuid;
BEGIN
    RESET ROLE;
    SELECT s.ta, s.tb, s.pb INTO ta, tb, pb FROM spike_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app_spike;
    BEGIN
        INSERT INTO crm.customers (tenant_id, person_id) VALUES (tb, pb);
        RAISE EXCEPTION 'expected cross-tenant customer insert to fail';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    BEGIN
        INSERT INTO communication.conversations (tenant_id, person_id, channel)
        VALUES (tb, pb, 'WHATSAPP');
        RAISE EXCEPTION 'expected cross-tenant conversation insert to fail';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    RAISE NOTICE 'cross-tenant write blocked OK (WITH CHECK => insufficient_privilege)';
END $$;

-- 8) Owner/superuser bypasses RLS: sees BOTH tenants regardless of context.
DO $$
DECLARE
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT count(*) INTO n FROM crm.customers
    WHERE tenant_id IN (SELECT s.ta FROM spike_ids s UNION SELECT s.tb FROM spike_ids s);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 spike customers, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM communication.conversations
    WHERE tenant_id IN (SELECT s.ta FROM spike_ids s UNION SELECT s.tb FROM spike_ids s);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 spike conversations, saw %', n;
    END IF;
    RAISE NOTICE 'owner bypass OK: superuser sees both tenants (BYPASSRLS)';
END $$;

ROLLBACK;
