-- 008 RLS domain rollout (migration 042): crm.* + communication.* as iptv_app.
-- Representative sample: crm.leads, crm.customer_health_snapshots,
-- communication.conversations, communication.messages,
-- communication.tenant_channels, communication.exceptions.
-- Plus: grant/policy/RLS preconditions on ALL 13 enforced tables
-- (042's 12 + 041's crm.customers), global-table allow-list assertion
-- (zero global tables exist in crm/communication scope — every table carries
-- tenant_id, so no allow-list exception policy is expected), and owner bypass.
-- Fixture rows ROLLBACK; role/policy/grants persist.
-- Execute: cat file | docker exec -i iptv-postgres-1 psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
-- (006 regression: db/tests/006_rls_spike.sql; 007 regression: db/tests/007_rls_app_role_pilot.sql.)
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 041+042 preconditions on all 13 enforced tables.
DO $$
DECLARE
    tables text[] := ARRAY[
        'crm.customers',
        'crm.leads',
        'crm.customer_health_snapshots',
        'communication.conversations',
        'communication.messages',
        'communication.message_deliveries',
        'communication.communication_preferences',
        'communication.communication_suppressions',
        'communication.conversation_control_events',
        'communication.tenant_channels',
        'communication.exceptions',
        'communication.message_intents',
        'communication.scheduled_contacts'
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
    RAISE NOTICE 'rollout preconditions OK: iptv_app NOBYPASSRLS, RLS + tenant_isolation + DML grants on 13 tables';
END $$;

-- 2) Allow-list assertion: no global (tenant_id-less) table may exist in
-- crm/communication scope without an explicit exception policy. Today the
-- count is 0 — every table carries tenant_id and uses the tenant template.
DO $$
DECLARE
    n_global integer;
BEGIN
    SELECT count(*) INTO n_global
    FROM pg_tables pt
    WHERE pt.schemaname IN ('crm', 'communication')
      AND pt.tablename NOT IN (
          SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
          WHERE n.nspname IN ('crm', 'communication') AND c.relkind = 'r'
      );
    IF n_global <> 0 THEN
        RAISE EXCEPTION 'global-table allow-list violated: % table(s) without tenant_id need an explicit exception policy', n_global;
    END IF;
    RAISE NOTICE 'allow-list OK: 0 global tables in crm/communication scope (no exception policy needed)';
END $$;

-- 3) Fixture: two tenants, persons, and one row per sampled table each (as owner).
CREATE TEMP TABLE rollout_ids (
    ta uuid, tb uuid, pa uuid, pb uuid,
    custa uuid, custb uuid, conva uuid, convb uuid
);

DO $$
DECLARE
    ta uuid;
    tb uuid;
    pa uuid;
    pb uuid;
    custa uuid;
    custb uuid;
    conva uuid;
    convb uuid;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-roll-a-' || gen_random_uuid(), 'RLS Rollout A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-roll-b-' || gen_random_uuid(), 'RLS Rollout B') RETURNING id INTO tb;
    INSERT INTO identity.persons (tenant_id) VALUES (ta) RETURNING id INTO pa;
    INSERT INTO identity.persons (tenant_id) VALUES (tb) RETURNING id INTO pb;
    INSERT INTO crm.customers (tenant_id, person_id) VALUES (ta, pa) RETURNING id INTO custa;
    INSERT INTO crm.customers (tenant_id, person_id) VALUES (tb, pb) RETURNING id INTO custb;
    INSERT INTO communication.conversations (tenant_id, person_id, channel)
    VALUES (ta, pa, 'WHATSAPP') RETURNING id INTO conva;
    INSERT INTO communication.conversations (tenant_id, person_id, channel)
    VALUES (tb, pb, 'WHATSAPP') RETURNING id INTO convb;
    INSERT INTO crm.leads (tenant_id, person_id) VALUES (ta, pa);
    INSERT INTO crm.leads (tenant_id, person_id) VALUES (tb, pb);
    INSERT INTO crm.customer_health_snapshots (tenant_id, customer_id, score, risk_level, model_or_rule_version)
    VALUES (ta, custa, 80.5, 'LOW', 'v1'), (tb, custb, 42.0, 'HIGH', 'v1');
    INSERT INTO communication.messages (tenant_id, conversation_id, person_id, direction, channel, sender_type, body_text, occurred_at)
    VALUES (ta, conva, pa, 'INBOUND', 'WHATSAPP', 'PERSON', 'hello a', now()),
           (tb, convb, pb, 'INBOUND', 'WHATSAPP', 'PERSON', 'hello b', now());
    INSERT INTO communication.tenant_channels (tenant_id, channel, tenant_key)
    VALUES (ta, 'WHATSAPP', 'roll-a-' || gen_random_uuid()),
           (tb, 'WHATSAPP', 'roll-b-' || gen_random_uuid());
    INSERT INTO communication.exceptions (tenant_id, kind, reason)
    VALUES (ta, 'UNMATCHED_INBOUND', 'rollout fixture a'),
           (tb, 'UNMATCHED_INBOUND', 'rollout fixture b');
    INSERT INTO rollout_ids (ta, tb, pa, pb, custa, custb, conva, convb)
    VALUES (ta, tb, pa, pb, custa, custb, conva, convb);
    RAISE NOTICE 'rollout fixture ready: tenants % / %', ta, tb;
