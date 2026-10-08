-- 017 RLS domain rollout (migration 052): billing.* + finance.* as iptv_app.
-- Representative sample: billing.charges, billing.payments, billing.refunds,
-- billing.exceptions, finance.financial_ledger_entries,
-- finance.cost_allocations. Plus: grant/policy/RLS preconditions on ALL 12
-- enrolled tables, global-table allow-list assertion (zero global tables
-- exist in billing/finance scope — every table carries tenant_id NOT NULL,
-- so no allow-list exception policy is expected), outbox-role boundary
-- assertion (050 EXECUTE-only: outbox_worker/outbox_executor hold NOTHING
-- on these tables), and owner bypass. Covers: own CRUD, cross-tenant 0
-- rows, tenant_id rewrite rejected (WITH CHECK => 42501), multi-row ledger
-- WITH CHECK, no-context fail-closed (SELECT 0 rows + INSERT rejected).
-- Fixture rows ROLLBACK; role/policy/grants persist.
-- Execute: cat file | docker exec -i iptv-postgres-1 psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
-- (Regression: db/tests/008, 009, 012, 013, 014.)
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 052 preconditions on all 12 enforced tables.
DO $$
DECLARE
    tables text[] := ARRAY[
        'finance.financial_accounts',
        'finance.financial_transactions',
        'finance.financial_ledger_entries',
        'finance.cost_allocations',
        'billing.charges',
        'billing.charge_provider_bindings',
        'billing.charge_attempts',
        'billing.payments',
        'billing.refund_requests',
        'billing.refunds',
        'billing.tenant_channels',
        'billing.exceptions'
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
    RAISE NOTICE 'rollout preconditions OK: iptv_app NOBYPASSRLS, RLS + tenant_isolation + DML grants on 12 tables';
END $$;

-- 2) Allow-list assertion: no global (tenant_id-less) table may exist in
-- billing/finance scope without an explicit exception policy. Today the
-- count is 0 — every table carries tenant_id and uses the tenant template.
DO $$
DECLARE
    n_global integer;
BEGIN
    SELECT count(*) INTO n_global
    FROM pg_tables pt
    WHERE pt.schemaname IN ('billing', 'finance')
      AND pt.tablename NOT IN (
          SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
          WHERE n.nspname IN ('billing', 'finance') AND c.relkind = 'r'
      );
    IF n_global <> 0 THEN
        RAISE EXCEPTION 'global-table allow-list violated: % table(s) without tenant_id need an explicit exception policy', n_global;
    END IF;
    RAISE NOTICE 'allow-list OK: 0 global tables in billing/finance scope (no exception policy needed)';
END $$;

-- 3) Outbox-role boundary (migration 050 EXECUTE-only): neither the worker
-- identity nor the executor may hold ANY direct privilege on the 12 tables
-- (050 grants live on platform.* only; an injected GRANT here would silently
-- widen the worker past its lifecycle functions).
DO $$
DECLARE
    tables text[] := ARRAY[
        'finance.financial_accounts',
        'finance.financial_transactions',
        'finance.financial_ledger_entries',
        'finance.cost_allocations',
        'billing.charges',
        'billing.charge_provider_bindings',
        'billing.charge_attempts',
        'billing.payments',
        'billing.refund_requests',
        'billing.refunds',
        'billing.tenant_channels',
        'billing.exceptions'
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
    RAISE NOTICE 'outbox boundary OK: worker/executor hold nothing on billing/finance tables';
END $$;

-- 4) Fixture: two tenants, persons, orders, one full billing chain each
-- (charge + binding + attempt + payment + refund_request + refund +
-- exception + channel) plus finance (2 accounts + 1 tx + balanced pair +
-- cost allocation per tenant), as owner.
CREATE TEMP TABLE billing_rollout_ids (
    ta uuid, tb uuid, pa uuid, pb uuid,
    oa uuid, ob uuid,
    cha uuid, chb uuid, paya uuid, payb uuid,
    rra uuid, rrb uuid, rfa uuid, rfb uuid,
    exa uuid, exb uuid, txa uuid, txb uuid,
    acca uuid, accb uuid
);

