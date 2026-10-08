-- 021 Scheduler inbox-worker + WAHA collapse (migration 054).
-- Proves the SIX `054` functions as `iptv_app`/operator: SECURITY DEFINER with
-- pinned search_path, revoked from PUBLIC, EXECUTE to `iptv_app` only for the
-- five runtime functions (outbox lifecycle roles excluded) and NO EXECUTE to
-- ANY role for the operator-only `inbox_requeue` (051 runtime_set mirror),
-- narrow bodies (claim touches only `platform.inbox_messages`; WAHA accept gates on
-- `communication.tenant_channels` + `platform.inbox_accept`; enumeration
-- reads only `control.tenants` -- zero global reads on business tables), and
-- the worker behavior: ordered RECEIVED -> PROCESSING claim with `claimed_by`
-- (SKIP LOCKED disjointness single-session: second claim sees none of the
-- first), provider scoping (waha claims never touch asaas rows), per-row
-- tenant containment, double-drain with no double effect, the inline x
-- scheduler race resolving to exactly one owner (`inbox_claim_by_id` each way),
-- read-only stuck-row detection plus explicit operator requeue with NO
-- auto-reclaim, and the WAHA atomic
-- ingress behavior (unknown/DISABLED refused with zero rows, insert-once,
-- DISABLED-mid-flight TOCTOU refusal, A->B remap refusal with zero rows in
-- EITHER tenant). Also proves the 050/051 worker boundary is untouched.
-- Fixture rows ROLLBACK; functions/grants/column/index persist.
-- Execute: cat file | docker exec -i iptv-postgres-1 psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
-- (Rollout proof: db/tests/019 + db/tests/020. Regression: db/tests/017, 018.)
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 054 preconditions: column + index, function shape, security,
-- grants, scope.
DO $$
DECLARE
    v_secdef boolean;
    v_config text[];
    v_src text;
    fns text[] := ARRAY[
        'platform.inbox_claim(integer, text, text)',
        'platform.inbox_claim_by_id(uuid, text)',
        'platform.inbox_stuck_list(interval)',
        'communication.accept_waha_delivery(text, text, text, text, jsonb, uuid)',
        'control.list_scheduler_tenants()'
    ];
    f text;
    want_path text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'platform' AND table_name = 'inbox_messages'
          AND column_name = 'claimed_by'
    ) THEN
        RAISE EXCEPTION 'migration 054 not applied: platform.inbox_messages.claimed_by is missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'inbox_claim_pending_idx') THEN
        RAISE EXCEPTION 'migration 054 not applied: inbox_claim_pending_idx is missing';
    END IF;

    FOREACH f IN ARRAY fns LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f::regprocedure) THEN
            RAISE EXCEPTION 'migration 054 not applied: % is missing', f;
        END IF;
        SELECT p.prosecdef, p.proconfig INTO v_secdef, v_config
        FROM pg_proc p WHERE p.oid = f::regprocedure;
        IF v_secdef IS DISTINCT FROM true THEN
            RAISE EXCEPTION '054 function % must be SECURITY DEFINER', f;
        END IF;
        want_path := CASE WHEN f LIKE 'communication.%'
            THEN 'search_path=communication, pg_temp'
            WHEN f LIKE 'control.%'
            THEN 'search_path=control, pg_temp'
            ELSE 'search_path=platform, pg_temp' END;
        IF v_config IS NULL OR NOT EXISTS (
            SELECT 1 FROM unnest(v_config) g WHERE g = want_path
        ) THEN
            RAISE EXCEPTION '054 function % must pin % (saw %)', f, want_path, v_config;
        END IF;
        IF EXISTS (
            SELECT 1 FROM pg_proc p
            WHERE p.oid = f::regprocedure
              AND (p.proacl::text LIKE '{=X/%' OR p.proacl::text LIKE '%,=X/%')
        ) THEN
            RAISE EXCEPTION '054 function % must be revoked from PUBLIC', f;
        END IF;
        IF has_function_privilege('iptv_app', f, 'EXECUTE') IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'iptv_app must have EXECUTE on %', f;
        END IF;
        IF has_function_privilege('outbox_worker', f, 'EXECUTE') IS DISTINCT FROM false THEN
            RAISE EXCEPTION 'outbox_worker must NOT have EXECUTE on % (050 EXECUTE-only boundary)', f;
        END IF;
        IF has_function_privilege('outbox_executor', f, 'EXECUTE') IS DISTINCT FROM false THEN
            RAISE EXCEPTION 'outbox_executor must NOT have EXECUTE on % (050 EXECUTE-only boundary)', f;
        END IF;
    END LOOP;

    -- Narrow bodies: the claim touches only the inbox lifecycle; the WAHA
    -- accept gates on its routing table and funnels through the single
    -- insert-once implementation; the enumeration reads only the tenant
    -- registry (no business table anywhere near the scheduler path).
    SELECT pg_get_functiondef(
        (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'platform' AND p.proname = 'inbox_claim')
    ) INTO v_src;
    IF v_src NOT ILIKE '%platform.inbox_messages%' THEN
        RAISE EXCEPTION 'inbox_claim body must transition platform.inbox_messages';
    END IF;
    IF v_src NOT ILIKE '%''RECEIVED''%' OR v_src NOT ILIKE '%''PROCESSING''%' THEN
        RAISE EXCEPTION 'inbox_claim body must move RECEIVED -> PROCESSING explicitly';
    END IF;
    IF v_src NOT ILIKE '%SKIP LOCKED%' THEN
        RAISE EXCEPTION 'inbox_claim body must use SKIP LOCKED (disjoint concurrent drains)';
    END IF;
    IF v_src NOT ILIKE '%claimed_by%' THEN
        RAISE EXCEPTION 'inbox_claim body must stamp claimed_by';
    END IF;
    IF v_src ILIKE '%lease%' OR v_src ILIKE '%reclaim%' THEN
        RAISE EXCEPTION 'inbox_claim body must carry no lease/reclaim state (claim-once by design)';
    END IF;
    IF v_src ILIKE '%outbox%' OR v_src ILIKE '%domain_events%'
        OR v_src ILIKE '%audit_log%' OR v_src ILIKE '%idempotency%'
        OR v_src ILIKE '%tenant_channels%' OR v_src ILIKE '%control.tenants%' THEN
        RAISE EXCEPTION 'inbox_claim body must not reference tables outside platform.inbox_messages';
    END IF;

    -- claim_by_id: the same protocol for the inline path -- one atomic
    -- single-row RECEIVED -> PROCESSING transition keyed by the row id (no
    -- LIMIT batch, no provider predicate: the PK is globally unique), zero
    -- rows when the drain already owns it.
    SELECT pg_get_functiondef(
        (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'platform' AND p.proname = 'inbox_claim_by_id')
    ) INTO v_src;
    IF v_src NOT ILIKE '%platform.inbox_messages%' THEN
        RAISE EXCEPTION 'inbox_claim_by_id body must transition platform.inbox_messages';
    END IF;
    IF v_src NOT ILIKE '%''RECEIVED''%' OR v_src NOT ILIKE '%''PROCESSING''%' THEN
        RAISE EXCEPTION 'inbox_claim_by_id body must move RECEIVED -> PROCESSING explicitly';
    END IF;
    IF v_src NOT ILIKE '%p_inbox_id%' OR v_src NOT ILIKE '%claimed_by%' THEN
        RAISE EXCEPTION 'inbox_claim_by_id body must key on p_inbox_id and stamp claimed_by';
    END IF;
    IF v_src ILIKE '%LIMIT%' THEN
        RAISE EXCEPTION 'inbox_claim_by_id body must claim exactly one row (no LIMIT batch)';
    END IF;
    IF v_src ILIKE '%lease%' OR v_src ILIKE '%reclaim%' THEN
        RAISE EXCEPTION 'inbox_claim_by_id body must carry no lease/reclaim state (claim-once by design)';
    END IF;
    IF v_src ILIKE '%outbox%' OR v_src ILIKE '%domain_events%'
        OR v_src ILIKE '%audit_log%' OR v_src ILIKE '%idempotency%'
        OR v_src ILIKE '%tenant_channels%' OR v_src ILIKE '%control.tenants%' THEN
        RAISE EXCEPTION 'inbox_claim_by_id body must not reference tables outside platform.inbox_messages';
    END IF;

    -- stuck_list: READ-ONLY detection -- a pure SELECT over PROCESSING rows
    -- past the age threshold. Any write verb fails the proof: calling it can
    -- never move, requeue, or reclaim a row.
    SELECT pg_get_functiondef(
        (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'platform' AND p.proname = 'inbox_stuck_list')
    ) INTO v_src;
    IF v_src NOT ILIKE '%platform.inbox_messages%' THEN
        RAISE EXCEPTION 'inbox_stuck_list body must read platform.inbox_messages';
    END IF;
    IF v_src NOT ILIKE '%''PROCESSING''%' OR v_src NOT ILIKE '%p_older_than%' THEN
        RAISE EXCEPTION 'inbox_stuck_list body must filter PROCESSING rows by p_older_than';
    END IF;
    IF v_src ILIKE '%UPDATE%' OR v_src ILIKE '%INSERT INTO%'
        OR v_src ILIKE '%DELETE FROM%' THEN
        RAISE EXCEPTION 'inbox_stuck_list body must be read-only (no state transition verbs)';
    END IF;
    IF v_src ILIKE '%outbox%' OR v_src ILIKE '%domain_events%'
        OR v_src ILIKE '%audit_log%' OR v_src ILIKE '%idempotency%'
        OR v_src ILIKE '%tenant_channels%' OR v_src ILIKE '%control.tenants%' THEN
        RAISE EXCEPTION 'inbox_stuck_list body must not reference tables outside platform.inbox_messages';
    END IF;

    -- requeue: the ONLY recovery -- one explicit PROCESSING -> RECEIVED move
    -- keyed by a single id, raising on anything else. No age sweep inside
    -- (no interval predicate: bulk/time-based auto-requeue stays impossible
    -- by construction).
    SELECT pg_get_functiondef(
        (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'platform' AND p.proname = 'inbox_requeue')
    ) INTO v_src;
    IF v_src NOT ILIKE '%platform.inbox_messages%' THEN
        RAISE EXCEPTION 'inbox_requeue body must transition platform.inbox_messages';
    END IF;
    IF v_src NOT ILIKE '%''PROCESSING''%' OR v_src NOT ILIKE '%''RECEIVED''%' THEN
        RAISE EXCEPTION 'inbox_requeue body must move PROCESSING -> RECEIVED explicitly';
    END IF;
    IF v_src NOT ILIKE '%p_inbox_id%' OR v_src NOT ILIKE '%RAISE EXCEPTION%' THEN
        RAISE EXCEPTION 'inbox_requeue body must key on p_inbox_id and raise on non-PROCESSING rows (never silent)';
    END IF;
    IF v_src ILIKE '%interval%' THEN
        RAISE EXCEPTION 'inbox_requeue body must not carry an age sweep (explicit one-row recovery only, no auto-reclaim)';
    END IF;
    IF v_src ILIKE '%outbox%' OR v_src ILIKE '%domain_events%'
        OR v_src ILIKE '%audit_log%' OR v_src ILIKE '%idempotency%'
        OR v_src ILIKE '%tenant_channels%' OR v_src ILIKE '%control.tenants%' THEN
        RAISE EXCEPTION 'inbox_requeue body must not reference tables outside platform.inbox_messages';
    END IF;
    -- Operator-only boundary (051 runtime_set mirror): no EXECUTE to ANY
    -- role -- the operator runs it as the owner on a direct connection.
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'platform.inbox_requeue(uuid)'::regprocedure
                   AND p.prosecdef IS NOT DISTINCT FROM true) THEN
        RAISE EXCEPTION '054 function platform.inbox_requeue(uuid) must be SECURITY DEFINER';
    END IF;
    SELECT p.proconfig INTO v_config FROM pg_proc p WHERE p.oid = 'platform.inbox_requeue(uuid)'::regprocedure;
    IF v_config IS NULL OR NOT EXISTS (
        SELECT 1 FROM unnest(v_config) g WHERE g = 'search_path=platform, pg_temp'
    ) THEN
        RAISE EXCEPTION '054 function platform.inbox_requeue(uuid) must pin search_path=platform, pg_temp (saw %)', v_config;
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        WHERE p.oid = 'platform.inbox_requeue(uuid)'::regprocedure
          AND (p.proacl::text LIKE '{=X/%' OR p.proacl::text LIKE '%,=X/%')
    ) THEN
        RAISE EXCEPTION '054 function platform.inbox_requeue(uuid) must be revoked from PUBLIC';
    END IF;
    IF has_function_privilege('iptv_app', 'platform.inbox_requeue(uuid)', 'EXECUTE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'iptv_app must NOT have EXECUTE on platform.inbox_requeue(uuid) (operator-only recovery)';
    END IF;
    IF has_function_privilege('outbox_worker', 'platform.inbox_requeue(uuid)', 'EXECUTE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_worker must NOT have EXECUTE on platform.inbox_requeue(uuid) (operator-only recovery)';
    END IF;
    IF has_function_privilege('outbox_executor', 'platform.inbox_requeue(uuid)', 'EXECUTE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_executor must NOT have EXECUTE on platform.inbox_requeue(uuid) (operator-only recovery)';
    END IF;

    SELECT pg_get_functiondef(
        (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'communication' AND p.proname = 'accept_waha_delivery')
    ) INTO v_src;
    IF v_src NOT ILIKE '%communication.tenant_channels%' THEN
        RAISE EXCEPTION 'waha accept body must gate on communication.tenant_channels';
    END IF;
    IF v_src NOT ILIKE '%FOR UPDATE%' THEN
        RAISE EXCEPTION 'waha accept body must lock the routing row FOR UPDATE (TOCTOU serialization)';
    END IF;
    IF v_src NOT ILIKE '%ACTIVE%' THEN
        RAISE EXCEPTION 'waha accept body must revalidate ACTIVE inside the lock';
    END IF;
    IF v_src NOT ILIKE '%platform.inbox_accept(%' THEN
        RAISE EXCEPTION 'waha accept body must insert through platform.inbox_accept (single insert-once implementation)';
    END IF;
    IF v_src NOT ILIKE '%p_expected_tenant_id%' THEN
        RAISE EXCEPTION 'waha accept body must enforce the expected-tenant guard pre-insert (remap refusal)';
    END IF;

    SELECT pg_get_functiondef(
        (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'control' AND p.proname = 'list_scheduler_tenants')
    ) INTO v_src;
    IF v_src NOT ILIKE '%control.tenants%' THEN
        RAISE EXCEPTION 'enumeration body must read the control.tenants registry';
    END IF;
    IF v_src ILIKE '%trial.%' OR v_src ILIKE '%commerce.%'
        OR v_src ILIKE '%billing.%' OR v_src ILIKE '%subscription.%'
        OR v_src ILIKE '%communication.%' OR v_src ILIKE '%inbox_messages%'
        OR v_src ILIKE '%outbox%' OR v_src ILIKE '%domain_events%'
        OR v_src ILIKE '%audit_log%' OR v_src ILIKE '%idempotency%' THEN
        RAISE EXCEPTION 'enumeration body must not read any business table (zero global business reads)';
    END IF;
    RAISE NOTICE '054 preconditions OK: definer, pinned search_path, iptv_app-only EXECUTE (requeue operator-only), narrow bodies';
END $$;

-- 2) Fixture: two tenants; WAHA ACTIVE (A + B) + DISABLED (A) channels, one
-- ACTIVE Asaas channel (A, provider-scoping probe); inbox rows via the
-- insert-once producer with staggered received_at for order assertions.
CREATE TEMP TABLE worker_fixture_ids (ta uuid, tb uuid, ka text, kd text, kb uuid, kaa text);

DO $$
DECLARE
    ta uuid; tb uuid;
    ka text; kd text; kb uuid; kaa text;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-wiw-a-' || gen_random_uuid(), 'RLS Worker A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-wiw-b-' || gen_random_uuid(), 'RLS Worker B') RETURNING id INTO tb;
    ka := 'wiw-active-a-' || gen_random_uuid();
    kd := 'wiw-disabled-a-' || gen_random_uuid();
    kb := gen_random_uuid();
    kaa := 'wiw-asaas-a-' || gen_random_uuid();
    INSERT INTO communication.tenant_channels (tenant_id, channel, tenant_key, webhook_secret_hash, status)
    VALUES (ta, 'WHATSAPP', ka, 'hash-a', 'ACTIVE'),
           (ta, 'WHATSAPP', kd, 'hash-d', 'DISABLED'),
           (tb, 'WHATSAPP', kb::text, 'hash-b', 'ACTIVE');
    INSERT INTO billing.tenant_channels (tenant_id, channel, tenant_key, webhook_secret_hash, status)
    VALUES (ta, 'ASAAS', kaa, 'hash-aa', 'ACTIVE');
    INSERT INTO worker_fixture_ids VALUES (ta, tb, ka, kd, kb, kaa);

    -- Inbox rows: two waha rows for A, one waha row for B, one asaas row for
    -- A (provider-scoping probe). Staggered received_at pins claim order.
    PERFORM platform.inbox_accept(ta, 'waha', 'wiw-a-1', 'waha.raw', 'h1', '{"n":1}');
    PERFORM platform.inbox_accept(ta, 'waha', 'wiw-a-2', 'waha.raw', 'h2', '{"n":2}');
    PERFORM platform.inbox_accept(tb, 'waha', 'wiw-b-1', 'waha.raw', 'h3', '{"n":3}');
    PERFORM platform.inbox_accept(ta, 'asaas', 'wiw-aa-1', 'asaas.raw', 'h4', '{"n":4}');
    UPDATE platform.inbox_messages SET received_at = now() - interval '30 minutes'
    WHERE tenant_id = ta AND provider = 'waha' AND external_event_id = 'wiw-a-1';
    UPDATE platform.inbox_messages SET received_at = now() - interval '20 minutes'
    WHERE tenant_id = ta AND provider = 'waha' AND external_event_id = 'wiw-a-2';
    UPDATE platform.inbox_messages SET received_at = now() - interval '10 minutes'
    WHERE tenant_id = tb AND provider = 'waha' AND external_event_id = 'wiw-b-1';
    -- Stagger the fixture tenants' creation instants: `created_at` defaults
    -- to the transaction-start `now()`, so both rows would otherwise share
    -- the identical stamp and the block-7 creation-order assertion would
    -- degrade to a uuid tiebreak coin-flip. Same staggering discipline as
    -- the inbox rows above.
    UPDATE control.tenants SET created_at = now() - interval '2 minutes' WHERE id = ta;
    UPDATE control.tenants SET created_at = now() - interval '1 minute' WHERE id = tb;
    RAISE NOTICE 'worker fixture ready: tenants % / %', ta, tb;
END $$;

-- 3) inbox_claim as iptv_app with NO tenant context: ordered RECEIVED ->
-- PROCESSING with claimed_by, provider-scoped, disjoint across calls
-- (single-session SKIP LOCKED proof: what the first claim takes, the second
-- never sees again); blank arguments refused.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    r record;
    ids uuid[];
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM worker_fixture_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;

    -- Oldest waha row first (limit 1 proves ordering).
    SELECT * INTO r FROM platform.inbox_claim(1, 'waha', 'drain-test');
    IF r.o_inbox_id IS NULL OR r.o_tenant_id IS DISTINCT FROM ta THEN
        RAISE EXCEPTION 'first waha claim must take the oldest row (tenant A), saw %/%', r.o_inbox_id, r.o_tenant_id;
    END IF;
    ids := ARRAY[r.o_inbox_id];

    -- Second claim takes the disjoint remainder (never the first row again).
    FOR r IN SELECT * FROM platform.inbox_claim(10, 'waha', 'drain-test') LOOP
        IF r.o_inbox_id = ANY (ids) THEN
            RAISE EXCEPTION 'second claim re-claimed an already-PROCESSING row (SKIP LOCKED broken)';
        END IF;
        ids := ids || r.o_inbox_id;
    END LOOP;
    IF array_length(ids, 1) <> 3 THEN
        RAISE EXCEPTION 'two waha claims must cover exactly 3 rows disjointly, saw %', array_length(ids, 1);
    END IF;

    -- Third claim: nothing left (no double effect on re-drain).
    SELECT count(*) INTO n FROM platform.inbox_claim(10, 'waha', 'drain-test');
    IF n <> 0 THEN
        RAISE EXCEPTION 'empty waha queue must claim 0 rows, saw %', n;
    END IF;

    -- Provider scoping: the asaas row was never touched by waha claims.
    RESET ROLE;
    SELECT count(*) INTO n FROM platform.inbox_messages
    WHERE tenant_id = ta AND provider = 'asaas' AND external_event_id = 'wiw-aa-1'
      AND state = 'RECEIVED' AND claimed_by IS NULL;
    IF n <> 1 THEN
        RAISE EXCEPTION 'waha claims must leave the asaas row RECEIVED/unclaimed, saw %', n;
    END IF;
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM platform.inbox_claim(10, 'asaas', 'drain-test');
    IF n <> 1 THEN
        RAISE EXCEPTION 'asaas claim must take exactly its own row, saw %', n;
    END IF;

    -- The claimed waha rows carry PROCESSING + claimed_by (owner read:
    -- bypasses RLS, so a missed transition anywhere would be seen).
    RESET ROLE;
    SELECT count(*) INTO n FROM platform.inbox_messages
    WHERE provider = 'waha' AND external_event_id IN ('wiw-a-1', 'wiw-a-2', 'wiw-b-1')
      AND state = 'PROCESSING' AND claimed_by = 'drain-test';
    IF n <> 3 THEN
        RAISE EXCEPTION 'claimed rows must be PROCESSING with claimed_by set, saw %', n;
    END IF;

    -- Blank arguments refused (no unbounded or unscoped claims).
    SET LOCAL ROLE iptv_app;
    BEGIN
        PERFORM * FROM platform.inbox_claim(0, 'waha', 'drain-test');
        RAISE EXCEPTION 'expected limit 0 claim to fail';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    BEGIN
        PERFORM * FROM platform.inbox_claim(10, '  ', 'drain-test');
        RAISE EXCEPTION 'expected blank provider claim to fail';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    BEGIN
        PERFORM * FROM platform.inbox_claim(10, 'waha', NULL);
        RAISE EXCEPTION 'expected blank claimed_by claim to fail';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    RAISE NOTICE 'inbox_claim OK: ordered, provider-scoped, disjoint, claimed_by stamped, blanks refused';
END $$;

-- 4) Per-row tenant containment: tenant A context sees only its own claimed
-- rows (B's claimed row reads 0); the terminal markState-equivalent UPDATE
-- lands under the row's own tenant; a second drain after terminal states
-- claims nothing (double-drain, no double effect).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM worker_fixture_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;

    SELECT count(*) INTO n FROM platform.inbox_messages WHERE state = 'PROCESSING' AND provider = 'waha';
    IF n <> 2 THEN
        RAISE EXCEPTION 'tenant A must see exactly its 2 claimed waha rows, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM platform.inbox_messages WHERE tenant_id = tb;
    IF n <> 0 THEN
        RAISE EXCEPTION 'cross-tenant claimed read must return 0 rows, saw %', n;
    END IF;

    -- Terminal transition under the row's own tenant (what markState does).
    UPDATE platform.inbox_messages SET state = 'PROCESSED', processed_at = now()
    WHERE tenant_id = ta AND provider = 'waha' AND state = 'PROCESSING';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 2 THEN
        RAISE EXCEPTION 'tenant A terminal update must affect 2 rows, affected %', n;
    END IF;

    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    UPDATE platform.inbox_messages SET state = 'FAILED', last_error_code = 'HANDLER_ERROR'
    WHERE tenant_id = tb AND provider = 'waha' AND state = 'PROCESSING';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN
        RAISE EXCEPTION 'tenant B terminal update must affect 1 row, affected %', n;
    END IF;

    -- Double-drain after terminal states: nothing claimable remains.
    SELECT count(*) INTO n FROM platform.inbox_claim(10, 'waha', 'drain-test-2');
    IF n <> 0 THEN
        RAISE EXCEPTION 're-drain after terminal states must claim 0 rows, saw %', n;
    END IF;
    RAISE NOTICE 'tenant containment OK: own rows only, terminal updates land, re-drain claims 0';
END $$;

-- 5) WAHA atomic accept as iptv_app with NO tenant context: unknown key and
-- DISABLED key refused with zero inbox rows; ACTIVE inserts once; double
-- delivery dedupes to the same id; containment per key.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    ka text;
    kd text;
    kb uuid;
    r record;
    id1 uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.ka, s.kd, s.kb INTO ta, tb, ka, kd, kb FROM worker_fixture_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;

    SELECT * INTO r FROM communication.accept_waha_delivery('wiw-unknown-' || gen_random_uuid(), 'ext-u', 'waha.raw', 'h', '{}', ta);
    IF r.o_accepted IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'unknown WAHA routing key must be refused';
    END IF;
    SELECT * INTO r FROM communication.accept_waha_delivery(kd, 'ext-d', 'waha.raw', 'h', '{}', ta);
    IF r.o_accepted IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'DISABLED WAHA routing key must be refused';
    END IF;
    SELECT count(*) INTO n FROM platform.inbox_messages
    WHERE tenant_id = ta AND provider = 'waha' AND external_event_id IN ('ext-u', 'ext-d');
    IF n <> 0 THEN
        RAISE EXCEPTION 'refused WAHA accepts must leave zero inbox rows, saw %', n;
    END IF;

    SELECT * INTO r FROM communication.accept_waha_delivery(ka, 'wiw-waha-1', 'waha.raw', 'h1', '{"body":1}', ta);
    IF r.o_accepted IS DISTINCT FROM true OR r.o_inserted IS DISTINCT FROM true
        OR r.o_tenant_id IS DISTINCT FROM ta OR r.o_inbox_id IS NULL THEN
        RAISE EXCEPTION 'ACTIVE WAHA accept must insert and resolve its own tenant';
    END IF;
    id1 := r.o_inbox_id;
    SELECT * INTO r FROM communication.accept_waha_delivery(ka, 'wiw-waha-1', 'waha.raw', 'h1', '{"body":1}', ta);
    IF r.o_accepted IS DISTINCT FROM true OR r.o_inserted IS DISTINCT FROM false
        OR r.o_inbox_id IS DISTINCT FROM id1 THEN
        RAISE EXCEPTION 'double WAHA delivery must dedupe to the same inbox id';
    END IF;

    -- Containment: the second tenant key resolves to ITS tenant only.
    SELECT * INTO r FROM communication.accept_waha_delivery(kb::text, 'wiw-waha-b', 'waha.raw', 'h', '{}', tb);
    IF r.o_accepted IS DISTINCT FROM true OR r.o_tenant_id IS DISTINCT FROM tb THEN
        RAISE EXCEPTION 'second WAHA tenant key must resolve to its own tenant';
    END IF;
    IF r.o_tenant_id = ta THEN
        RAISE EXCEPTION 'WAHA accept leaked across tenants';
    END IF;
    RAISE NOTICE 'waha accept OK: refused paths leave 0 rows, ACTIVE insert-once %, containment holds', id1;