END $$;

-- 4) Tenant A context sees ONLY tenant A rows on every sampled table.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
    sampled text[] := ARRAY[
        'crm.leads',
        'crm.customer_health_snapshots',
        'communication.conversations',
        'communication.messages',
        'communication.tenant_channels',
        'communication.exceptions'
    ];
    t text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;
    FOREACH t IN ARRAY sampled LOOP
        EXECUTE format('SELECT count(*) FROM %s', t) INTO n_all;
        IF n_all <> 1 AND t <> 'communication.messages' THEN
            -- messages: exactly 1 per tenant as well
            RAISE EXCEPTION '%: tenant A app role must see exactly 1 row, saw %', t, n_all;
        END IF;
        IF t = 'communication.messages' AND n_all <> 1 THEN
            RAISE EXCEPTION '%: tenant A app role must see exactly 1 row, saw %', t, n_all;
        END IF;
        EXECUTE format('SELECT count(*) FROM %s WHERE tenant_id = %L', t, tb) INTO n_other;
        IF n_other <> 0 THEN
            RAISE EXCEPTION '%: cross-tenant read must return 0 rows, saw %', t, n_other;
        END IF;
    END LOOP;
    RAISE NOTICE 'tenant A isolation OK: 1 own row per sampled table, 0 cross-tenant rows';
END $$;

-- 5) Tenant B context sees ONLY tenant B rows (proves RESET between blocks).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
    sampled text[] := ARRAY[
        'crm.leads',
        'crm.customer_health_snapshots',
        'communication.conversations',
        'communication.messages',
        'communication.tenant_channels',
        'communication.exceptions'
    ];
    t text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    SET LOCAL ROLE iptv_app;
    FOREACH t IN ARRAY sampled LOOP
        EXECUTE format('SELECT count(*) FROM %s', t) INTO n_all;
        IF n_all <> 1 THEN
            RAISE EXCEPTION '%: tenant B app role must see exactly 1 row, saw %', t, n_all;
        END IF;
        EXECUTE format('SELECT count(*) FROM %s WHERE tenant_id = %L', t, ta) INTO n_other;
        IF n_other <> 0 THEN
            RAISE EXCEPTION '%: cross-tenant read must return 0 rows, saw %', t, n_other;
        END IF;
    END LOOP;
    RAISE NOTICE 'tenant B isolation OK: 1 own row per sampled table, 0 cross-tenant rows';
END $$;

-- 6) Fail-closed: app role with NO tenant context sees nothing on sampled tables.
DO $$
DECLARE
    n integer;
    sampled text[] := ARRAY[
        'crm.leads',
        'crm.customer_health_snapshots',
        'communication.conversations',
        'communication.messages',
        'communication.tenant_channels',
        'communication.exceptions'
    ];
    t text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SET LOCAL ROLE iptv_app;
    FOREACH t IN ARRAY sampled LOOP
        EXECUTE format('SELECT count(*) FROM %s', t) INTO n;
        IF n <> 0 THEN
            RAISE EXCEPTION '%: app role without tenant context must see 0 rows, saw %', t, n;
        END IF;
    END LOOP;
    RAISE NOTICE 'fail-closed OK: no tenant context => 0 rows on all sampled tables';
END $$;

-- 7) Cross-tenant WRITE blocked by WITH CHECK on sampled tables.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    pb uuid;
    convb uuid;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.pb, s.convb INTO ta, tb, pb, convb FROM rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;
    BEGIN
        INSERT INTO crm.leads (tenant_id, person_id) VALUES (tb, pb);
        RAISE EXCEPTION 'expected cross-tenant lead insert to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO communication.conversations (tenant_id, person_id, channel)
        VALUES (tb, pb, 'WHATSAPP');
        RAISE EXCEPTION 'expected cross-tenant conversation insert to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO communication.messages (tenant_id, conversation_id, person_id, direction, channel, sender_type, body_text, occurred_at)
        VALUES (tb, convb, pb, 'INBOUND', 'WHATSAPP', 'PERSON', 'x-ten', now());
        RAISE EXCEPTION 'expected cross-tenant message insert to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO communication.exceptions (tenant_id, kind, reason)
        VALUES (tb, 'UNMATCHED_INBOUND', 'x-ten');
        RAISE EXCEPTION 'expected cross-tenant exception insert to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'cross-tenant write blocked OK (WITH CHECK => insufficient_privilege on sampled tables)';
END $$;

-- 8) Owner/superuser bypasses RLS: sees BOTH tenants regardless of context.
DO $$
DECLARE
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT count(*) INTO n FROM crm.leads
    WHERE tenant_id IN (SELECT s.ta FROM rollout_ids s UNION SELECT s.tb FROM rollout_ids s);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout leads, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM communication.conversations
    WHERE tenant_id IN (SELECT s.ta FROM rollout_ids s UNION SELECT s.tb FROM rollout_ids s);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout conversations, saw %', n;
    END IF;
    RAISE NOTICE 'owner bypass OK: superuser sees all tenants (BYPASSRLS)';
END $$;

ROLLBACK;