DO $$
DECLARE
    ta uuid; tb uuid; pa uuid; pb uuid;
    oa uuid; ob uuid;
    cha uuid; chb uuid; paya uuid; payb uuid;
    rra uuid; rrb uuid; rfa uuid; rfb uuid;
    exa uuid; exb uuid; txa uuid; txb uuid;
    acca uuid; accb uuid;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-bf-a-' || gen_random_uuid(), 'RLS BillingFinance A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-bf-b-' || gen_random_uuid(), 'RLS BillingFinance B') RETURNING id INTO tb;
    INSERT INTO identity.persons (tenant_id) VALUES (ta) RETURNING id INTO pa;
    INSERT INTO identity.persons (tenant_id) VALUES (tb) RETURNING id INTO pb;
    INSERT INTO commerce.orders (tenant_id, person_id, order_type, currency, gross_amount_minor, net_amount_minor)
    VALUES (ta, pa, 'NEW_SUBSCRIPTION', 'BRL', 1000, 1000) RETURNING id INTO oa;
    INSERT INTO commerce.orders (tenant_id, person_id, order_type, currency, gross_amount_minor, net_amount_minor)
    VALUES (tb, pb, 'NEW_SUBSCRIPTION', 'BRL', 2000, 2000) RETURNING id INTO ob;

    INSERT INTO billing.charges (tenant_id, order_id, amount_minor, currency, idempotency_key)
    VALUES (ta, oa, 1000, 'BRL', 'roll-a-' || gen_random_uuid()) RETURNING id INTO cha;
    INSERT INTO billing.charges (tenant_id, order_id, amount_minor, currency, idempotency_key)
    VALUES (tb, ob, 2000, 'BRL', 'roll-b-' || gen_random_uuid()) RETURNING id INTO chb;
    INSERT INTO billing.charge_provider_bindings (tenant_id, charge_id, provider, external_charge_id)
    VALUES (ta, cha, 'ASAAS', 'ext-a-' || gen_random_uuid()),
           (tb, chb, 'ASAAS', 'ext-b-' || gen_random_uuid());
    INSERT INTO billing.charge_attempts (tenant_id, charge_id, attempt_no, status)
    VALUES (ta, cha, 1, 'SUCCEEDED'), (tb, chb, 1, 'SUCCEEDED');
    INSERT INTO billing.payments (tenant_id, order_id, charge_id, amount_minor, currency, confirmed_at)
    VALUES (ta, oa, cha, 1000, 'BRL', now()) RETURNING id INTO paya;
    INSERT INTO billing.payments (tenant_id, order_id, charge_id, amount_minor, currency, confirmed_at)
    VALUES (tb, ob, chb, 2000, 'BRL', now()) RETURNING id INTO payb;
    INSERT INTO billing.refund_requests (tenant_id, payment_id, amount_minor, currency, reason, requested_by_type, idempotency_key)
    VALUES (ta, paya, 500, 'BRL', 'rollout fixture a', 'SYSTEM', 'rr-a-' || gen_random_uuid()) RETURNING id INTO rra;
    INSERT INTO billing.refund_requests (tenant_id, payment_id, amount_minor, currency, reason, requested_by_type, idempotency_key)
    VALUES (tb, payb, 500, 'BRL', 'rollout fixture b', 'SYSTEM', 'rr-b-' || gen_random_uuid()) RETURNING id INTO rrb;
    INSERT INTO billing.refunds (tenant_id, refund_request_id, payment_id, amount_minor, currency)
    VALUES (ta, rra, paya, 500, 'BRL') RETURNING id INTO rfa;
    INSERT INTO billing.refunds (tenant_id, refund_request_id, payment_id, amount_minor, currency)
    VALUES (tb, rrb, payb, 500, 'BRL') RETURNING id INTO rfb;
    INSERT INTO billing.exceptions (tenant_id, kind, reason)
    VALUES (ta, 'UNKNOWN_CHARGE', 'rollout fixture a') RETURNING id INTO exa;
    INSERT INTO billing.exceptions (tenant_id, kind, reason)
    VALUES (tb, 'UNKNOWN_CHARGE', 'rollout fixture b') RETURNING id INTO exb;
    INSERT INTO billing.tenant_channels (tenant_id, channel, tenant_key, webhook_secret_hash, status)
    VALUES (ta, 'ASAAS', 'roll-bf-a-' || gen_random_uuid(), 'hash-a', 'ACTIVE'),
           (tb, 'ASAAS', 'roll-bf-b-' || gen_random_uuid(), 'hash-b', 'ACTIVE');

    INSERT INTO finance.financial_accounts (tenant_id, account_code, name, account_type, currency)
    VALUES (ta, 'CASH_ASAAS_PIX', 'Asaas PIX cash', 'ASSET', 'BRL') RETURNING id INTO acca;
    INSERT INTO finance.financial_accounts (tenant_id, account_code, name, account_type, currency)
    VALUES (tb, 'CASH_ASAAS_PIX', 'Asaas PIX cash', 'ASSET', 'BRL') RETURNING id INTO accb;
    INSERT INTO finance.financial_accounts (tenant_id, account_code, name, account_type, currency)
    VALUES (ta, 'REVENUE_SERVICES', 'Service revenue', 'REVENUE', 'BRL'),
           (tb, 'REVENUE_SERVICES', 'Service revenue', 'REVENUE', 'BRL');
    INSERT INTO finance.financial_transactions (tenant_id, transaction_type, reference_type, idempotency_key, occurred_at)
    VALUES (ta, 'PAYMENT_CONFIRMED', 'PAYMENT', 'tx-a-' || gen_random_uuid(), now()) RETURNING id INTO txa;
    INSERT INTO finance.financial_transactions (tenant_id, transaction_type, reference_type, idempotency_key, occurred_at)
    VALUES (tb, 'PAYMENT_CONFIRMED', 'PAYMENT', 'tx-b-' || gen_random_uuid(), now()) RETURNING id INTO txb;
    INSERT INTO finance.financial_ledger_entries (tenant_id, financial_transaction_id, financial_account_id, direction, amount_minor, currency)
    VALUES (ta, txa, acca, 'DEBIT', 1000, 'BRL');
    INSERT INTO finance.financial_ledger_entries (tenant_id, financial_transaction_id, financial_account_id, direction, amount_minor, currency)
    SELECT ta, txa, id, 'CREDIT', 1000, 'BRL' FROM finance.financial_accounts
    WHERE tenant_id = ta AND account_code = 'REVENUE_SERVICES' AND currency = 'BRL';
    INSERT INTO finance.financial_ledger_entries (tenant_id, financial_transaction_id, financial_account_id, direction, amount_minor, currency)
    VALUES (tb, txb, accb, 'DEBIT', 2000, 'BRL');
    INSERT INTO finance.financial_ledger_entries (tenant_id, financial_transaction_id, financial_account_id, direction, amount_minor, currency)
    SELECT tb, txb, id, 'CREDIT', 2000, 'BRL' FROM finance.financial_accounts
    WHERE tenant_id = tb AND account_code = 'REVENUE_SERVICES' AND currency = 'BRL';
    INSERT INTO finance.cost_allocations (tenant_id, cost_type, amount_minor, currency, allocation_target_type, allocation_target_id, allocation_method, source_transaction_id, occurred_at)
    VALUES (ta, 'PROCESSING_FEE', 100, 'BRL', 'ORDER', oa, 'PROPORTIONAL', txa, now()),
           (tb, 'PROCESSING_FEE', 200, 'BRL', 'ORDER', ob, 'PROPORTIONAL', txb, now());

    INSERT INTO billing_rollout_ids
    VALUES (ta, tb, pa, pb, oa, ob, cha, chb, paya, payb, rra, rrb, rfa, rfb, exa, exb, txa, txb, acca, accb);
    RAISE NOTICE 'billing/finance fixture ready: tenants % / %', ta, tb;
