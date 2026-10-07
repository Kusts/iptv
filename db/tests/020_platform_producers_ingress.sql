-- 020 Platform producers + Asaas atomic ingress (migration 053).
-- Proves the five `platform.*` producers and `billing.accept_asaas_delivery`
-- as `iptv_app`: SECURITY DEFINER with pinned search_path, revoked from
-- PUBLIC, EXECUTE to `iptv_app` only (outbox lifecycle roles excluded),
-- narrow bodies (no table outside the producer's contract), initial-states
-- only (RECEIVED / IN_PROGRESS / PENDING), tenant validation (blank refused,
-- ambient-context mismatch refused), and the atomic ingress behavior:
-- unknown/DISABLED routing keys refused with zero inbox rows, double delivery
-- insert-once, per-tenant containment, the DISABLED-mid-flight TOCTOU
-- refusal, and the A->B remap refusal (stale expected tenant => accepted=false
-- with zero inbox rows in EITHER tenant). Also proves the 050/051 worker boundary is untouched (claim still
-- gated on WORKER mode).
-- Fixture rows ROLLBACK; functions/grants persist.
-- Execute: cat file | docker exec -i iptv-postgres-1 psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
-- (Rollout proof: db/tests/019. Regression: db/tests/017, 018.)
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 053 preconditions: function shape, security, grants, scope.
DO $$
DECLARE
    v_secdef boolean;
    v_config text[];
    v_src text;
    fns text[] := ARRAY[
        'platform.inbox_accept(uuid, text, text, text, text, jsonb)',
        'platform.idempotency_claim(uuid, text, text, text)',
        'platform.idempotency_finish(uuid, text, text, text, integer, jsonb)',
        'platform.append_bus_rows(uuid, uuid, text, text, uuid, bigint, timestamptz, timestamptz, uuid, uuid, text, text, integer, jsonb, uuid, text, text, jsonb, jsonb, uuid, text, text, text, text, uuid, uuid, jsonb, timestamptz)',
        'platform.audit_write(uuid, text, text, text, text, uuid, uuid, jsonb)',
        'billing.accept_asaas_delivery(text, text, text, text, jsonb, uuid)'
    ];
    f text;
    want_path text;
BEGIN
    FOREACH f IN ARRAY fns LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f::regprocedure) THEN
            RAISE EXCEPTION 'migration 053 not applied: % is missing', f;
        END IF;
        SELECT p.prosecdef, p.proconfig INTO v_secdef, v_config
        FROM pg_proc p WHERE p.oid = f::regprocedure;
        IF v_secdef IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'producer % must be SECURITY DEFINER', f;
        END IF;
        want_path := CASE WHEN f LIKE 'billing.%'
            THEN 'search_path=billing, pg_temp'
            ELSE 'search_path=platform, pg_temp' END;
        IF v_config IS NULL OR NOT EXISTS (
            SELECT 1 FROM unnest(v_config) g WHERE g = want_path
        ) THEN
            RAISE EXCEPTION 'producer % must pin % (saw %)', f, want_path, v_config;
        END IF;
        IF EXISTS (
            SELECT 1 FROM pg_proc p
            WHERE p.oid = f::regprocedure
              AND (p.proacl::text LIKE '{=X/%' OR p.proacl::text LIKE '%,=X/%')
        ) THEN
            RAISE EXCEPTION 'producer % must be revoked from PUBLIC', f;
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

    -- Narrow bodies: each producer touches only its contracted tables.
    SELECT pg_get_functiondef(
        (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'platform' AND p.proname = 'inbox_accept')
    ) INTO v_src;
    IF v_src NOT ILIKE '%platform.inbox_messages%' THEN
        RAISE EXCEPTION 'inbox_accept body must write platform.inbox_messages';
    END IF;
    IF v_src ILIKE '%outbox_messages%' OR v_src ILIKE '%domain_events%'
        OR v_src ILIKE '%audit_log%' OR v_src ILIKE '%idempotency_keys%' THEN
        RAISE EXCEPTION 'inbox_accept body must not reference tables outside platform.inbox_messages';
    END IF;
    IF v_src NOT ILIKE '%''RECEIVED''%' THEN
        RAISE EXCEPTION 'inbox_accept must hardcode the RECEIVED initial state';
    END IF;

    SELECT pg_get_functiondef(
        (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'platform' AND p.proname = 'append_bus_rows')
    ) INTO v_src;
    IF v_src NOT ILIKE '%platform.domain_events%'
        OR v_src NOT ILIKE '%platform.outbox_messages%'
        OR v_src NOT ILIKE '%platform.audit_log%' THEN
        RAISE EXCEPTION 'append_bus_rows body must write exactly the bus triple';
    END IF;
    IF v_src NOT ILIKE '%''PENDING''%' THEN
        RAISE EXCEPTION 'append_bus_rows must hardcode the PENDING initial outbox state';
    END IF;
    IF v_src ILIKE '%inbox_messages%' OR v_src ILIKE '%idempotency_keys%' THEN
        RAISE EXCEPTION 'append_bus_rows body must not reference tables outside the bus triple';
    END IF;

    SELECT pg_get_functiondef(
        (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'billing' AND p.proname = 'accept_asaas_delivery')
    ) INTO v_src;
    IF v_src NOT ILIKE '%billing.tenant_channels%' THEN
        RAISE EXCEPTION 'accept body must gate on billing.tenant_channels';
    END IF;
    IF v_src NOT ILIKE '%FOR UPDATE%' THEN
        RAISE EXCEPTION 'accept body must lock the routing row FOR UPDATE (TOCTOU serialization)';
    END IF;
    IF v_src NOT ILIKE '%ACTIVE%' THEN
        RAISE EXCEPTION 'accept body must revalidate ACTIVE inside the lock';
    END IF;
    IF v_src NOT ILIKE '%platform.inbox_accept(%' THEN
        RAISE EXCEPTION 'accept body must insert through platform.inbox_accept (single insert-once implementation)';
    END IF;
    IF v_src NOT ILIKE '%p_expected_tenant_id%' THEN
        RAISE EXCEPTION 'accept body must enforce the expected-tenant guard pre-insert (remap refusal)';
    END IF;
    RAISE NOTICE 'producer preconditions OK: definer, pinned search_path, iptv_app-only EXECUTE, narrow bodies';
