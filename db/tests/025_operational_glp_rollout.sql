-- 025 RLS domain rollout (migration 058): referral.* + loyalty.* +
-- growth.* + partners.* (tenant-scoped) as iptv_app.
-- Representative sample, one table per schema: referral.referrals,
-- loyalty.rewards, growth.campaigns, partners.partner_accounts. Plus:
-- grant/policy/RLS preconditions on ALL 24 enrolled tables, allow-list
-- assertion (exactly two tenant_id-less GLOBAL tables in scope —
-- partners.learning_content{,_versions} with no tenant_id and no RLS by
-- design — plus the third 058 global agent.agent_releases asserted
-- explicitly as NOT enrolled here, plus the 042-enrolled
-- communication.message_intents/scheduled_contacts asserted explicitly as
-- NOT enrolled here, plus the 058 tenant-scoped partners.learning_progress
-- asserted explicitly as enrolled here), GLOBAL readability without tenant
-- context (SELECT-only surface: readable, not writable), outbox-role
-- boundary assertion (050 EXECUTE-only: outbox_worker/outbox_executor hold
-- NOTHING on these tables), and owner bypass. Covers: own CRUD on all 4
-- sampled tables + learning_progress, cross-tenant 0 rows, tenant_id
-- rewrite rejected (WITH CHECK => 42501), cross-tenant INSERT rejected,
-- no-context fail-closed (SELECT 0 rows + INSERT rejected). The remaining
-- 19 enrolled tables are covered by the preconditions (RLS +
-- tenant_isolation + DML) plus the allow-list sweep — declared coverage, not
-- row-exhaustive.
-- Fixture rows ROLLBACK; role/policy/grants persist.
-- Execute: cat file | docker exec -i iptv-pg-test psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
-- (Regression: db/tests/022, 024.)
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 058 preconditions on all 24 enforced tables.
DO $$
DECLARE
    tables text[] := ARRAY[
        'referral.referral_programs',
        'referral.referrals',
        'referral.referral_qualifications',
        'referral.referral_reward_links',
        'loyalty.reward_definitions',
        'loyalty.rewards',
        'loyalty.reward_ledger_entries',
        'loyalty.gift_passes',
        'growth.campaigns',
        'growth.campaign_versions',
        'growth.audience_definitions',
        'growth.audience_members',
        'growth.creatives',
        'growth.attribution_touches',
        'growth.conversion_events',
        'partners.partner_accounts',
        'partners.partner_relationships',
        'partners.partner_capabilities',
        'partners.reseller_credit_entries',
        'partners.reseller_credit_reservations',
        'partners.reseller_price_books',
        'partners.reseller_orders',
        'partners.learning_progress',
        'partners.partner_memberships'
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
    RAISE NOTICE 'rollout preconditions OK: iptv_app NOBYPASSRLS, RLS + tenant_isolation + DML grants on 24 tables';
END $$;

-- 2) Allow-list assertion: every tenant_id-bearing table in the 4-schema
-- scope must carry the enrolled tenant template (zero unenrolled — the
-- full 058 set is enrolled here); every tenant_id-less table in scope must
-- be exactly the TWO documented academy globals
-- (partners.learning_content{,_versions} -> slice 058, no tenant_id, no
-- RLS by design). The third 058 global (agent.agent_releases, no
-- tenant_id), the 058 tenant-scoped partners.learning_progress, and the
-- 042-enrolled communication.message_intents/scheduled_contacts are
-- asserted explicitly as NOT enrolled here, so a silent early enrollment
-- change (or a missing table) fails loudly.
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
    WHERE pt.schemaname IN ('referral', 'loyalty', 'growth', 'partners')
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
    WHERE pt.schemaname IN ('referral', 'loyalty', 'growth', 'partners')
      AND NOT EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
          WHERE n.nspname = pt.schemaname AND c.relname = pt.tablename AND c.relkind = 'r'
      );
    IF n_global <> 2 OR global_list <> 'partners.learning_content, partners.learning_content_versions' THEN
        RAISE EXCEPTION 'global-table allow-list violated: expected exactly partners.learning_content{,_versions}, saw % (%)', n_global, global_list;
    END IF;

    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'partners.learning_content'::regclass) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'partners.learning_content (GLOBAL academy, slice 058) must NOT be RLS-enrolled';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'partners.learning_content_versions'::regclass) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'partners.learning_content_versions (GLOBAL academy, slice 058) must NOT be RLS-enrolled';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'partners.learning_progress'::regclass) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'partners.learning_progress (tenant-scoped academy, slice 058) must be RLS-enrolled here';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'agent.agent_releases'::regclass) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'agent.agent_releases (GLOBAL release catalog, slice 058) must NOT be RLS-enrolled';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'communication.message_intents'::regclass) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'communication.message_intents (slice 042) must stay RLS-enrolled, not re-enrolled here';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'communication.scheduled_contacts'::regclass) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'communication.scheduled_contacts (slice 042) must stay RLS-enrolled, not re-enrolled here';
    END IF;
    RAISE NOTICE 'allow-list OK: 24 enrolled; only partners.learning_content{,_versions} (globals) outside the tenant template';