END $$;

-- 5) Tenant A context sees ONLY tenant A rows on every sampled table.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
    sampled text[] := ARRAY[
        'billing.charges',
        'billing.payments',
        'billing.refund_requests',
        'billing.refunds',
        'billing.exceptions',
        'finance.financial_ledger_entries',
        'finance.cost_allocations'
    ];
    t text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM billing_rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;
    FOREACH t IN ARRAY sampled LOOP
        EXECUTE format('SELECT count(*) FROM %s', t) INTO n_all;
        -- charges/payments/refunds/exceptions: exactly 1 per tenant;
        -- ledger: 2 balanced rows; cost_allocations: 1 per tenant.
        IF t = 'finance.financial_ledger_entries' THEN
            IF n_all <> 2 THEN
                RAISE EXCEPTION '%: tenant A app role must see exactly 2 rows, saw %', t, n_all;
            END IF;
        ELSIF n_all <> 1 THEN
            RAISE EXCEPTION '%: tenant A app role must see exactly 1 row, saw %', t, n_all;
        END IF;
        EXECUTE format('SELECT count(*) FROM %s WHERE tenant_id = %L', t, tb) INTO n_other;
        IF n_other <> 0 THEN
            RAISE EXCEPTION '%: cross-tenant read must return 0 rows, saw %', t, n_other;
        END IF;
    END LOOP;
    RAISE NOTICE 'tenant A isolation OK: own rows visible, 0 cross-tenant rows';
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
    SELECT s.ta, s.tb INTO ta, tb FROM billing_rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM billing.charges;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'billing.charges: tenant B must see exactly 1 row, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM billing.charges WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'billing.charges: cross-tenant read must return 0 rows, saw %', n_other;
    END IF;
    SELECT count(*) INTO n_all FROM finance.financial_ledger_entries;
    IF n_all <> 2 THEN
        RAISE EXCEPTION 'finance.financial_ledger_entries: tenant B must see exactly 2 rows, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM finance.financial_ledger_entries WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'finance.financial_ledger_entries: cross-tenant read must return 0 rows, saw %', n_other;
    END IF;
    RAISE NOTICE 'tenant B isolation OK: 1 own charge + 2 own ledger rows, 0 cross-tenant rows';