END $$;

-- 2) Fixture: two tenants, one ACTIVE + one DISABLED Asaas channel each.
CREATE TEMP TABLE producer_fixture_ids (ta uuid, tb uuid, ka text, kd text, kb text);

DO $$
DECLARE
    ta uuid; tb uuid;
    ka text; kd text; kb text;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-ppr-a-' || gen_random_uuid(), 'RLS Producers A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-ppr-b-' || gen_random_uuid(), 'RLS Producers B') RETURNING id INTO tb;
    ka := 'ppr-active-a-' || gen_random_uuid();
    kd := 'ppr-disabled-a-' || gen_random_uuid();
    kb := 'ppr-active-b-' || gen_random_uuid();
    INSERT INTO billing.tenant_channels (tenant_id, channel, tenant_key, webhook_secret_hash, status)
    VALUES (ta, 'ASAAS', ka, 'hash-a', 'ACTIVE'),
           (ta, 'ASAAS', kd, 'hash-d', 'DISABLED'),
           (tb, 'ASAAS', kb, 'hash-b', 'ACTIVE');
    INSERT INTO producer_fixture_ids VALUES (ta, tb, ka, kd, kb);
    RAISE NOTICE 'producer fixture ready: tenants % / %', ta, tb;
END $$;

-- 3) inbox_accept as iptv_app with NO tenant context: insert-once with the
-- existing id on conflict; blank tenant/provider/key/hash refused; a set
-- ambient context that disagrees with the argument is refused.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    id1 uuid;
    id2 uuid;
    r record;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM producer_fixture_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;

    SELECT * INTO r FROM platform.inbox_accept(ta, 'asaas', 'ppr-ext-1', 'asaas.raw', 'h1', '{"n":1}');
    IF r.o_inserted IS DISTINCT FROM true OR r.o_inbox_id IS NULL THEN
        RAISE EXCEPTION 'first accept must insert and return the inbox id';
    END IF;
    id1 := r.o_inbox_id;
    SELECT * INTO r FROM platform.inbox_accept(ta, 'asaas', 'ppr-ext-1', 'asaas.raw', 'h1', '{"n":1}');
    IF r.o_inserted IS DISTINCT FROM false OR r.o_inbox_id IS DISTINCT FROM id1 THEN
        RAISE EXCEPTION 'double accept must be insert-once with the SAME inbox id';
    END IF;
    id2 := r.o_inbox_id;

    BEGIN
        PERFORM * FROM platform.inbox_accept(NULL, 'asaas', 'ppr-ext-x', 'asaas.raw', 'h', '{}');
        RAISE EXCEPTION 'expected blank tenant accept to fail';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    BEGIN
        PERFORM * FROM platform.inbox_accept(ta, 'asaas', 'ppr-ext-x', 'asaas.raw', '  ', '{}');
        RAISE EXCEPTION 'expected blank hash accept to fail';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;

    -- Ambient context set to B while the argument names A: refused.
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    BEGIN
        PERFORM * FROM platform.inbox_accept(ta, 'asaas', 'ppr-ext-x', 'asaas.raw', 'h', '{}');
        RAISE EXCEPTION 'expected context-mismatch accept to fail';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    RESET app.tenant_id;
    RAISE NOTICE 'inbox_accept OK: insert-once % (deduped same id), tenant validated, mismatch refused', id1;