END $$;

-- 3) GLOBAL catalog surface (migration 058, SELECT-only): the app role
-- reads the catalogs pre-context but must NOT write them (catalog writes
-- arrive via migrations; 056 providers precedent for the documented
-- minimum).
DO $$
DECLARE
    globals text[] := ARRAY[
        'agent.agent_releases',
        'partners.learning_content',
        'partners.learning_content_versions'
    ];
    t text;
BEGIN
    FOREACH t IN ARRAY globals LOOP
        IF (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) IS DISTINCT FROM false THEN
            RAISE EXCEPTION '% (GLOBAL, slice 058) must NOT be RLS-enrolled', t;
        END IF;
        IF has_table_privilege('iptv_app', t, 'SELECT') IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'app role lacks SELECT on GLOBAL %', t;
        END IF;
        IF has_table_privilege('iptv_app', t, 'INSERT') IS DISTINCT FROM false
            OR has_table_privilege('iptv_app', t, 'UPDATE') IS DISTINCT FROM false
            OR has_table_privilege('iptv_app', t, 'DELETE') IS DISTINCT FROM false THEN
            RAISE EXCEPTION 'app role must NOT hold write grants on GLOBAL % (owner-only catalog mutation)', t;
        END IF;
    END LOOP;
    RAISE NOTICE 'global surface OK: SELECT-only on 3 catalogs, no RLS';
END $$;

-- 4) Outbox-role boundary (migration 050 EXECUTE-only): neither the worker
-- identity nor the executor may hold ANY direct privilege on the 24 tables
-- (050 grants live on platform.* only; an injected GRANT here would silently
-- widen the worker past its lifecycle functions).
DO $$
DECLARE
    tables text[] := ARRAY[
        'referral.referral_programs',
        'referral.referrals',
        'referral.referral_qualifications',
        'referral.referral_reward_links',
        'loyalty.reward_definitions',
        'loyalty.rewards',
        'loyalty.reward_ledger_entries',
        'loyalty.gift_passes',
        'growth.campaigns',
        'growth.campaign_versions',
        'growth.audience_definitions',
        'growth.audience_members',
        'growth.creatives',
        'growth.attribution_touches',
        'growth.conversion_events',
        'partners.partner_accounts',
        'partners.partner_relationships',
        'partners.partner_capabilities',
        'partners.reseller_credit_entries',
        'partners.reseller_credit_reservations',
        'partners.reseller_price_books',
        'partners.reseller_orders',
        'partners.learning_progress',
        'partners.partner_memberships'
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
    RAISE NOTICE 'outbox boundary OK: worker/executor hold nothing on growth/partners tables';
END $$;

-- 5) Fixture: two tenants with persons + customers, one referral chain
-- (program -> referral), one loyalty chain (definition -> reward), one
-- growth campaign, one partner account + academy progress on a seeded
-- (034) topic each, as owner.
CREATE TEMP TABLE operational_glp_rollout_ids (
    ta uuid, tb uuid, pa uuid, pb uuid,
    ca uuid, cb uuid,
    proga uuid, progb uuid,
    refa uuid, refb uuid,
    defa uuid, defb uuid,
    rewa uuid, rewb uuid,
    campa uuid, campb uuid,
    parta uuid, partb uuid,
    conta uuid, contb uuid,
    proga2 uuid
);