END $$;

-- 7) Write path as tenant A: own INSERT/UPDATE/DELETE succeed; cross-tenant
-- UPDATE touches 0 rows; tenant_id rewrite is rejected by WITH CHECK
-- (42501/insufficient_privilege — row migration prevented, C-ROW-MIGRATION);
-- cross-tenant ledger INSERT is rejected the same way.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    oa uuid;
    chb uuid;
    exb uuid;
    txa uuid;
    acca uuid;
    scratch uuid;
    affected integer;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.oa, s.chb, s.exb, s.txa, s.acca
      INTO ta, tb, oa, chb, exb, txa, acca
      FROM billing_rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;

    -- Own charge lifecycle: INSERT -> UPDATE -> DELETE (scratch row, no children).
    INSERT INTO billing.charges (tenant_id, order_id, amount_minor, currency, idempotency_key)
    VALUES (ta, oa, 3000, 'BRL', 'scratch-a-' || gen_random_uuid()) RETURNING id INTO scratch;
    SELECT count(*) INTO n FROM billing.charges WHERE id = scratch;
    IF n <> 1 THEN
        RAISE EXCEPTION 'own charge INSERT must be visible, saw % rows', n;
    END IF;
    UPDATE billing.charges SET status = 'PROCESSING' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own charge UPDATE must affect 1 row, affected %', affected;
    END IF;
    UPDATE billing.charges SET status = 'PROCESSING' WHERE id = chb;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'cross-tenant charge UPDATE must touch 0 rows, touched %', affected;
    END IF;
    BEGIN
        UPDATE billing.charges SET tenant_id = tb WHERE id = scratch;
        RAISE EXCEPTION 'expected tenant_id rewrite to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    DELETE FROM billing.charges WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch charge DELETE must affect 1 row, affected %', affected;
    END IF;

    -- DELETE isolation is independent from UPDATE: cross-tenant DELETE
    -- touches 0 rows (childless exceptions table, no FK noise).
    DELETE FROM billing.exceptions WHERE id = exb;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'cross-tenant exception DELETE must touch 0 rows, touched %', affected;
    END IF;

    -- Multi-row ledger WITH CHECK: balanced pair under own tenant lands;
    -- a row claiming the other tenant is rejected.
    INSERT INTO finance.financial_ledger_entries (tenant_id, financial_transaction_id, financial_account_id, direction, amount_minor, currency)
    VALUES (ta, txa, acca, 'DEBIT', 50, 'BRL'),
           (ta, txa, acca, 'CREDIT', 50, 'BRL');
    SELECT count(*) INTO n FROM finance.financial_ledger_entries
    WHERE tenant_id = ta AND financial_transaction_id = txa AND amount_minor = 50;
    IF n <> 2 THEN
        RAISE EXCEPTION 'own multi-row ledger INSERT must land 2 rows, saw %', n;
    END IF;
    BEGIN
        INSERT INTO finance.financial_ledger_entries (tenant_id, financial_transaction_id, financial_account_id, direction, amount_minor, currency)
        VALUES (tb, txa, acca, 'DEBIT', 50, 'BRL');
        RAISE EXCEPTION 'expected cross-tenant ledger INSERT to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    -- Cost allocation: own INSERT lands, cross-tenant INSERT is rejected.
    INSERT INTO finance.cost_allocations (tenant_id, cost_type, amount_minor, currency, allocation_target_type, allocation_target_id, allocation_method, occurred_at)
    VALUES (ta, 'OWN_OK', 10, 'BRL', 'ORDER', oa, 'PROPORTIONAL', now());
    BEGIN
        INSERT INTO finance.cost_allocations (tenant_id, cost_type, amount_minor, currency, allocation_target_type, allocation_target_id, allocation_method, occurred_at)
        VALUES (tb, 'X_TEN', 10, 'BRL', 'ORDER', oa, 'PROPORTIONAL', now());
        RAISE EXCEPTION 'expected cross-tenant cost allocation INSERT to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'write path OK: own CRUD lands, cross-tenant UPDATE/DELETE filtered, tenant_id rewrite + cross-tenant INSERTs rejected (42501)';