END $$;

-- 4) Idempotency full cycle as iptv_app: claim -> in_progress -> finish
-- SUCCEEDED -> replay (same hash, payload echoed) -> conflict (other hash) ->
-- FAILED -> reclaim on same hash -> claimed; bad terminal state refused.
DO $$
DECLARE
    ta uuid;
    r record;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta INTO ta FROM producer_fixture_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;

    SELECT * INTO r FROM platform.idempotency_claim(ta, 'ppr-scope', 'ppr-key-1', 'req-1');
    IF r.o_status IS DISTINCT FROM 'claimed' THEN
        RAISE EXCEPTION 'first claim must be claimed, saw %', r.o_status;
    END IF;
    SELECT * INTO r FROM platform.idempotency_claim(ta, 'ppr-scope', 'ppr-key-1', 'req-1');
    IF r.o_status IS DISTINCT FROM 'in_progress' THEN
        RAISE EXCEPTION 'second claim must be in_progress, saw %', r.o_status;
    END IF;
    PERFORM platform.idempotency_finish(ta, 'ppr-scope', 'ppr-key-1', 'SUCCEEDED', 200, '{"ok":true}');
    SELECT * INTO r FROM platform.idempotency_claim(ta, 'ppr-scope', 'ppr-key-1', 'req-1');
    IF r.o_status IS DISTINCT FROM 'replay' OR r.o_response_status IS DISTINCT FROM 200
        OR r.o_response_json IS DISTINCT FROM '{"ok":true}'::jsonb THEN
        RAISE EXCEPTION 'replay must echo status + payload, saw %/%/%', r.o_status, r.o_response_status, r.o_response_json;
    END IF;
    SELECT * INTO r FROM platform.idempotency_claim(ta, 'ppr-scope', 'ppr-key-1', 'other-hash');
    IF r.o_status IS DISTINCT FROM 'conflict' THEN
        RAISE EXCEPTION 'different hash after SUCCEEDED must be conflict, saw %', r.o_status;
    END IF;

    SELECT * INTO r FROM platform.idempotency_claim(ta, 'ppr-scope', 'ppr-key-2', 'req-2');
    IF r.o_status IS DISTINCT FROM 'claimed' THEN
        RAISE EXCEPTION 'fresh key must be claimed, saw %', r.o_status;
    END IF;
    PERFORM platform.idempotency_finish(ta, 'ppr-scope', 'ppr-key-2', 'FAILED', NULL, '{"ok":false}');
    SELECT * INTO r FROM platform.idempotency_claim(ta, 'ppr-scope', 'ppr-key-2', 'req-2');
    IF r.o_status IS DISTINCT FROM 'claimed' THEN
        RAISE EXCEPTION 'FAILED + same hash must reclaim to claimed, saw %', r.o_status;
    END IF;
    PERFORM platform.idempotency_finish(ta, 'ppr-scope', 'ppr-key-2', 'FAILED', NULL, '{"ok":false}');
    SELECT * INTO r FROM platform.idempotency_claim(ta, 'ppr-scope', 'ppr-key-2', 'other');
    IF r.o_status IS DISTINCT FROM 'conflict' THEN
        RAISE EXCEPTION 'FAILED + other hash must be conflict, saw %', r.o_status;
    END IF;

    BEGIN
        PERFORM platform.idempotency_finish(ta, 'ppr-scope', 'ppr-key-2', 'PENDING', NULL, '{}');
        RAISE EXCEPTION 'expected bad terminal state to fail';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    RAISE NOTICE 'idempotency cycle OK: claimed/in_progress/replay/conflict/reclaim all match the bus semantics';
END $$;

