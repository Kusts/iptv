-- 022 RLS domain rollout (migration 055): subscription.* + commerce.* +
-- catalog.* + inventory.* + trial.* + entitlement.* + provider.* +
-- renewal.* as iptv_app.
-- Representative sample, one table per schema: subscription.subscriptions,
-- commerce.orders, catalog.products, inventory.suppliers, trial.trials,
-- entitlement.entitlements, provider.provider_accounts,
-- renewal.recovery_tasks. Plus: grant/policy/RLS preconditions on ALL 44
-- enrolled tables, allow-list assertion (exactly one tenant_id-less GLOBAL
-- table outside the tenant template — provider.providers with no tenant_id
-- and no RLS by design — plus the 056 hybrid trial.app_profiles WITH
-- NULLABLE tenant_id, RLS-enrolled here under the NULL-tolerant template;
-- hybrid read/write behavior itself is covered by 023), outbox-role boundary
-- assertion (050 EXECUTE-only: outbox_worker/outbox_executor hold NOTHING
-- on these tables), and owner bypass. Covers: own CRUD on all 8 sampled
-- tables, cross-tenant 0 rows, tenant_id rewrite rejected (WITH CHECK =>
-- 42501), cross-tenant INSERT rejected, no-context fail-closed (SELECT 0
-- rows + INSERT rejected). The remaining 36 enrolled tables are covered by
-- the preconditions (RLS + tenant_isolation + DML) plus the allow-list
-- sweep — declared coverage, not row-exhaustive.
-- Fixture rows ROLLBACK; role/policy/grants persist.
-- Execute: cat file | docker exec -i iptv-pg-test psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
-- (Regression: db/tests/017, 018, 019, 020, 021.)
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 055 preconditions on all 44 enforced tables.
DO $$
DECLARE
    tables text[] := ARRAY[
        'subscription.subscriptions',
        'subscription.subscription_cycles',
        'subscription.subscription_addons',
        'subscription.subscription_addon_cycle_charges',
        'subscription.trust_renewal_grants',
        'commerce.orders',
        'commerce.order_items',
        'commerce.price_snapshots',
        'catalog.products',
        'catalog.plans',
        'catalog.addons',
        'catalog.prices',
        'catalog.offers',
        'catalog.offer_items',
        'catalog.coupons',
        'catalog.coupon_redemptions',
        'inventory.suppliers',
        'inventory.supplier_offers',
        'inventory.provider_credit_batches',
        'inventory.provider_credit_entries',
        'inventory.supplier_app_snapshots',
        'inventory.supplier_app_items',
        'inventory.app_trials',
        'inventory.supplier_balance_snapshots',
        'inventory.credit_reservations',
        'inventory.procurement_orders',
        'inventory.license_assets',
        'inventory.reconciliation_findings',
        'trial.trial_eligibility_decisions',
        'trial.trials',
        'trial.trial_attempts',
        'trial.trial_technical_results',
        'trial.device_profiles',
        'trial.network_observations',
        'trial.compatibility_observations',
        'entitlement.entitlements',
        'entitlement.entitlement_grants',
        'provider.provider_accounts',
        'provider.provider_bindings',
        'provider.provider_operations',
        'provider.provider_operation_attempts',
        'provider.provider_evidence',
        'provider.provider_health_snapshots',
        'renewal.recovery_tasks'
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
    RAISE NOTICE 'rollout preconditions OK: iptv_app NOBYPASSRLS, RLS + tenant_isolation + DML grants on 44 tables';
END $$;

-- 2) Allow-list assertion: every tenant_id-bearing table in the 8-schema
-- scope must carry the enrolled tenant template, except the documented
-- 056 hybrid (trial.app_profiles, NULLABLE tenant_id -> enrolled below
-- with the NULL-tolerant template, kept out of this sweep so the sweep
-- stays a pure "no silent unenrolled table" guard); every tenant_id-less
-- table in scope must be exactly the ONE documented global
-- (provider.providers -> slice 056). Both exceptions are asserted
-- explicitly below, so a silent early enrollment change (or a missing
-- table) fails loudly. Hybrid read/write behavior is covered by 023.
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
    WHERE pt.schemaname IN ('subscription', 'commerce', 'catalog', 'inventory', 'trial', 'entitlement', 'provider', 'renewal')
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
      )
      AND (pt.schemaname || '.' || pt.tablename) <> 'trial.app_profiles';
    IF n_unenrolled_tenant <> 0 THEN
        RAISE EXCEPTION 'tenant template violated: % tenant_id table(s) without RLS outside the documented exception: %', n_unenrolled_tenant, unenrolled_tenant;
    END IF;

    SELECT count(*), coalesce(string_agg(pt.schemaname || '.' || pt.tablename, ', ' ORDER BY 1), '')
      INTO n_global, global_list
    FROM pg_tables pt
    WHERE pt.schemaname IN ('subscription', 'commerce', 'catalog', 'inventory', 'trial', 'entitlement', 'provider', 'renewal')
      AND NOT EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
          WHERE n.nspname = pt.schemaname AND c.relname = pt.tablename AND c.relkind = 'r'
      );
    IF n_global <> 1 OR global_list <> 'provider.providers' THEN
        RAISE EXCEPTION 'global-table allow-list violated: expected exactly provider.providers, saw % (%)', n_global, global_list;
    END IF;

    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'provider.providers'::regclass) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'provider.providers (GLOBAL, slice 056) must NOT be RLS-enrolled here';
    END IF;
    -- Hybrid trial.app_profiles (slice 056, mirror-047): RLS-enrolled with
    -- the NULL-tolerant tenant_isolation template + full DML. State-only
    -- expectation here; shared/own/cross + WITH CHECK behavior is 023.
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'trial.app_profiles'::regclass) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'trial.app_profiles (hybrid, slice 056) must be RLS-enrolled';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'trial' AND tablename = 'app_profiles'
          AND policyname = 'tenant_isolation'
    ) THEN
        RAISE EXCEPTION 'tenant_isolation policy missing on trial.app_profiles (hybrid, slice 056)';
    END IF;
    IF (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polname = 'tenant_isolation'
        AND polrelid = 'trial.app_profiles'::regclass) NOT ILIKE '%IS NULL%' THEN
        RAISE EXCEPTION 'trial.app_profiles USING must stay NULL-tolerant (hybrid, slice 056)';
    END IF;
    IF has_table_privilege('iptv_app', 'trial.app_profiles', 'SELECT') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'trial.app_profiles', 'INSERT') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'trial.app_profiles', 'UPDATE') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'trial.app_profiles', 'DELETE') IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'app role lacks full DML grants on trial.app_profiles (hybrid, slice 056)';
    END IF;
    RAISE NOTICE 'allow-list OK: 44 enrolled + hybrid trial.app_profiles enrolled (056); only provider.providers (global) outside the tenant template';