END $$;

-- 6) TOCTOU: a channel DISABLED between the app-side resolve and the accept
-- is refused with zero inbox rows (the lock + revalidation close the race).
DO $$
DECLARE
    ta uuid;
    ka text;
    r record;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.ka INTO ta, ka FROM worker_fixture_ids s LIMIT 1;
    -- The app-side resolve (pre-context, ACTIVE at this instant).
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM communication.resolve_tenant_channel(ka);
    IF n <> 1 THEN
        RAISE EXCEPTION 'resolver must see the ACTIVE WAHA channel before the race';
    END IF;
    RESET ROLE;
    -- The race: operator disables the channel before the accept lands.
    UPDATE communication.tenant_channels SET status = 'DISABLED' WHERE tenant_key = ka;
    SET LOCAL ROLE iptv_app;
    SELECT * INTO r FROM communication.accept_waha_delivery(ka, 'wiw-waha-race', 'waha.raw', 'h', '{}', ta);
    IF r.o_accepted IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'DISABLED-mid-flight WAHA accept must be refused (TOCTOU open)';
    END IF;
    SELECT count(*) INTO n FROM platform.inbox_messages
    WHERE tenant_id = ta AND provider = 'waha' AND external_event_id = 'wiw-waha-race';
    IF n <> 0 THEN
        RAISE EXCEPTION 'TOCTOU-refused WAHA accept must leave zero inbox rows, saw %', n;
    END IF;
    RAISE NOTICE 'WAHA TOCTOU OK: DISABLED-mid-flight refused with zero inbox rows';