DO $$
DECLARE
    ta uuid; tb uuid; pa uuid; pb uuid;
    ca uuid; cb uuid;
    proga uuid; progb uuid;
    refa uuid; refb uuid;
    defa uuid; defb uuid;
    rewa uuid; rewb uuid;
    campa uuid; campb uuid;
    parta uuid; partb uuid;
    conta uuid; contb uuid;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-glp-a-' || gen_random_uuid(), 'RLS Operational GLP A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-glp-b-' || gen_random_uuid(), 'RLS Operational GLP B') RETURNING id INTO tb;
    INSERT INTO identity.persons (tenant_id) VALUES (ta) RETURNING id INTO pa;
    INSERT INTO identity.persons (tenant_id) VALUES (tb) RETURNING id INTO pb;
    INSERT INTO crm.customers (tenant_id, person_id)
    VALUES (ta, pa) RETURNING id INTO ca;
    INSERT INTO crm.customers (tenant_id, person_id)
    VALUES (tb, pb) RETURNING id INTO cb;

    -- Referral chain per tenant.
    INSERT INTO referral.referral_programs (tenant_id, name, rules_version, starts_at)
    VALUES (ta, 'rollout program a', 'v1', now()) RETURNING id INTO proga;
    INSERT INTO referral.referral_programs (tenant_id, name, rules_version, starts_at)
    VALUES (tb, 'rollout program b', 'v1', now()) RETURNING id INTO progb;
    INSERT INTO referral.referrals (tenant_id, program_id, advocate_customer_id, referral_code)
    VALUES (ta, proga, ca, 'ROLL-GLP-A') RETURNING id INTO refa;
    INSERT INTO referral.referrals (tenant_id, program_id, advocate_customer_id, referral_code)
    VALUES (tb, progb, cb, 'ROLL-GLP-B') RETURNING id INTO refb;

    -- Loyalty chain per tenant.
    INSERT INTO loyalty.reward_definitions (tenant_id, reward_key, reward_type)
    VALUES (ta, 'roll-glp-a', 'REFERRAL_CREDIT') RETURNING id INTO defa;
    INSERT INTO loyalty.reward_definitions (tenant_id, reward_key, reward_type)
    VALUES (tb, 'roll-glp-b', 'REFERRAL_CREDIT') RETURNING id INTO defb;
    INSERT INTO loyalty.rewards (tenant_id, customer_id, reward_definition_id, source_type)
    VALUES (ta, ca, defa, 'REFERRAL') RETURNING id INTO rewa;
    INSERT INTO loyalty.rewards (tenant_id, customer_id, reward_definition_id, source_type)
    VALUES (tb, cb, defb, 'REFERRAL') RETURNING id INTO rewb;

    -- Growth campaign per tenant.
    INSERT INTO growth.campaigns (tenant_id, campaign_key, name)
    VALUES (ta, 'roll-glp-a', 'Rollout campaign A') RETURNING id INTO campa;
    INSERT INTO growth.campaigns (tenant_id, campaign_key, name)
    VALUES (tb, 'roll-glp-b', 'Rollout campaign B') RETURNING id INTO campb;

    -- Partner account + academy progress per tenant (content rows come
    -- from the 034 curated seed; two distinct topics keep the scratch
    -- lifecycle collision-free).
    INSERT INTO partners.partner_accounts (tenant_id, display_name)
    VALUES (ta, 'Rollout partner A') RETURNING id INTO parta;
    INSERT INTO partners.partner_accounts (tenant_id, display_name)
    VALUES (tb, 'Rollout partner B') RETURNING id INTO partb;
    SELECT id INTO conta FROM partners.learning_content WHERE topic_key = 'academy-01-product-service';
    SELECT id INTO contb FROM partners.learning_content WHERE topic_key = 'academy-02-devices-apps';
    IF conta IS NULL OR contb IS NULL THEN
        RAISE EXCEPTION '034 academy seed content missing (expected 10 curated topics)';
    END IF;
    INSERT INTO partners.learning_progress (tenant_id, partner_account_id, content_id, status)
    VALUES (ta, parta, conta, 'STARTED'), (tb, partb, contb, 'STARTED');

    INSERT INTO operational_glp_rollout_ids
    VALUES (ta, tb, pa, pb, ca, cb, proga, progb, refa, refb, defa, defb,
            rewa, rewb, campa, campb, parta, partb, conta, contb, proga);
    RAISE NOTICE 'operational GLP fixture ready: tenants % / %', ta, tb;
END $$;

-- 6) Tenant A context sees ONLY tenant A rows on every sampled table
-- (one per schema) + learning_progress.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
    sampled text[] := ARRAY[
        'referral.referrals',
        'loyalty.rewards',
        'growth.campaigns',
        'partners.partner_accounts',
        'partners.learning_progress'
    ];
    t text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM operational_glp_rollout_ids s LIMIT 1;
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

-- 7) Tenant B context sees ONLY tenant B rows (proves RESET between blocks).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM operational_glp_rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM growth.campaigns;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'growth.campaigns: tenant B must see exactly 1 row, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM growth.campaigns WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'growth.campaigns: cross-tenant read must return 0 rows, saw %', n_other;
    END IF;
    SELECT count(*) INTO n_all FROM partners.partner_accounts;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'partners.partner_accounts: tenant B must see exactly 1 row, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM partners.partner_accounts WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'partners.partner_accounts: cross-tenant read must return 0 rows, saw %', n_other;
    END IF;
    RAISE NOTICE 'tenant B isolation OK: 1 own campaign + 1 own partner account, 0 cross-tenant rows';