END $$;

-- 3) Outbox-role boundary (migration 050 EXECUTE-only): neither the worker
-- identity nor the executor may hold ANY direct privilege on the 44 tables
-- (050 grants live on platform.* only; an injected GRANT here would silently
-- widen the worker past its lifecycle functions).
DO $$
DECLARE
    tables text[] := ARRAY[
        'subscription.subscriptions',
        'subscription.subscription_cycles',
        'subscription.subscription_addons',
        'subscription.subscription_addon_cycle_charges',
        'subscription.trust_renewal_grants',
        'commerce.orders',
        'commerce.order_items',
        'commerce.price_snapshots',
        'catalog.products',
        'catalog.plans',
        'catalog.addons',
        'catalog.prices',
        'catalog.offers',
        'catalog.offer_items',
        'catalog.coupons',
        'catalog.coupon_redemptions',
        'inventory.suppliers',
        'inventory.supplier_offers',
        'inventory.provider_credit_batches',
        'inventory.provider_credit_entries',
        'inventory.supplier_app_snapshots',
        'inventory.supplier_app_items',
        'inventory.app_trials',
        'inventory.supplier_balance_snapshots',
        'inventory.credit_reservations',
        'inventory.procurement_orders',
        'inventory.license_assets',
        'inventory.reconciliation_findings',
        'trial.trial_eligibility_decisions',
        'trial.trials',
        'trial.trial_attempts',
        'trial.trial_technical_results',
        'trial.device_profiles',
        'trial.network_observations',
        'trial.compatibility_observations',
        'entitlement.entitlements',
        'entitlement.entitlement_grants',
        'provider.provider_accounts',
        'provider.provider_bindings',
        'provider.provider_operations',
        'provider.provider_operation_attempts',
        'provider.provider_evidence',
        'provider.provider_health_snapshots',
        'renewal.recovery_tasks'
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
    RAISE NOTICE 'outbox boundary OK: worker/executor hold nothing on transactional tables';
END $$;

-- 4) Fixture: two tenants with one full chain each (person -> customer ->
-- product -> plan -> order -> subscription -> recovery_task, plus supplier,
-- ENDED trial, entitlement, provider account on one shared GLOBAL provider
-- row), as owner.
CREATE TEMP TABLE transactional_rollout_ids (
    ta uuid, tb uuid, pa uuid, pb uuid,
    ca uuid, cb uuid,
    proda uuid, prodb uuid, plana uuid, planb uuid,
    oa uuid, ob uuid, suba uuid, subb uuid,
    supa uuid, supb uuid, tra uuid, trb uuid,
    enta uuid, entb uuid, prov uuid,
    acca uuid, accb uuid, rta uuid, rtb uuid
);