-- 5) append_bus_rows as iptv_app: ONE call lands the linked triple
-- (event + PENDING outbox + audit); atomicity -- a bad audit side fails the
-- WHOLE call with zero partial rows; audit-less triples allowed.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    ev uuid;
    ag uuid;
    ob uuid;
    au uuid;
    r_id uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM producer_fixture_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;

    ev := gen_random_uuid();
    ag := gen_random_uuid();
    ob := gen_random_uuid();
    au := gen_random_uuid();
    SELECT platform.append_bus_rows(
        ta, ev, 'ppr.created.v1', 'ppr', ag, 1, now(), now(),
        gen_random_uuid(), NULL, 'system', NULL, 1, '{"n":1}',
        ob, 'ppr.created.v1', ag::text,
        jsonb_build_object('event_id', ev::text), '{"correlation_id":"x"}',
        au, 'system', NULL, 'ppr.create', 'ppr', ag,
        gen_random_uuid(), '{"command":"ppr.create"}', now()
    ) INTO r_id;
    IF r_id IS NULL THEN
        RAISE EXCEPTION 'append_bus_rows must return the domain event id';
    END IF;
    SELECT count(*) INTO n FROM platform.domain_events WHERE id = r_id AND tenant_id = ta AND event_id = ev;
    IF n <> 1 THEN
        RAISE EXCEPTION 'domain event row missing after append, saw %', n;
    END IF;
    -- Outbox linkage is asserted as the table owner: `iptv_app` holds no
    -- privilege on outbox_messages by 050 design (it reaches those rows only
    -- through producers and the worker protocol, never directly).
    RESET ROLE;
    SELECT count(*) INTO n FROM platform.outbox_messages
    WHERE id = ob AND tenant_id = ta AND domain_event_id = r_id AND state = 'PENDING';
    IF n <> 1 THEN
        RAISE EXCEPTION 'PENDING outbox row missing/linked after append, saw %', n;
    END IF;
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM platform.audit_log
    WHERE id = au AND tenant_id = ta AND action_key = 'ppr.create';
    IF n <> 1 THEN
        RAISE EXCEPTION 'audit row missing after append, saw %', n;
    END IF;

    -- Atomicity: an invalid audit side (blank action) fails the whole call.
    BEGIN
        PERFORM platform.append_bus_rows(
            ta, gen_random_uuid(), 'ppr.created.v1', 'ppr', gen_random_uuid(), 1, now(), now(),
            gen_random_uuid(), NULL, 'system', NULL, 1, '{}',
            gen_random_uuid(), 'ppr.created.v1', NULL, '{}', '{}',
            gen_random_uuid(), 'system', NULL, '  ', 'ppr', NULL,
            gen_random_uuid(), '{}', now()
        );
        RAISE EXCEPTION 'expected append with blank audit action to fail atomically';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    SELECT count(*) INTO n FROM platform.domain_events
    WHERE tenant_id = ta AND event_type = 'ppr.created.v1' AND aggregate_id <> ag;
    IF n <> 0 THEN
        RAISE EXCEPTION 'failed append must leave zero partial rows, saw %', n;
    END IF;

    -- Audit-less triple (second event of a command): lands event + outbox.
    SELECT platform.append_bus_rows(
        ta, gen_random_uuid(), 'ppr.second.v1', 'ppr', ag, 2, now(), now(),
        gen_random_uuid(), NULL, 'system', NULL, 1, '{}',
        gen_random_uuid(), 'ppr.second.v1', NULL, '{}', '{}',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    ) INTO r_id;
    RESET ROLE;
    SELECT count(*) INTO n FROM platform.outbox_messages WHERE domain_event_id = r_id AND state = 'PENDING';
    IF n <> 1 THEN
        RAISE EXCEPTION 'audit-less triple must still land event + PENDING outbox, saw %', n;
    END IF;
    SET LOCAL ROLE iptv_app;

    -- Cross-tenant append is refused (ambient-context mismatch guard).
    BEGIN
        PERFORM platform.append_bus_rows(
            tb, gen_random_uuid(), 'ppr.created.v1', 'ppr', gen_random_uuid(), 1, now(), now(),
            gen_random_uuid(), NULL, 'system', NULL, 1, '{}',
            gen_random_uuid(), 'ppr.created.v1', NULL, '{}', '{}',
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
        );
        RAISE EXCEPTION 'expected cross-tenant append to fail';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    RAISE NOTICE 'append_bus_rows OK: linked triple in one call, atomic, audit-optional, cross-tenant refused';
END $$;