END $$;

-- 6b) REMAP (HIGH finding, 053 precedent): a routing key re-pointed to
-- another tenant between the app-side resolve and the accept is refused with
-- ZERO inbox rows -- the expected-tenant guard runs under the lock BEFORE
-- the insert, so A's payload never lands in B. The re-pointed key still
-- accepts for the NEW tenant when the caller expects it.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    kc text;
    r record;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM worker_fixture_ids s LIMIT 1;
    -- Fresh ACTIVE key for A (block 6 disabled ka above; self-contained).
    kc := 'wiw-remap-a-' || gen_random_uuid();
    INSERT INTO communication.tenant_channels (tenant_id, channel, tenant_key, webhook_secret_hash, status)
    VALUES (ta, 'WHATSAPP', kc, 'hash-remap', 'ACTIVE');
    SET LOCAL ROLE iptv_app;
    -- The app-side resolve names A (pre-race instant).
    SELECT * INTO r FROM communication.resolve_tenant_channel(kc);
    IF r.tenant_id IS DISTINCT FROM ta THEN
        RAISE EXCEPTION 'resolver must name tenant A before the remap race';
    END IF;
    RESET ROLE;
    -- The race: the routing key is re-pointed A -> B before the accept lands.
    UPDATE communication.tenant_channels SET tenant_id = tb WHERE tenant_key = kc;
    SET LOCAL ROLE iptv_app;
    -- The stale-expectation accept (still expecting A) is refused ...
    SELECT * INTO r FROM communication.accept_waha_delivery(kc, 'wiw-remap-1', 'waha.raw', 'h-remap', '{"body":"a"}', ta);
    IF r.o_accepted IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'remapped WAHA accept with a stale expected tenant must be refused';
    END IF;
    -- ... with ZERO inbox rows in EITHER tenant: A's payload never lands in B
    -- (owner read: bypasses RLS, so a leak anywhere would be seen).
    RESET ROLE;
    SELECT count(*) INTO n FROM platform.inbox_messages
    WHERE provider = 'waha' AND external_event_id = 'wiw-remap-1' AND tenant_id IN (ta, tb);
    IF n <> 0 THEN
        RAISE EXCEPTION 'remap-refused WAHA accept must leave zero inbox rows, saw %', n;
    END IF;
    -- The re-pointed key still accepts when the caller expects the NEW tenant.
    SET LOCAL ROLE iptv_app;
    SELECT * INTO r FROM communication.accept_waha_delivery(kc, 'wiw-remap-2', 'waha.raw', 'h-remap', '{"body":"b"}', tb);
    IF r.o_accepted IS DISTINCT FROM true OR r.o_tenant_id IS DISTINCT FROM tb
        OR r.o_inserted IS DISTINCT FROM true OR r.o_inbox_id IS NULL THEN
        RAISE EXCEPTION 're-pointed WAHA key must accept for the new expected tenant';
    END IF;
    RAISE NOTICE 'WAHA remap OK: stale expectation refused with zero rows, new tenant accepts';