END $$;

-- 8) Fail-closed: app role with NO tenant context sees nothing and cannot insert.
DO $$
DECLARE
    ta uuid;
    oa uuid;
    n integer;
    sampled text[] := ARRAY[
        'billing.charges',
        'billing.payments',
        'billing.refunds',
        'billing.exceptions',
        'finance.financial_ledger_entries',
        'finance.cost_allocations'
    ];
    t text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.oa INTO ta, oa FROM billing_rollout_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    FOREACH t IN ARRAY sampled LOOP
        EXECUTE format('SELECT count(*) FROM %s', t) INTO n;
        IF n <> 0 THEN
            RAISE EXCEPTION '%: app role without tenant context must see 0 rows, saw %', t, n;
        END IF;
    END LOOP;
    BEGIN
        INSERT INTO billing.charges (tenant_id, order_id, amount_minor, currency, idempotency_key)
        VALUES (ta, oa, 100, 'BRL', 'noctx-' || gen_random_uuid());
        RAISE EXCEPTION 'expected no-context charge INSERT to fail WITH CHECK';
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
    SELECT s.ta, s.tb INTO ta, tb FROM billing_rollout_ids s LIMIT 1;
    SELECT count(*) INTO n FROM billing.charges WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout charges, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM finance.cost_allocations WHERE tenant_id IN (ta, tb);
    -- 2 fixture rows + the 1 own-tenant allocation landed by the block-7
    -- write path (2 for tenant A, 1 for tenant B).
    IF n <> 3 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 3 rollout cost allocations, saw %', n;
    END IF;
    RAISE NOTICE 'owner bypass OK: superuser sees all tenants (BYPASSRLS)';
END $$;

ROLLBACK;