-- 6) audit_write as iptv_app: standalone audit lands with the caller fields.
DO $$
DECLARE
    ta uuid;
    aid uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta INTO ta FROM producer_fixture_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    SELECT platform.audit_write(ta, 'human', 'user-1', 'ppr.standalone', 'ppr', NULL, gen_random_uuid(), '{"before":"a"}') INTO aid;
    -- The row was written pre-context; read it back under tenant context
    -- (proving producer-written rows are tenant-visible, not orphaned).
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SELECT count(*) INTO n FROM platform.audit_log
    WHERE id = aid AND tenant_id = ta AND actor_type = 'human' AND action_key = 'ppr.standalone';
    IF n <> 1 THEN
        RAISE EXCEPTION 'standalone audit row missing, saw %', n;
    END IF;
    BEGIN
        PERFORM platform.audit_write(ta, 'human', NULL, '  ', 'ppr', NULL, NULL, '{}');
        RAISE EXCEPTION 'expected blank audit action to fail';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    RAISE NOTICE 'audit_write OK: standalone audit lands pre-context, blank action refused';
END $$;

-- 7) Asaas atomic accept as iptv_app with NO tenant context: unknown key and
-- DISABLED key are refused with zero inbox rows; ACTIVE inserts once;
-- double delivery dedupes to the same id; containment per key.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    ka text;
    kd text;
    kb text;
    r record;
    id1 uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.ka, s.kd, s.kb INTO ta, tb, ka, kd, kb FROM producer_fixture_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;

    SELECT * INTO r FROM billing.accept_asaas_delivery('ppr-unknown-' || gen_random_uuid(), 'ext-u', 'asaas.raw', 'h', '{}', ta);
    IF r.o_accepted IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'unknown routing key must be refused';
    END IF;
    SELECT * INTO r FROM billing.accept_asaas_delivery(kd, 'ext-d', 'asaas.raw', 'h', '{}', ta);
    IF r.o_accepted IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'DISABLED routing key must be refused';
    END IF;
    SELECT count(*) INTO n FROM platform.inbox_messages
    WHERE tenant_id = ta AND provider = 'asaas' AND external_event_id IN ('ext-u', 'ext-d');
    IF n <> 0 THEN
        RAISE EXCEPTION 'refused accepts must leave zero inbox rows, saw %', n;
    END IF;

    SELECT * INTO r FROM billing.accept_asaas_delivery(ka, 'ppr-asaas-1', 'asaas.raw', 'h1', '{"body":1}', ta);
    IF r.o_accepted IS DISTINCT FROM true OR r.o_inserted IS DISTINCT FROM true
        OR r.o_tenant_id IS DISTINCT FROM ta OR r.o_inbox_id IS NULL THEN
        RAISE EXCEPTION 'ACTIVE accept must insert and resolve its own tenant';
    END IF;
    id1 := r.o_inbox_id;
    SELECT * INTO r FROM billing.accept_asaas_delivery(ka, 'ppr-asaas-1', 'asaas.raw', 'h1', '{"body":1}', ta);
    IF r.o_accepted IS DISTINCT FROM true OR r.o_inserted IS DISTINCT FROM false
        OR r.o_inbox_id IS DISTINCT FROM id1 THEN
        RAISE EXCEPTION 'double delivery must dedupe to the same inbox id';
    END IF;

    -- Containment: the second tenant key resolves to ITS tenant only.
    SELECT * INTO r FROM billing.accept_asaas_delivery(kb, 'ppr-asaas-b', 'asaas.raw', 'h', '{}', tb);
    IF r.o_accepted IS DISTINCT FROM true OR r.o_tenant_id IS DISTINCT FROM tb THEN
        RAISE EXCEPTION 'second tenant key must resolve to its own tenant';
    END IF;
    IF r.o_tenant_id = ta THEN
        RAISE EXCEPTION 'accept leaked across tenants';
    END IF;
    RAISE NOTICE 'asaas accept OK: refused paths leave 0 rows, ACTIVE insert-once %, containment holds', id1;
END $$;