DO $$
DECLARE
    ta uuid; tb uuid; pa uuid; pb uuid;
    ca uuid; cb uuid;
    proda uuid; prodb uuid; plana uuid; planb uuid;
    oa uuid; ob uuid; suba uuid; subb uuid;
    supa uuid; supb uuid; tra uuid; trb uuid;
    enta uuid; entb uuid; prov uuid;
    acca uuid; accb uuid; rta uuid; rtb uuid;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-tx-a-' || gen_random_uuid(), 'RLS Transactional A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-tx-b-' || gen_random_uuid(), 'RLS Transactional B') RETURNING id INTO tb;
    INSERT INTO identity.persons (tenant_id) VALUES (ta) RETURNING id INTO pa;
    INSERT INTO identity.persons (tenant_id) VALUES (tb) RETURNING id INTO pb;
    INSERT INTO crm.customers (tenant_id, person_id)
    VALUES (ta, pa) RETURNING id INTO ca;
    INSERT INTO crm.customers (tenant_id, person_id)
    VALUES (tb, pb) RETURNING id INTO cb;

    INSERT INTO catalog.products (tenant_id, product_key, name, product_type)
    VALUES (ta, 'roll-tx-a', 'Rollout product A', 'SERVICE') RETURNING id INTO proda;
    INSERT INTO catalog.products (tenant_id, product_key, name, product_type)
    VALUES (tb, 'roll-tx-b', 'Rollout product B', 'SERVICE') RETURNING id INTO prodb;
    INSERT INTO catalog.plans (tenant_id, product_id, plan_key, name, billing_interval_unit)
    VALUES (ta, proda, 'roll-plan-a', 'Rollout plan A', 'MONTH') RETURNING id INTO plana;
    INSERT INTO catalog.plans (tenant_id, product_id, plan_key, name, billing_interval_unit)
    VALUES (tb, prodb, 'roll-plan-b', 'Rollout plan B', 'MONTH') RETURNING id INTO planb;

    INSERT INTO commerce.orders (tenant_id, person_id, order_type, currency, gross_amount_minor, net_amount_minor)
    VALUES (ta, pa, 'NEW_SUBSCRIPTION', 'BRL', 1000, 1000) RETURNING id INTO oa;
    INSERT INTO commerce.orders (tenant_id, person_id, order_type, currency, gross_amount_minor, net_amount_minor)
    VALUES (tb, pb, 'NEW_SUBSCRIPTION', 'BRL', 2000, 2000) RETURNING id INTO ob;

    INSERT INTO subscription.subscriptions (tenant_id, customer_id, plan_id)
    VALUES (ta, ca, plana) RETURNING id INTO suba;
    INSERT INTO subscription.subscriptions (tenant_id, customer_id, plan_id)
    VALUES (tb, cb, planb) RETURNING id INTO subb;

    INSERT INTO inventory.suppliers (tenant_id, name, supplier_type)
    VALUES (ta, 'Rollout supplier A', 'CREDITS') RETURNING id INTO supa;
    INSERT INTO inventory.suppliers (tenant_id, name, supplier_type)
    VALUES (tb, 'Rollout supplier B', 'CREDITS') RETURNING id INTO supb;

    -- ENDED fixture trials: no open access window, so the block-7 scratch
    -- RETRIAL is the single open row (one-open-access-per-person holds).
    INSERT INTO trial.trials (tenant_id, person_id, trial_kind, requested_duration_minutes, lifecycle_status, technical_outcome)
    VALUES (ta, pa, 'TRIAL', 60, 'ENDED', 'PASSED') RETURNING id INTO tra;
    INSERT INTO trial.trials (tenant_id, person_id, trial_kind, requested_duration_minutes, lifecycle_status, technical_outcome)
    VALUES (tb, pb, 'TRIAL', 60, 'ENDED', 'PASSED') RETURNING id INTO trb;

    INSERT INTO entitlement.entitlements (tenant_id, customer_id, feature_key, starts_at, source_type, source_id)
    VALUES (ta, ca, 'ROLL_TX', now(), 'SUBSCRIPTION', suba) RETURNING id INTO enta;
    INSERT INTO entitlement.entitlements (tenant_id, customer_id, feature_key, starts_at, source_type, source_id)
    VALUES (tb, cb, 'ROLL_TX', now(), 'SUBSCRIPTION', subb) RETURNING id INTO entb;

    INSERT INTO provider.providers (provider_key, name, provider_type)
    VALUES ('roll-tx-' || gen_random_uuid(), 'Rollout provider', 'IPTV') RETURNING id INTO prov;
    INSERT INTO provider.provider_accounts (tenant_id, provider_id, name, secret_ref)
    VALUES (ta, prov, 'Rollout account A', 'secret-a') RETURNING id INTO acca;
    INSERT INTO provider.provider_accounts (tenant_id, provider_id, name, secret_ref)
    VALUES (tb, prov, 'Rollout account B', 'secret-b') RETURNING id INTO accb;

    INSERT INTO renewal.recovery_tasks (tenant_id, subscription_id, reason)
    VALUES (ta, suba, 'rollout fixture a') RETURNING id INTO rta;
    INSERT INTO renewal.recovery_tasks (tenant_id, subscription_id, reason)
    VALUES (tb, subb, 'rollout fixture b') RETURNING id INTO rtb;

    INSERT INTO transactional_rollout_ids
    VALUES (ta, tb, pa, pb, ca, cb, proda, prodb, plana, planb, oa, ob, suba, subb,
            supa, supb, tra, trb, enta, entb, prov, acca, accb, rta, rtb);
    RAISE NOTICE 'transactional fixture ready: tenants % / %', ta, tb;