END $$;

-- 7) Scheduler enumeration as iptv_app with NO tenant context: returns the
-- fixture tenants (creation order) through the narrow registry path -- the
-- scheduler tick performs zero global reads on business tables by
-- construction (body proven narrow in block 1).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    ids uuid[];
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM worker_fixture_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    SELECT array_agg(t.o_tenant_id ORDER BY t.o_tenant_id) INTO ids
    FROM (SELECT * FROM control.list_scheduler_tenants() LIMIT 100000) AS t
    WHERE t.o_tenant_id IN (ta, tb);
    IF NOT (ids @> ARRAY[ta, tb]) THEN
        RAISE EXCEPTION 'enumeration must return both fixture tenants, saw %', ids;
    END IF;
    -- Creation order: A (created first) precedes B in the full listing.
    SELECT array_agg(t.o_tenant_id) INTO ids FROM control.list_scheduler_tenants() AS t;
    IF array_position(ids, ta) IS NULL OR array_position(ids, tb) IS NULL
        OR array_position(ids, ta) > array_position(ids, tb) THEN
        RAISE EXCEPTION 'enumeration must list tenants in creation order';
    END IF;
    RAISE NOTICE 'enumeration OK: fixture tenants listed in creation order, pre-context, registry-only';
END $$;

-- 8) Boundaries untouched: app role is NOBYPASSRLS, outbox lifecycle roles
-- hold NOTHING on the inbox table (050 EXECUTE-only), and `outbox_claim`
-- still raises outside WORKER mode (051 gate intact -- 054 adds a worker,
-- never a second publisher).
DO $$
DECLARE
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'iptv_app') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'app role iptv_app must stay NOBYPASSRLS';
    END IF;
    IF has_table_privilege('outbox_worker', 'platform.inbox_messages', 'SELECT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_worker', 'platform.inbox_messages', 'INSERT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_worker', 'platform.inbox_messages', 'UPDATE') IS DISTINCT FROM false
        OR has_table_privilege('outbox_worker', 'platform.inbox_messages', 'DELETE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_worker must hold no privilege on platform.inbox_messages (050 EXECUTE-only boundary)';
    END IF;
    IF has_table_privilege('outbox_executor', 'platform.inbox_messages', 'SELECT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_executor', 'platform.inbox_messages', 'INSERT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_executor', 'platform.inbox_messages', 'UPDATE') IS DISTINCT FROM false
        OR has_table_privilege('outbox_executor', 'platform.inbox_messages', 'DELETE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_executor must hold no privilege on platform.inbox_messages (050 EXECUTE-only boundary)';
    END IF;
    IF (SELECT platform.outbox_runtime_mode()) IS DISTINCT FROM 'LEGACY' THEN
        RAISE EXCEPTION 'runtime mode seed must still be LEGACY';
    END IF;
    BEGIN
        PERFORM * FROM platform.outbox_claim(1, 'wiw-probe', 60);
        RAISE EXCEPTION 'expected outbox_claim to stay gated outside WORKER mode';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    -- Owner bypasses RLS: sees every tenant's rows regardless of context.
    SELECT count(*) INTO n FROM platform.inbox_messages WHERE provider = 'waha';
    IF n < 5 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see all waha fixture rows, saw %', n;
    END IF;
    RAISE NOTICE 'boundaries OK: NOBYPASSRLS, outbox roles excluded, 051 gate intact, owner bypass';
END $$;

-- 9) Inline x scheduler race, deterministic sequence both ways: claim-by-id
-- takes a RECEIVED row (PROCESSING + consumer stamped, tenant + payload
-- returned); a second claim-by-id AND the batch claim both see 0 rows for
-- it -- and vice versa: a batch-claimed row is invisible to claim-by-id.
-- Exactly one processor ever owns a row (no double-processing). Blank/NULL
-- arguments refused.
DO $$
DECLARE
    ta uuid;
    r record;
    n integer;
    id1 uuid;
    id2 uuid;
    took_race2 boolean := false;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta INTO ta FROM worker_fixture_ids s LIMIT 1;
    PERFORM platform.inbox_accept(ta, 'waha', 'wiw-race-1', 'waha.raw', 'hr1', '{"n":"race-1"}');
    PERFORM platform.inbox_accept(ta, 'waha', 'wiw-race-2', 'waha.raw', 'hr2', '{"n":"race-2"}');
    SELECT m.id INTO id1 FROM platform.inbox_messages AS m
    WHERE m.tenant_id = ta AND m.external_event_id = 'wiw-race-1';
    SELECT m.id INTO id2 FROM platform.inbox_messages AS m
    WHERE m.tenant_id = ta AND m.external_event_id = 'wiw-race-2';
    IF id1 IS NULL OR id2 IS NULL THEN
        RAISE EXCEPTION 'race fixture rows must exist';
    END IF;
    SET LOCAL ROLE iptv_app;

    -- Inline wins race-1: claim-by-id takes the row with tenant + payload.
    SELECT * INTO r FROM platform.inbox_claim_by_id(id1, 'inline:waha');
    IF r.o_inbox_id IS DISTINCT FROM id1 OR r.o_tenant_id IS DISTINCT FROM ta THEN
        RAISE EXCEPTION 'claim-by-id must take its RECEIVED row with tenant, saw %/%', r.o_inbox_id, r.o_tenant_id;
    END IF;
    IF r.o_payload_json IS NULL THEN
        RAISE EXCEPTION 'claim-by-id must return the row payload';
    END IF;

    -- Scheduler loses race-1: one batch takes the disjoint remainder --
    -- including race-2 -- but never the inline-claimed row (no
    -- double-processing). A single batch call proves both halves: what the
    -- inline claim took, the batch never sees again.
    FOR r IN SELECT * FROM platform.inbox_claim(10, 'waha', 'drain:waha') LOOP
        IF r.o_inbox_id = id1 THEN
            RAISE EXCEPTION 'batch claim re-claimed an inline-claimed row (claim protocols diverged)';
        END IF;
        IF r.o_inbox_id = id2 THEN
            took_race2 := true;
        END IF;
    END LOOP;
    IF took_race2 IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'batch claim must take the still-RECEIVED race-2 row';
    END IF;

    -- Vice versa complete: the inline claim loses on the drain-claimed row.
    SELECT count(*) INTO n FROM platform.inbox_claim_by_id(id2, 'inline:waha');
    IF n <> 0 THEN
        RAISE EXCEPTION 'claim-by-id on a drain-claimed row must return 0 rows, saw %', n;
    END IF;

    -- The inline winner carries PROCESSING + its consumer (owner read).
    RESET ROLE;
    SELECT count(*) INTO n FROM platform.inbox_messages
    WHERE id = id1 AND state = 'PROCESSING' AND claimed_by = 'inline:waha';
    IF n <> 1 THEN
        RAISE EXCEPTION 'inline-claimed row must be PROCESSING with the inline consumer stamped';
    END IF;

    -- Blank consumer / NULL id refused (no unbounded or unscoped claims).
    SET LOCAL ROLE iptv_app;
    BEGIN
        PERFORM * FROM platform.inbox_claim_by_id(id1, '  ');
        RAISE EXCEPTION 'expected blank consumer claim to fail';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    BEGIN
        PERFORM * FROM platform.inbox_claim_by_id(NULL, 'inline:waha');
        RAISE EXCEPTION 'expected NULL id claim to fail';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    RAISE NOTICE 'claim-by-id OK: inline x drain race resolves to exactly one owner each way, blanks refused';
END $$;

-- 10) Orphaned PROCESSING rows: detection is read-only, recovery is explicit
-- operator-only, and NOTHING auto-reclaims. A stuck row (aged past the
-- threshold) is listed; a fresh PROCESSING row is not; listing mutates
-- nothing; invalid thresholds are refused; batch claims never touch
-- PROCESSING rows; `inbox_requeue` is unusable by every app/worker role and
-- -- run as the owner -- moves exactly one PROCESSING row back to RECEIVED
-- (claimed_by cleared) so the next drain claims it, while requeueing a
-- RECEIVED/PROCESSED/missing row raises instead of repairing silently.
DO $$
DECLARE
    ta uuid;
    n integer;
    stuck uuid;
    fresh uuid;
    recv uuid;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta INTO ta FROM worker_fixture_ids s LIMIT 1;
    PERFORM platform.inbox_accept(ta, 'waha', 'wiw-stuck-1', 'waha.raw', 'hs1', '{"n":"stuck-1"}');
    PERFORM platform.inbox_accept(ta, 'waha', 'wiw-fresh-1', 'waha.raw', 'hf1', '{"n":"fresh-1"}');
    PERFORM platform.inbox_accept(ta, 'waha', 'wiw-recv-1', 'waha.raw', 'hrv1', '{"n":"recv-1"}');
    SELECT m.id INTO stuck FROM platform.inbox_messages AS m
    WHERE m.tenant_id = ta AND m.external_event_id = 'wiw-stuck-1';
    SELECT m.id INTO fresh FROM platform.inbox_messages AS m
    WHERE m.tenant_id = ta AND m.external_event_id = 'wiw-fresh-1';
    SELECT m.id INTO recv FROM platform.inbox_messages AS m
    WHERE m.tenant_id = ta AND m.external_event_id = 'wiw-recv-1';
    SET LOCAL ROLE iptv_app;
    PERFORM * FROM platform.inbox_claim_by_id(stuck, 'drain:waha');
    PERFORM * FROM platform.inbox_claim_by_id(fresh, 'drain:waha');
    RESET ROLE;
    -- Age ONLY the stuck row past the threshold (fresh stays young).
    UPDATE platform.inbox_messages SET received_at = now() - interval '1 hour' WHERE id = stuck;

    -- Detection as iptv_app: the aged row is listed, the fresh one is not.
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM platform.inbox_stuck_list(interval '15 minutes') WHERE o_inbox_id = stuck;
    IF n <> 1 THEN
        RAISE EXCEPTION 'stuck_list must report the aged PROCESSING row, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM platform.inbox_stuck_list(interval '15 minutes') WHERE o_inbox_id = fresh;
    IF n <> 0 THEN
        RAISE EXCEPTION 'stuck_list must NOT report a fresh PROCESSING row';
    END IF;

    -- Listing mutates nothing: both rows are still PROCESSING (owner read).
    PERFORM * FROM platform.inbox_stuck_list(interval '15 minutes');
    RESET ROLE;
    SELECT count(*) INTO n FROM platform.inbox_messages
    WHERE id IN (stuck, fresh) AND state = 'PROCESSING';
    IF n <> 2 THEN
        RAISE EXCEPTION 'stuck_list must be read-only (rows left PROCESSING), saw % still PROCESSING', n;
    END IF;

    -- Invalid thresholds refused (no unbounded or negative detection).
    SET LOCAL ROLE iptv_app;
    BEGIN
        PERFORM * FROM platform.inbox_stuck_list(NULL);
        RAISE EXCEPTION 'expected NULL threshold listing to fail';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    BEGIN
        PERFORM * FROM platform.inbox_stuck_list(interval '0 seconds');
        RAISE EXCEPTION 'expected zero threshold listing to fail';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;

    -- No auto-reclaim: batch claims see NEITHER PROCESSING row.
    SELECT count(*) INTO n FROM platform.inbox_claim(10, 'waha', 'drain:auto') WHERE o_inbox_id IN (stuck, fresh);
    IF n <> 0 THEN
        RAISE EXCEPTION 'PROCESSING rows must never be auto-reclaimed, saw %', n;
    END IF;

    -- requeue is operator-only: every runtime role fails it (checked here as
    -- the privilege matrix, enforced again by the migration itself).
    IF has_function_privilege('iptv_app', 'platform.inbox_requeue(uuid)', 'EXECUTE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'iptv_app must NOT execute inbox_requeue (operator-only recovery)';
    END IF;
    IF has_function_privilege('outbox_worker', 'platform.inbox_requeue(uuid)', 'EXECUTE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_worker must NOT execute inbox_requeue (operator-only recovery)';
    END IF;
    IF has_function_privilege('outbox_executor', 'platform.inbox_requeue(uuid)', 'EXECUTE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_executor must NOT execute inbox_requeue (operator-only recovery)';
    END IF;

    -- Explicit recovery as the owner (operator): the stuck row goes back to
    -- RECEIVED with claimed_by cleared ...
    RESET ROLE;
    IF platform.inbox_requeue(stuck) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'inbox_requeue must return true for a PROCESSING row';
    END IF;
    SELECT count(*) INTO n FROM platform.inbox_messages
    WHERE id = stuck AND state = 'RECEIVED' AND claimed_by IS NULL;
    IF n <> 1 THEN
        RAISE EXCEPTION 'requeued row must be RECEIVED with claimed_by cleared';
    END IF;

    -- ... so the next drain claims exactly it (the recovery path works).
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM platform.inbox_claim(10, 'waha', 'drain:after-requeue') WHERE o_inbox_id = stuck;
    IF n <> 1 THEN
        RAISE EXCEPTION 'requeued row must become claimable again, saw %', n;
    END IF;

    -- Refusals, never silent repair: RECEIVED / terminal / missing rows raise.
    RESET ROLE;
    BEGIN
        PERFORM platform.inbox_requeue(recv);
        RAISE EXCEPTION 'expected requeue of a RECEIVED row to fail';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    UPDATE platform.inbox_messages SET state = 'PROCESSED', processed_at = now() WHERE id = stuck;
    BEGIN
        PERFORM platform.inbox_requeue(stuck);
        RAISE EXCEPTION 'expected requeue of a PROCESSED row to fail';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    BEGIN
        PERFORM platform.inbox_requeue(gen_random_uuid());
        RAISE EXCEPTION 'expected requeue of a missing row to fail';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    RAISE NOTICE 'stuck/requeue OK: read-only detection, operator-only explicit recovery, no auto-reclaim, refusals loud';
END $$;

ROLLBACK;