END $$;

-- 8) Write path as tenant A: own INSERT/UPDATE/DELETE on every sampled
-- table + learning_progress; cross-tenant UPDATE touches 0 rows;
-- tenant_id rewrite and cross-tenant INSERT are rejected by WITH CHECK
-- (42501).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    ca uuid;
    proga uuid;
    refb uuid;
    defa uuid;
    rewb uuid;
    parta uuid;
    conta uuid;
    scratch uuid;
    scratch2 uuid;
    affected integer;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.ca, s.proga, s.refb, s.defa, s.rewb, s.parta, s.conta
      INTO ta, tb, ca, proga, refb, defa, rewb, parta, conta
      FROM operational_glp_rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;

    -- referral.referrals scratch lifecycle (childless: no qualifications
    -- or reward links reference it).
    INSERT INTO referral.referrals (tenant_id, program_id, advocate_customer_id, referral_code)
    VALUES (ta, proga, ca, 'ROLL-GLP-SCRATCH') RETURNING id INTO scratch;
    SELECT count(*) INTO n FROM referral.referrals WHERE id = scratch;
    IF n <> 1 THEN
        RAISE EXCEPTION 'own referral INSERT must be visible, saw % rows', n;
    END IF;
    UPDATE referral.referrals SET status = 'ENGAGED' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own referral UPDATE must affect 1 row, affected %', affected;
    END IF;
    UPDATE referral.referrals SET status = 'ENGAGED' WHERE id = refb;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'cross-tenant referral UPDATE must touch 0 rows, touched %', affected;
    END IF;
    BEGIN
        UPDATE referral.referrals SET tenant_id = tb WHERE id = scratch;
        RAISE EXCEPTION 'expected tenant_id rewrite to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO referral.referrals (tenant_id, program_id, advocate_customer_id, referral_code)
        VALUES (tb, proga, ca, 'ROLL-GLP-CROSS');
        RAISE EXCEPTION 'expected cross-tenant referral INSERT to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    DELETE FROM referral.referrals WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch referral DELETE must affect 1 row, affected %', affected;
    END IF;

    -- loyalty.rewards scratch lifecycle (childless: no ledger entries or
    -- gift passes reference it).
    INSERT INTO loyalty.rewards (tenant_id, customer_id, reward_definition_id, source_type)
    VALUES (ta, ca, defa, 'REFERRAL') RETURNING id INTO scratch;
    UPDATE loyalty.rewards SET status = 'APPROVED' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own reward UPDATE must affect 1 row, affected %', affected;
    END IF;
    UPDATE loyalty.rewards SET status = 'APPROVED' WHERE id = rewb;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'cross-tenant reward UPDATE must touch 0 rows, touched %', affected;
    END IF;
    BEGIN
        UPDATE loyalty.rewards SET tenant_id = tb WHERE id = scratch;
        RAISE EXCEPTION 'expected tenant_id rewrite to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    DELETE FROM loyalty.rewards WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch reward DELETE must affect 1 row, affected %', affected;
    END IF;

    -- growth.campaigns scratch lifecycle (childless: no versions,
    -- audiences, creatives or intents reference it).
    INSERT INTO growth.campaigns (tenant_id, campaign_key, name)
    VALUES (ta, 'roll-glp-scratch', 'Scratch') RETURNING id INTO scratch;
    UPDATE growth.campaigns SET status = 'ACTIVE' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own campaign UPDATE must affect 1 row, affected %', affected;
    END IF;
    DELETE FROM growth.campaigns WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch campaign DELETE must affect 1 row, affected %', affected;
    END IF;

    -- partners.partner_accounts scratch lifecycle (childless: no
    -- relationships, credit rows, orders or progress reference it).
    INSERT INTO partners.partner_accounts (tenant_id, display_name)
    VALUES (ta, 'Scratch partner') RETURNING id INTO scratch;
    UPDATE partners.partner_accounts SET status = 'TRAINING' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own partner account UPDATE must affect 1 row, affected %', affected;
    END IF;
    DELETE FROM partners.partner_accounts WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch partner account DELETE must affect 1 row, affected %', affected;
    END IF;

    -- partners.learning_progress scratch lifecycle on the second seeded
    -- topic (fixture progress holds the first; childless either way).
    SELECT id INTO scratch2 FROM partners.learning_content
    WHERE topic_key = 'academy-03-trials-retrial';
    INSERT INTO partners.learning_progress (tenant_id, partner_account_id, content_id, status)
    VALUES (ta, parta, scratch2, 'STARTED') RETURNING id INTO scratch;
    UPDATE partners.learning_progress
    SET status = 'COMPLETED', completed_at = now()
    WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own progress UPDATE must affect 1 row, affected %', affected;
    END IF;
    SELECT count(*) INTO n FROM partners.learning_progress
    WHERE tenant_id = ta AND partner_account_id = parta AND status = 'COMPLETED';
    IF n <> 1 THEN
        RAISE EXCEPTION 'own completed progress must be visible, saw % rows', n;
    END IF;
    DELETE FROM partners.learning_progress WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch progress DELETE must affect 1 row, affected %', affected;
    END IF;

    RAISE NOTICE 'write path OK: own CRUD on 4 sampled tables + learning_progress, cross-tenant UPDATE filtered, rewrite + cross-tenant INSERT rejected (42501)';