END $$;

-- 5) Tenant A context sees ONLY tenant A rows on every sampled table
-- (one per schema).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
    sampled text[] := ARRAY[
        'subscription.subscriptions',
        'commerce.orders',
        'catalog.products',
        'inventory.suppliers',
        'trial.trials',
        'entitlement.entitlements',
        'provider.provider_accounts',
        'renewal.recovery_tasks'
    ];
    t text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM transactional_rollout_ids s LIMIT 1;
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
    SELECT s.ta, s.tb INTO ta, tb FROM transactional_rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM subscription.subscriptions;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'subscription.subscriptions: tenant B must see exactly 1 row, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM subscription.subscriptions WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'subscription.subscriptions: cross-tenant read must return 0 rows, saw %', n_other;
    END IF;
    SELECT count(*) INTO n_all FROM renewal.recovery_tasks;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'renewal.recovery_tasks: tenant B must see exactly 1 row, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM renewal.recovery_tasks WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'renewal.recovery_tasks: cross-tenant read must return 0 rows, saw %', n_other;
    END IF;
    RAISE NOTICE 'tenant B isolation OK: 1 own subscription + 1 own recovery task, 0 cross-tenant rows';
END $$;

-- 7) Write path as tenant A: own INSERT/UPDATE/DELETE on every sampled
-- table; cross-tenant UPDATE/DELETE touch 0 rows; tenant_id rewrite and
-- cross-tenant INSERT are rejected by WITH CHECK (42501).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    pa uuid;
    ca uuid;
    plana uuid;
    oa uuid;
    ob uuid;
    suba uuid;
    subb uuid;
    supb uuid;
    proda uuid;
    tra uuid;
    prov uuid;
    scratch uuid;
    affected integer;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.pa, s.ca, s.plana, s.oa, s.ob, s.suba, s.subb,
           s.supb, s.proda, s.tra, s.prov
      INTO ta, tb, pa, ca, plana, oa, ob, suba, subb, supb, proda, tra, prov
      FROM transactional_rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;

    -- subscription.subscriptions scratch lifecycle (childless: no cycles,
    -- grants or tasks reference it).
    INSERT INTO subscription.subscriptions (tenant_id, customer_id, plan_id)
    VALUES (ta, ca, plana) RETURNING id INTO scratch;
    SELECT count(*) INTO n FROM subscription.subscriptions WHERE id = scratch;
    IF n <> 1 THEN
        RAISE EXCEPTION 'own subscription INSERT must be visible, saw % rows', n;
    END IF;
    UPDATE subscription.subscriptions SET status = 'SUSPENDED' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own subscription UPDATE must affect 1 row, affected %', affected;
    END IF;
    UPDATE subscription.subscriptions SET status = 'SUSPENDED' WHERE id = subb;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'cross-tenant subscription UPDATE must touch 0 rows, touched %', affected;
    END IF;
    DELETE FROM subscription.subscriptions WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch subscription DELETE must affect 1 row, affected %', affected;
    END IF;

    -- commerce.orders scratch lifecycle (childless: nothing references it).
    INSERT INTO commerce.orders (tenant_id, person_id, order_type, currency, gross_amount_minor, net_amount_minor)
    VALUES (ta, pa, 'ADDON', 'BRL', 500, 500) RETURNING id INTO scratch;
    UPDATE commerce.orders SET status = 'CANCELLED' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own order UPDATE must affect 1 row, affected %', affected;
    END IF;
    UPDATE commerce.orders SET status = 'CANCELLED' WHERE id = ob;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'cross-tenant order UPDATE must touch 0 rows, touched %', affected;
    END IF;
    DELETE FROM commerce.orders WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch order DELETE must affect 1 row, affected %', affected;
    END IF;

    -- catalog.products scratch lifecycle (childless: no plan references it).
    INSERT INTO catalog.products (tenant_id, product_key, name, product_type)
    VALUES (ta, 'roll-tx-scratch', 'Scratch', 'SERVICE') RETURNING id INTO scratch;
    UPDATE catalog.products SET name = 'Scratch 2' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own product UPDATE must affect 1 row, affected %', affected;
    END IF;
    BEGIN
        UPDATE catalog.products SET tenant_id = tb WHERE id = proda;
        RAISE EXCEPTION 'expected tenant_id rewrite to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    DELETE FROM catalog.products WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch product DELETE must affect 1 row, affected %', affected;
    END IF;

    -- inventory.suppliers scratch lifecycle (childless: no offers reference it).
    INSERT INTO inventory.suppliers (tenant_id, name, supplier_type)
    VALUES (ta, 'Scratch supplier', 'CREDITS') RETURNING id INTO scratch;
    UPDATE inventory.suppliers SET name = 'Scratch supplier 2' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own supplier UPDATE must affect 1 row, affected %', affected;
    END IF;
    DELETE FROM inventory.suppliers WHERE id = supb;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'cross-tenant supplier DELETE must touch 0 rows, touched %', affected;
    END IF;
    BEGIN
        INSERT INTO inventory.suppliers (tenant_id, name, supplier_type)
        VALUES (tb, 'Cross supplier', 'CREDITS');
        RAISE EXCEPTION 'expected cross-tenant supplier INSERT to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    DELETE FROM inventory.suppliers WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch supplier DELETE must affect 1 row, affected %', affected;
    END IF;

    -- trial.trials scratch RETRIAL (fixture trial is ENDED, so this is the
    -- single open row for the person; childless: no attempts reference it).
    INSERT INTO trial.trials (tenant_id, person_id, trial_kind, previous_trial_id, retrial_reason, requested_duration_minutes)
    VALUES (ta, pa, 'RETRIAL', tra, 'rollout scratch', 30) RETURNING id INTO scratch;
    UPDATE trial.trials SET retrial_reason = 'rollout scratch 2' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own retrial UPDATE must affect 1 row, affected %', affected;
    END IF;
    DELETE FROM trial.trials WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch retrial DELETE must affect 1 row, affected %', affected;
    END IF;

    -- entitlement.entitlements scratch lifecycle (childless: no grants reference it).
    INSERT INTO entitlement.entitlements (tenant_id, customer_id, feature_key, starts_at, source_type, source_id)
    VALUES (ta, ca, 'ROLL_TX_SCRATCH', now(), 'SUBSCRIPTION', suba) RETURNING id INTO scratch;
    UPDATE entitlement.entitlements SET status = 'SUSPENDED' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own entitlement UPDATE must affect 1 row, affected %', affected;
    END IF;
    DELETE FROM entitlement.entitlements WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch entitlement DELETE must affect 1 row, affected %', affected;
    END IF;

    -- provider.provider_accounts scratch lifecycle (childless: no bindings
    -- or operations reference it).
    INSERT INTO provider.provider_accounts (tenant_id, provider_id, name, secret_ref)
    VALUES (ta, prov, 'Scratch account', 'scratch-secret') RETURNING id INTO scratch;
    UPDATE provider.provider_accounts SET name = 'Scratch account 2' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own provider account UPDATE must affect 1 row, affected %', affected;
    END IF;
    DELETE FROM provider.provider_accounts WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch provider account DELETE must affect 1 row, affected %', affected;
    END IF;

    -- renewal.recovery_tasks scratch lifecycle (RESOLVED requires
    -- outcome + resolved_at per the resolved-shape check).
    INSERT INTO renewal.recovery_tasks (tenant_id, subscription_id, reason)
    VALUES (ta, suba, 'rollout scratch') RETURNING id INTO scratch;
    UPDATE renewal.recovery_tasks
    SET status = 'RESOLVED', outcome = 'WON_BACK', resolved_at = now()
    WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own recovery task UPDATE must affect 1 row, affected %', affected;
    END IF;
    DELETE FROM renewal.recovery_tasks WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch recovery task DELETE must affect 1 row, affected %', affected;
    END IF;

    RAISE NOTICE 'write path OK: own CRUD on all 8 sampled tables, cross-tenant UPDATE/DELETE filtered, rewrite + cross-tenant INSERT rejected (42501)';