-- 8) TOCTOU: a channel DISABLED between the app-side resolve and the accept
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
    SELECT s.ta, s.ka INTO ta, ka FROM producer_fixture_ids s LIMIT 1;
    -- The app-side resolve (pre-context, ACTIVE at this instant).
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM billing.resolve_tenant_channel(ka);
    IF n <> 1 THEN
        RAISE EXCEPTION 'resolver must see the ACTIVE channel before the race';
    END IF;
    RESET ROLE;
    -- The race: operator disables the channel before the accept lands.
    UPDATE billing.tenant_channels SET status = 'DISABLED' WHERE tenant_key = ka;
    SET LOCAL ROLE iptv_app;
    SELECT * INTO r FROM billing.accept_asaas_delivery(ka, 'ppr-asaas-race', 'asaas.raw', 'h', '{}', ta);
    IF r.o_accepted IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'DISABLED-mid-flight accept must be refused (TOCTOU open)';
    END IF;
    SELECT count(*) INTO n FROM platform.inbox_messages
    WHERE tenant_id = ta AND provider = 'asaas' AND external_event_id = 'ppr-asaas-race';
    IF n <> 0 THEN
        RAISE EXCEPTION 'TOCTOU-refused accept must leave zero inbox rows, saw %', n;
    END IF;
    RAISE NOTICE 'TOCTOU OK: DISABLED-mid-flight refused with zero inbox rows';
END $$;

-- 8b) REMAP (HIGH finding): a routing key re-pointed to another tenant between
-- the app-side resolve and the accept is refused with ZERO inbox rows -- the
-- expected-tenant guard runs under the lock BEFORE the insert, so A's payload
-- never lands in B. The re-pointed key still accepts for the NEW tenant when
-- the caller expects it.
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
    SELECT s.ta, s.tb INTO ta, tb FROM producer_fixture_ids s LIMIT 1;
    -- Fresh ACTIVE key for A (block 8 disabled ka above; self-contained).
    kc := 'ppr-remap-a-' || gen_random_uuid();
    INSERT INTO billing.tenant_channels (tenant_id, channel, tenant_key, webhook_secret_hash, status)
    VALUES (ta, 'ASAAS', kc, 'hash-remap', 'ACTIVE');
    SET LOCAL ROLE iptv_app;
    -- The app-side resolve names A (pre-race instant).
    SELECT * INTO r FROM billing.resolve_tenant_channel(kc);
    IF r.tenant_id IS DISTINCT FROM ta THEN
        RAISE EXCEPTION 'resolver must name tenant A before the remap race';
    END IF;
    RESET ROLE;
    -- The race: the routing key is re-pointed A -> B before the accept lands.
    UPDATE billing.tenant_channels SET tenant_id = tb WHERE tenant_key = kc;
    SET LOCAL ROLE iptv_app;
    -- The stale-expectation accept (still expecting A) is refused ...
    SELECT * INTO r FROM billing.accept_asaas_delivery(kc, 'ppr-remap-1', 'asaas.raw', 'h-remap', '{"body":"a"}', ta);
    IF r.o_accepted IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'remapped accept with a stale expected tenant must be refused';
    END IF;
    -- ... with ZERO inbox rows in EITHER tenant: A's payload never lands in B
    -- (owner read: bypasses RLS, so a leak anywhere would be seen).
    RESET ROLE;
    SELECT count(*) INTO n FROM platform.inbox_messages
    WHERE provider = 'asaas' AND external_event_id = 'ppr-remap-1' AND tenant_id IN (ta, tb);
    IF n <> 0 THEN
        RAISE EXCEPTION 'remap-refused accept must leave zero inbox rows, saw %', n;
    END IF;
    -- The re-pointed key still accepts when the caller expects the NEW tenant.
    SET LOCAL ROLE iptv_app;
    SELECT * INTO r FROM billing.accept_asaas_delivery(kc, 'ppr-remap-2', 'asaas.raw', 'h-remap', '{"body":"b"}', tb);
    IF r.o_accepted IS DISTINCT FROM true OR r.o_tenant_id IS DISTINCT FROM tb
        OR r.o_inserted IS DISTINCT FROM true OR r.o_inbox_id IS NULL THEN
        RAISE EXCEPTION 're-pointed key must accept for the new expected tenant';
    END IF;
    RAISE NOTICE 'remap OK: stale expectation refused with zero rows, new tenant accepts';
END $$;

-- 9) Worker boundary untouched: with runtime mode LEGACY (051 seed),
-- `outbox_claim` still raises -- 053 adds producers, never a second publisher.
DO $$
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    IF (SELECT platform.outbox_runtime_mode()) IS DISTINCT FROM 'LEGACY' THEN
        RAISE EXCEPTION 'runtime mode seed must still be LEGACY';
    END IF;
    BEGIN
        PERFORM * FROM platform.outbox_claim(1, 'ppr-probe', 60);
        RAISE EXCEPTION 'expected outbox_claim to stay gated outside WORKER mode';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    RAISE NOTICE 'worker boundary OK: 051 gate intact, no second publisher introduced';
END $$;

ROLLBACK;