END $$;

-- 9) Fail-closed: app role with NO tenant context sees nothing and cannot insert.
DO $$
DECLARE
    ta uuid;
    ca uuid;
    proga uuid;
    defa uuid;
    parta uuid;
    conta uuid;
    n integer;
    sampled text[] := ARRAY[
        'referral.referrals',
        'loyalty.rewards',
        'growth.campaigns',
        'partners.partner_accounts',
        'partners.learning_progress'
    ];
    t text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.ca, s.proga, s.defa, s.parta, s.conta
      INTO ta, ca, proga, defa, parta, conta
      FROM operational_glp_rollout_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    FOREACH t IN ARRAY sampled LOOP
        EXECUTE format('SELECT count(*) FROM %s', t) INTO n;
        IF n <> 0 THEN
            RAISE EXCEPTION '%: app role without tenant context must see 0 rows, saw %', t, n;
        END IF;
    END LOOP;
    BEGIN
        INSERT INTO referral.referrals (tenant_id, program_id, advocate_customer_id, referral_code)
        VALUES (ta, proga, ca, 'ROLL-GLP-NOCTX');
        RAISE EXCEPTION 'expected no-context referral INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO loyalty.rewards (tenant_id, customer_id, reward_definition_id, source_type)
        VALUES (ta, ca, defa, 'REFERRAL');
        RAISE EXCEPTION 'expected no-context reward INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO growth.campaigns (tenant_id, campaign_key, name)
        VALUES (ta, 'roll-glp-noctx', 'No-context');
        RAISE EXCEPTION 'expected no-context campaign INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO partners.partner_accounts (tenant_id, display_name)
        VALUES (ta, 'No-context partner');
        RAISE EXCEPTION 'expected no-context partner INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO partners.learning_progress (tenant_id, partner_account_id, content_id, status)
        VALUES (ta, parta, conta, 'STARTED');
        RAISE EXCEPTION 'expected no-context progress INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'fail-closed OK: no tenant context => 0 rows + INSERTs rejected';
END $$;

-- 10) GLOBAL catalogs stay readable WITHOUT tenant context (SELECT-only
-- surface: visible pre-context, not writable).
DO $$
DECLARE
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM agent.agent_releases;
    IF n < 1 THEN
        RAISE EXCEPTION 'agent.agent_releases (GLOBAL): app role without context must see >= 1 seeded release, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM partners.learning_content;
    IF n <> 10 THEN
        RAISE EXCEPTION 'partners.learning_content (GLOBAL): app role without context must see 10 curated topics, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM partners.learning_content_versions;
    IF n <> 10 THEN
        RAISE EXCEPTION 'partners.learning_content_versions (GLOBAL): app role without context must see 10 v1 rows, saw %', n;
    END IF;
    BEGIN
        INSERT INTO partners.learning_content (topic_key, title, position)
        VALUES ('roll-glp-noctx', 'No-context', 99);
        RAISE EXCEPTION 'expected no-context catalog INSERT to fail (SELECT-only surface)';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'global readability OK: catalogs visible without context, writes refused';
END $$;

-- 11) Owner/superuser bypasses RLS: sees BOTH tenants regardless of context.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM operational_glp_rollout_ids s LIMIT 1;
    SELECT count(*) INTO n FROM referral.referrals WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout referrals, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM loyalty.rewards WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout rewards, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM growth.campaigns WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout campaigns, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM partners.partner_accounts WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout partner accounts, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM partners.learning_progress WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout progress rows, saw %', n;
    END IF;
    RAISE NOTICE 'owner bypass OK: superuser sees all tenants (BYPASSRLS)';
END $$;

ROLLBACK;