END $$;

-- 8) Fail-closed: app role with NO tenant context sees nothing and cannot insert.
DO $$
DECLARE
    ta uuid;
    pa uuid;
    n integer;
    sampled text[] := ARRAY[
        'subscription.subscriptions',
        'commerce.orders',
        'catalog.products',
        'inventory.suppliers',
        'trial.trials',
        'entitlement.entitlements',
        'provider.provider_accounts',
        'renewal.recovery_tasks'
    ];
    t text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.pa INTO ta, pa FROM transactional_rollout_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    FOREACH t IN ARRAY sampled LOOP
        EXECUTE format('SELECT count(*) FROM %s', t) INTO n;
        IF n <> 0 THEN
            RAISE EXCEPTION '%: app role without tenant context must see 0 rows, saw %', t, n;
        END IF;
    END LOOP;
    BEGIN
        INSERT INTO commerce.orders (tenant_id, person_id, order_type, currency, gross_amount_minor, net_amount_minor)
        VALUES (ta, pa, 'ADDON', 'BRL', 100, 100);
        RAISE EXCEPTION 'expected no-context order INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'fail-closed OK: no tenant context => 0 rows + INSERT rejected';
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
    SELECT s.ta, s.tb INTO ta, tb FROM transactional_rollout_ids s LIMIT 1;
    SELECT count(*) INTO n FROM subscription.subscriptions WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout subscriptions, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM catalog.products WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout products, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM renewal.recovery_tasks WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout recovery tasks, saw %', n;
    END IF;
    RAISE NOTICE 'owner bypass OK: superuser sees all tenants (BYPASSRLS)';
END $$;

ROLLBACK;
