-- 015 Platform outbox worker proofs against migration 050 (hybrid-C).
-- Proves the dedicated worker boundary on `platform.outbox_messages`:
-- worker LOGIN role with EXECUTE-only on the four SECURITY DEFINER
-- lifecycle functions (claim/renew/complete/fail), server lease + token +
-- CAS fencing, crash reclaim without manual repair, tenant containment of
-- the worker process, bounded input fail-closed, append-only audit.
-- SINGLE SESSION: this file runs every scenario on one connection, so its
-- claim-disjointness section proves the state/lease exclusion, NOT lock
-- contention. Real two-session concurrency (SKIP LOCKED + cross-session CAS)
-- is proven by `apps/api/test/outbox-worker-concurrency.integration.test.ts`.
-- This does NOT wire the dedicated worker process, remove the in-process
-- scheduler drain, or enroll inbox/scheduler/dispatcher/billing/finance.
-- Fixture rows and attempted writes ROLLBACK; roles/functions/policies persist.
-- Execute only on a disposable database after applying every migration:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/015_platform_outbox_worker.sql
\set ON_ERROR_STOP on
BEGIN;

-- 1) Preconditions: roles, functions, grants, RLS, columns, index, trigger.
DO $$
DECLARE
    v_acl text;
    v_fn text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outbox_worker') THEN
        RAISE EXCEPTION 'migration 050 not applied: role outbox_worker is missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outbox_executor') THEN
        RAISE EXCEPTION 'migration 050 not applied: role outbox_executor is missing';
    END IF;
    IF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'outbox_worker') IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'outbox_worker must be LOGIN (the worker process authenticates as it)';
    END IF;
    IF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'outbox_executor') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_executor must be NOLOGIN (never a connection identity)';
    END IF;
    IF (SELECT rolinherit FROM pg_roles WHERE rolname = 'outbox_executor') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_executor must be NOINHERIT';
    END IF;
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'outbox_worker') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_worker must be NOBYPASSRLS (no BYPASSRLS shortcut)';
    END IF;
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'outbox_executor') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_executor must be NOBYPASSRLS (executor policy stays load-bearing)';
    END IF;
    IF (SELECT rolsuper FROM pg_roles WHERE rolname IN ('outbox_worker', 'outbox_executor') AND rolsuper) IS NOT NULL THEN
        RAISE EXCEPTION 'worker/executor roles must never be superuser';
    END IF;

    -- The four functions exist, are SECURITY DEFINER, executor-owned, with a
    -- fixed search_path and no PUBLIC execute.
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'platform' AND p.proname IN
        ('outbox_claim', 'outbox_renew', 'outbox_complete', 'outbox_fail')) <> 4 THEN
        RAISE EXCEPTION 'all four outbox lifecycle functions must exist';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'platform' AND p.proname IN
        ('outbox_claim', 'outbox_renew', 'outbox_complete', 'outbox_fail')
        AND (p.prosecdef IS DISTINCT FROM true
            OR pg_get_userbyid(p.proowner) <> 'outbox_executor'
            OR p.proconfig IS DISTINCT FROM ARRAY['search_path=platform, pg_temp'])
    ) THEN
        RAISE EXCEPTION 'functions must be SECURITY DEFINER, executor-owned, search_path pinned';
    END IF;
    SELECT proacl::text INTO v_acl FROM pg_proc
    WHERE oid = 'platform.outbox_claim(integer, text, integer)'::regprocedure;
    -- A PUBLIC grant appears as an empty grantee (`{=X/owner,...}`); grants to
    -- named roles (`role=X/owner`) are expected here (executor + worker).
    IF v_acl IS NULL OR v_acl ~ '([,{])=X/' THEN
        RAISE EXCEPTION 'outbox_claim must be revoked from PUBLIC, acl %', v_acl;
    END IF;
    IF NOT has_function_privilege('outbox_worker', 'platform.outbox_claim(integer, text, integer)', 'EXECUTE') THEN
        RAISE EXCEPTION 'outbox_worker must hold EXECUTE on outbox_claim';
    END IF;
    IF NOT has_function_privilege('outbox_worker', 'platform.outbox_renew(uuid, uuid, integer)', 'EXECUTE') THEN
        RAISE EXCEPTION 'outbox_worker must hold EXECUTE on outbox_renew';
    END IF;
    IF NOT has_function_privilege('outbox_worker', 'platform.outbox_complete(uuid, uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'outbox_worker must hold EXECUTE on outbox_complete';
    END IF;
    IF NOT has_function_privilege('outbox_worker', 'platform.outbox_fail(uuid, uuid, text, timestamptz)', 'EXECUTE') THEN
        RAISE EXCEPTION 'outbox_worker must hold EXECUTE on outbox_fail';
    END IF;
    -- PUBLIC EXECUTE appears in proacl as a bare "=X/grantor" entry
    -- (after "{" or ","); role grants look like "name=X/grantor" (013 idiom).
    FOR v_fn IN
        SELECT unnest(ARRAY[
            'platform.outbox_claim(integer, text, integer)',
            'platform.outbox_renew(uuid, uuid, integer)',
            'platform.outbox_complete(uuid, uuid)',
            'platform.outbox_fail(uuid, uuid, text, timestamptz)'
        ])
    LOOP
        IF EXISTS (
            SELECT 1 FROM pg_proc AS p
            WHERE p.oid = v_fn::regprocedure
              AND (p.proacl::text LIKE '{=X/%' OR p.proacl::text LIKE '%,=X/%')
        ) THEN
            RAISE EXCEPTION 'worker function % must be revoked from PUBLIC', v_fn;
        END IF;
    END LOOP;
    IF has_function_privilege('iptv_app', 'platform.outbox_claim(integer, text, integer)', 'EXECUTE')
        OR has_function_privilege('iptv_app', 'platform.outbox_renew(uuid, uuid, integer)', 'EXECUTE')
        OR has_function_privilege('iptv_app', 'platform.outbox_complete(uuid, uuid)', 'EXECUTE')
        OR has_function_privilege('iptv_app', 'platform.outbox_fail(uuid, uuid, text, timestamptz)', 'EXECUTE') THEN
        RAISE EXCEPTION 'iptv_app must not execute any worker function (API is not a worker)';
    END IF;

    -- Zero direct table privileges for the worker: EXECUTE-only, nothing else.
    IF has_table_privilege('outbox_worker', 'platform.outbox_messages', 'SELECT')
        OR has_table_privilege('outbox_worker', 'platform.outbox_messages', 'INSERT')
        OR has_table_privilege('outbox_worker', 'platform.outbox_messages', 'UPDATE')
        OR has_table_privilege('outbox_worker', 'platform.outbox_messages', 'DELETE')
        OR has_table_privilege('outbox_worker', 'platform.outbox_transitions', 'SELECT')
        OR has_table_privilege('outbox_worker', 'platform.outbox_transitions', 'INSERT')
        OR has_table_privilege('outbox_worker', 'platform.outbox_transitions', 'UPDATE')
        OR has_table_privilege('outbox_worker', 'platform.outbox_transitions', 'DELETE') THEN
        RAISE EXCEPTION 'outbox_worker must hold zero table privileges (EXECUTE on functions only)';
    END IF;
    -- Append-only audit: the executor may INSERT/SELECT but never UPDATE/DELETE.
    IF has_table_privilege('outbox_executor', 'platform.outbox_transitions', 'UPDATE')
        OR has_table_privilege('outbox_executor', 'platform.outbox_transitions', 'DELETE') THEN
        RAISE EXCEPTION 'outbox_executor must not hold UPDATE/DELETE on the audit table';
    END IF;

    -- RLS enabled with executor-only policies on exactly these tables.
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'platform.outbox_messages'::regclass) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'RLS is not enabled on platform.outbox_messages';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'platform.outbox_transitions'::regclass) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'RLS is not enabled on platform.outbox_transitions';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'platform'
        AND tablename = 'outbox_messages' AND policyname = 'outbox_executor_isolation') THEN
        RAISE EXCEPTION 'outbox_executor_isolation policy missing on outbox_messages';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'platform'
        AND tablename = 'outbox_transitions' AND policyname = 'outbox_executor_isolation') THEN
        RAISE EXCEPTION 'outbox_executor_isolation policy missing on outbox_transitions';
    END IF;

    -- Lease columns, recovery index, append-only trigger.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'platform'
        AND table_name = 'outbox_messages' AND column_name IN
        ('claim_token', 'claimed_by', 'lease_expires_at')
        HAVING count(*) = 3) THEN
        RAISE EXCEPTION 'lease columns missing on platform.outbox_messages';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'outbox_lease_recovery_idx') THEN
        RAISE EXCEPTION 'outbox_lease_recovery_idx is missing';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'outbox_pending_idx') IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'outbox_pending_idx (001) must be preserved unchanged';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'outbox_transitions_append_only') THEN
        RAISE EXCEPTION 'append-only trigger missing on platform.outbox_transitions';
    END IF;
END $$;

-- 2) Owner fixtures: two tenants, domain events, five outbox rows covering
-- due PENDING (A+B), due FAILED retry, future PENDING (never claimed),
-- terminal PUBLISHED (never re-claimed). Topics double as row labels.
CREATE TEMP TABLE outbox_proof_claims (
    topic text,
    outbox_id uuid,
    tenant_id uuid,
    claim_token uuid
);
-- Temp tables are permission-checked: the worker blocks below must be able
-- to stage their own claim receipts (owner blocks need no grant).
GRANT INSERT, SELECT ON outbox_proof_claims TO outbox_worker;

DO $$
DECLARE
    tenant_a uuid;
    tenant_b uuid;
    ev_a1 uuid;
    ev_b1 uuid;
    ev_a2 uuid;
    ev_b2f uuid;
    ev_a3 uuid;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('outbox-proof-a-' || gen_random_uuid(), 'Outbox Proof A')
    RETURNING id INTO tenant_a;
    INSERT INTO control.tenants (slug, name)
    VALUES ('outbox-proof-b-' || gen_random_uuid(), 'Outbox Proof B')
    RETURNING id INTO tenant_b;

    INSERT INTO platform.domain_events
        (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, occurred_at, correlation_id, actor_type)
    VALUES (tenant_a, 'proof.event', 'proof', gen_random_uuid(), 1, now(), gen_random_uuid(), 'system')
    RETURNING id INTO ev_a1;
    INSERT INTO platform.domain_events
        (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, occurred_at, correlation_id, actor_type)
    VALUES (tenant_b, 'proof.event', 'proof', gen_random_uuid(), 1, now(), gen_random_uuid(), 'system')
    RETURNING id INTO ev_b1;
    INSERT INTO platform.domain_events
        (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, occurred_at, correlation_id, actor_type)
    VALUES (tenant_a, 'proof.event', 'proof', gen_random_uuid(), 2, now(), gen_random_uuid(), 'system')
    RETURNING id INTO ev_a2;
    INSERT INTO platform.domain_events
        (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, occurred_at, correlation_id, actor_type)
    VALUES (tenant_b, 'proof.event', 'proof', gen_random_uuid(), 2, now(), gen_random_uuid(), 'system')
    RETURNING id INTO ev_b2f;
    INSERT INTO platform.domain_events
        (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, occurred_at, correlation_id, actor_type)
    VALUES (tenant_a, 'proof.event', 'proof', gen_random_uuid(), 3, now(), gen_random_uuid(), 'system')
    RETURNING id INTO ev_a3;

    INSERT INTO platform.outbox_messages
        (tenant_id, domain_event_id, topic, message_key, payload_json, state, next_attempt_at)
    VALUES
        (tenant_a, ev_a1, 'proof.a1', 'k-a1', '{"n":1}', 'PENDING', now() - make_interval(secs => 10)),
        (tenant_b, ev_b1, 'proof.b1', 'k-b1', '{"n":2}', 'PENDING', now() - make_interval(secs => 10)),
        (tenant_a, ev_a2, 'proof.a2', 'k-a2', '{"n":3}', 'FAILED', now() - make_interval(secs => 10)),
        (tenant_b, ev_b2f, 'proof.b2f', 'k-b2f', '{"n":4}', 'PENDING', now() + make_interval(hours => 1)),
        (tenant_a, ev_a3, 'proof.a3', 'k-a3', '{"n":5}', 'PUBLISHED', now() - make_interval(hours => 1));
    UPDATE platform.outbox_messages SET published_at = now() WHERE topic = 'proof.a3';
END $$;

-- 3) Claim básico: worker autorizado reclama os 3 vencidos (A+B, cross-tenant
-- por desenho), com token, lease futuro, payload e attempt incrementado.
DO $$
DECLARE
    claimed integer;
    null_tokens integer;
    future_row integer;
    terminal_row integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SET LOCAL ROLE outbox_worker;

    INSERT INTO outbox_proof_claims (topic, outbox_id, tenant_id, claim_token)
    SELECT c.topic, c.id, c.tenant_id, c.claim_token
    FROM platform.outbox_claim(10, 'w1', 300) AS c;
    GET DIAGNOSTICS claimed = ROW_COUNT;
    IF claimed <> 3 THEN
        RAISE EXCEPTION 'initial claim must return exactly the 3 due rows, got %', claimed;
    END IF;

    SELECT count(*) INTO null_tokens FROM outbox_proof_claims WHERE claim_token IS NULL;
    IF null_tokens <> 0 THEN
        RAISE EXCEPTION 'every claimed row needs a server-generated token';
    END IF;
    IF (SELECT count(DISTINCT claim_token) FROM outbox_proof_claims) <> 3 THEN
        RAISE EXCEPTION 'claim tokens must be distinct per row';
    END IF;
    IF (SELECT count(*) FROM outbox_proof_claims WHERE topic IN ('proof.b2f', 'proof.a3')) <> 0 THEN
        RAISE EXCEPTION 'future and terminal rows must never be claimed';
    END IF;

    RESET ROLE;
    SELECT count(*) INTO future_row FROM platform.outbox_messages
    WHERE topic = 'proof.b2f' AND state = 'PENDING' AND claim_token IS NULL;
    IF future_row <> 1 THEN
        RAISE EXCEPTION 'future row must stay untouched PENDING without a token';
    END IF;
    SELECT count(*) INTO terminal_row FROM platform.outbox_messages
    WHERE topic = 'proof.a3' AND state = 'PUBLISHED';
    IF terminal_row <> 1 THEN
        RAISE EXCEPTION 'terminal row must stay PUBLISHED';
    END IF;
END $$;

-- 4) Worker não lê tabela nenhuma diretamente (EXECUTE-only, sem oracle).
DO $$
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SET LOCAL ROLE outbox_worker;

    BEGIN
        PERFORM 1 FROM platform.outbox_messages LIMIT 1;
        RAISE EXCEPTION 'expected worker direct table read to fail';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    BEGIN
        PERFORM 1 FROM crm.customers LIMIT 1;
        RAISE EXCEPTION 'expected worker tenant-table read to fail';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
END $$;

-- 5) API role não executa nenhuma função do worker.
DO $$
DECLARE
    v_id uuid;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT outbox_id INTO v_id FROM outbox_proof_claims WHERE topic = 'proof.a1';
    SET LOCAL ROLE iptv_app;

    BEGIN
        PERFORM platform.outbox_claim(1, 'api', 300);
        RAISE EXCEPTION 'expected iptv_app claim to fail';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    BEGIN
        PERFORM platform.outbox_renew(v_id, gen_random_uuid(), 300);
        RAISE EXCEPTION 'expected iptv_app renew to fail';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    BEGIN
        PERFORM platform.outbox_complete(v_id, gen_random_uuid());
        RAISE EXCEPTION 'expected iptv_app complete to fail';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    BEGIN
        PERFORM platform.outbox_fail(v_id, gen_random_uuid(), 'X', NULL);
        RAISE EXCEPTION 'expected iptv_app fail to fail';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
END $$;

-- 6) Disjoint claims: dois workers nunca detêm claim atual sobre a mesma row.
DO $$
DECLARE
    first_id uuid;
    second_id uuid;
    third_count integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;

    -- Two fresh PENDING rows (proof.x1 on tenant A, proof.x2 on tenant B).
    INSERT INTO platform.outbox_messages
        (tenant_id, domain_event_id, topic, payload_json, state, next_attempt_at)
    SELECT e.tenant_id, e.domain_event_id,
        CASE WHEN e.src = 'proof.a1' THEN 'proof.x1' ELSE 'proof.x2' END,
        '{"n":10}', 'PENDING', now() - make_interval(secs => 5)
    FROM (
        SELECT m.tenant_id, m.domain_event_id, m.topic AS src
        FROM platform.outbox_messages AS m
        WHERE m.topic IN ('proof.a1', 'proof.b1')
    ) AS e;

    SET LOCAL ROLE outbox_worker;
    INSERT INTO outbox_proof_claims (topic, outbox_id, tenant_id, claim_token)
    SELECT c.topic, c.id, c.tenant_id, c.claim_token
    FROM platform.outbox_claim(1, 'wA', 300) AS c;
    INSERT INTO outbox_proof_claims (topic, outbox_id, tenant_id, claim_token)
    SELECT c.topic, c.id, c.tenant_id, c.claim_token
    FROM platform.outbox_claim(1, 'wB', 300) AS c;
    SELECT outbox_id INTO first_id FROM outbox_proof_claims WHERE topic = 'proof.x1';
    SELECT outbox_id INTO second_id FROM outbox_proof_claims WHERE topic = 'proof.x2';
    IF first_id IS NULL OR second_id IS NULL OR first_id = second_id THEN
        RAISE EXCEPTION 'two workers must hold disjoint live claims, got % and %', first_id, second_id;
    END IF;
    SELECT count(*) INTO third_count FROM platform.outbox_claim(1, 'wC', 300);
    IF third_count <> 0 THEN
        RAISE EXCEPTION 'no third live row may be claimed while leases hold';
    END IF;
END $$;

-- 7) Fencing: token antigo não completa, não falha, não renova; atual funciona.
DO $$
DECLARE
    v_id uuid;
    v_token uuid;
    v_stale uuid := '00000000-0000-0000-0000-000000000000';
    v_result integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT m.id, m.claim_token INTO v_id, v_token
    FROM platform.outbox_messages AS m WHERE m.topic = 'proof.x1';
    SET LOCAL ROLE outbox_worker;

    SELECT platform.outbox_complete(v_id, v_stale) INTO v_result;
    IF v_result <> 0 THEN
        RAISE EXCEPTION 'stale complete must write 0 rows';
    END IF;
    SELECT platform.outbox_fail(v_id, v_stale, 'STALE', NULL) INTO v_result;
    IF v_result <> 0 THEN
        RAISE EXCEPTION 'stale fail must write 0 rows';
    END IF;
    SELECT platform.outbox_renew(v_id, v_stale, 300) INTO v_result;
    IF v_result <> 0 THEN
        RAISE EXCEPTION 'stale renew must write 0 rows';
    END IF;

    SELECT platform.outbox_renew(v_id, v_token, 300) INTO v_result;
    IF v_result <> 1 THEN
        RAISE EXCEPTION 'live renew with the current token must extend 1 row';
    END IF;

    RESET ROLE;
    IF NOT EXISTS (SELECT 1 FROM platform.outbox_messages AS m
        WHERE m.id = v_id AND m.state = 'PUBLISHING' AND m.claim_token = v_token) THEN
        RAISE EXCEPTION 'stale writes must not disturb the live claim';
    END IF;
END $$;

-- 8) Crash recovery: claim -> backdated lease (crash+expiry) -> reclaim ->
-- complete. Nenhuma intervenção manual na row além do relógio simulado.
DO $$
DECLARE
    v_id uuid;
    v_old_token uuid;
    v_new_token uuid;
    v_result integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT m.id, m.claim_token INTO v_id, v_old_token
    FROM platform.outbox_messages AS m WHERE m.topic = 'proof.x1';

    -- Simulate crash + lease expiry (the clock, not a state repair).
    UPDATE platform.outbox_messages AS m
    SET lease_expires_at = now() - make_interval(secs => 1)
    WHERE m.id = v_id;

    SET LOCAL ROLE outbox_worker;
    SELECT c.claim_token INTO v_new_token
    FROM platform.outbox_claim(10, 'w2', 300) AS c WHERE c.id = v_id;
    IF v_new_token IS NULL OR v_new_token = v_old_token THEN
        RAISE EXCEPTION 'reclaim must issue a fresh token for the expired row';
    END IF;

    -- The crashed worker returns: every stale write is fenced.
    SELECT platform.outbox_complete(v_id, v_old_token) INTO v_result;
    IF v_result <> 0 THEN
        RAISE EXCEPTION 'crashed worker complete must write 0 rows after reclaim';
    END IF;
    SELECT platform.outbox_fail(v_id, v_old_token, 'LATE', NULL) INTO v_result;
    IF v_result <> 0 THEN
        RAISE EXCEPTION 'crashed worker fail must write 0 rows after reclaim';
    END IF;

    -- The current holder finishes normally.
    SELECT platform.outbox_complete(v_id, v_new_token) INTO v_result;
    IF v_result <> 1 THEN
        RAISE EXCEPTION 'current token complete must publish 1 row';
    END IF;

    RESET ROLE;
    IF NOT EXISTS (SELECT 1 FROM platform.outbox_messages AS m
        WHERE m.id = v_id AND m.state = 'PUBLISHED' AND m.claim_token IS NULL) THEN
        RAISE EXCEPTION 'recovered row must end PUBLISHED with a cleared lease';
    END IF;
    IF (SELECT count(*) FROM platform.outbox_transitions AS t WHERE t.outbox_id = v_id) < 3 THEN
        RAISE EXCEPTION 'recovery must leave an audit chain (claim, reclaim, complete)';
    END IF;
END $$;

-- 9) Expiração real por relógio: lease de 1s expira e a row volta a elegível.
DO $$
DECLARE
    v_id uuid;
    v_old_token uuid;
    v_new_token uuid;
    v_result integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;

    INSERT INTO platform.outbox_messages
        (tenant_id, domain_event_id, topic, payload_json, state, next_attempt_at)
    SELECT m.tenant_id, m.domain_event_id, 'proof.rt', '{"n":11}',
        'PENDING', now() - make_interval(secs => 5)
    FROM platform.outbox_messages AS m WHERE m.topic = 'proof.b1';

    SET LOCAL ROLE outbox_worker;
    SELECT c.id, c.claim_token INTO v_id, v_old_token
    FROM platform.outbox_claim(1, 'wSlow', 1) AS c;
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'short-lease claim must return the row';
    END IF;

    PERFORM pg_sleep(2);

    SELECT c.claim_token INTO v_new_token
    FROM platform.outbox_claim(1, 'wFast', 300) AS c WHERE c.id = v_id;
    IF v_new_token IS NULL OR v_new_token = v_old_token THEN
        RAISE EXCEPTION 'expired lease must be reclaimable with a fresh token';
    END IF;
    SELECT platform.outbox_complete(v_id, v_old_token) INTO v_result;
    IF v_result <> 0 THEN
        RAISE EXCEPTION 'pre-expiry holder complete must write 0 rows';
    END IF;
    SELECT platform.outbox_complete(v_id, v_new_token) INTO v_result;
    IF v_result <> 1 THEN
        RAISE EXCEPTION 'reclaim holder complete must publish 1 row';
    END IF;
END $$;

-- 10) Fail path: FAILED com retry, retry passado é clamped, audit registra.
DO $$
DECLARE
    v_id uuid;
    v_token uuid;
    v_result integer;
    v_retry timestamptz;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT m.id, m.claim_token INTO v_id, v_token
    FROM platform.outbox_messages AS m WHERE m.topic = 'proof.b1';
    SET LOCAL ROLE outbox_worker;

    SELECT platform.outbox_fail(v_id, v_token, 'PROVIDER_TIMEOUT', NULL) INTO v_result;
    IF v_result <> 1 THEN
        RAISE EXCEPTION 'current token fail must park 1 row as FAILED';
    END IF;

    RESET ROLE;
    SELECT m.next_attempt_at INTO v_retry FROM platform.outbox_messages AS m WHERE m.id = v_id;
    IF v_retry IS NULL OR v_retry < now() OR v_retry > now() + make_interval(secs => 120) THEN
        RAISE EXCEPTION 'default retry must land ~60s in the future, got %', v_retry;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM platform.outbox_transitions AS t
        WHERE t.outbox_id = v_id AND t.to_state = 'FAILED') THEN
        RAISE EXCEPTION 'fail must append an audit transition';
    END IF;
END $$;

-- 10b) Retry floor: an explicit retry in the past or inside the 60s window is
-- raised to the floor (never a hot retry), not accepted as-is.
DO $$
DECLARE
    v_id uuid;
    v_token uuid;
    v_result integer;
    v_retry timestamptz;
    v_before timestamptz := clock_timestamp();
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    INSERT INTO platform.outbox_messages
        (tenant_id, domain_event_id, topic, payload_json, state, next_attempt_at)
    SELECT m.tenant_id, m.domain_event_id, 'proof.floor', '{"n":12}',
        'PENDING', now() - make_interval(secs => 5)
    FROM platform.outbox_messages AS m WHERE m.topic = 'proof.b1';

    SET LOCAL ROLE outbox_worker;
    SELECT c.id, c.claim_token INTO v_id, v_token
    FROM platform.outbox_claim(1, 'wFloor', 300) AS c WHERE c.topic = 'proof.floor';
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'floor fixture must be claimable';
    END IF;
    -- Request a retry "now": the floor must push it to now+60s.
    SELECT platform.outbox_fail(v_id, v_token, 'FLOOR', v_before) INTO v_result;
    IF v_result <> 1 THEN
        RAISE EXCEPTION 'floor fail must park the row';
    END IF;

    RESET ROLE;
    SELECT m.next_attempt_at INTO v_retry FROM platform.outbox_messages AS m WHERE m.id = v_id;
    IF v_retry < v_before + make_interval(secs => 59) THEN
        RAISE EXCEPTION 'retry floor must raise a past/too-soon retry to >= now+60s, got %', v_retry;
    END IF;
END $$;

-- 11) Bounds: limite, lease, worker, código e retry inválidos falham fechado.
-- Each expected rejection is captured as a FLAG, then asserted OUTSIDE the
-- protected block, so a function that accepts invalid input still fails the
-- proof (a sentinel RAISE must never be swallowed by the same handler).
DO $$
DECLARE
    v_id uuid;
    v_token uuid;
    v_rejected boolean;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT m.id, m.claim_token INTO v_id, v_token
    FROM platform.outbox_messages AS m WHERE m.topic = 'proof.a1';
    SET LOCAL ROLE outbox_worker;

    v_rejected := false;
    BEGIN
        PERFORM platform.outbox_claim(0, 'w', 300);
    EXCEPTION WHEN raise_exception THEN v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'claim limit 0 must fail'; END IF;

    v_rejected := false;
    BEGIN
        PERFORM platform.outbox_claim(101, 'w', 300);
    EXCEPTION WHEN raise_exception THEN v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'claim limit 101 must fail'; END IF;

    v_rejected := false;
    BEGIN
        PERFORM platform.outbox_claim(1, '   ', 300);
    EXCEPTION WHEN raise_exception THEN v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'blank worker must fail'; END IF;

    v_rejected := false;
    BEGIN
        PERFORM platform.outbox_claim(1, 'w', 0);
    EXCEPTION WHEN raise_exception THEN v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'lease 0 must fail'; END IF;

    v_rejected := false;
    BEGIN
        PERFORM platform.outbox_claim(1, 'w', 3601);
    EXCEPTION WHEN raise_exception THEN v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'lease 3601 must fail'; END IF;

    v_rejected := false;
    BEGIN
        PERFORM platform.outbox_fail(v_id, v_token, '  ', NULL);
    EXCEPTION WHEN raise_exception THEN v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'blank fail code must fail'; END IF;

    v_rejected := false;
    BEGIN
        PERFORM platform.outbox_fail(v_id, v_token, 'X', clock_timestamp() + make_interval(days => 8));
    EXCEPTION WHEN raise_exception THEN v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'far-future retry must fail'; END IF;

    IF platform.outbox_complete('11111111-1111-1111-1111-111111111111', gen_random_uuid()) <> 0 THEN
        RAISE EXCEPTION 'complete on an unknown id must write 0 rows';
    END IF;

    RESET ROLE;
    IF NOT EXISTS (SELECT 1 FROM platform.outbox_messages AS m
        WHERE m.id = v_id AND m.state = 'PUBLISHING' AND m.claim_token = v_token) THEN
        RAISE EXCEPTION 'rejected inputs must not disturb the live claim';
    END IF;
END $$;

-- 12) Tenant isolation do worker: contexto de tenant não vaza e o worker
-- continua sem oracle, mesmo com GUC setada (claim cross-tenant é por desenho).
DO $$
DECLARE
    v_tenant uuid;
    v_claimed integer;
    v_before text;
    v_after text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT m.tenant_id INTO v_tenant FROM platform.outbox_messages AS m WHERE m.topic = 'proof.a1';
    EXECUTE format('SET LOCAL app.tenant_id = %L', v_tenant::text);
    SET LOCAL ROLE outbox_worker;

    BEGIN
        PERFORM 1 FROM crm.customers LIMIT 1;
        RAISE EXCEPTION 'expected worker tenant read to fail even with GUC set';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    -- The functions must not touch the session GUC either way: capture the
    -- setting around the call and require it unchanged (SET LOCAL persists
    -- to transaction end by design, so "still set" is expected afterwards).
    SELECT current_setting('app.tenant_id', true) INTO v_before;
    SELECT count(*) INTO v_claimed FROM platform.outbox_claim(1, 'wTenant', 300);
    SELECT current_setting('app.tenant_id', true) INTO v_after;
    IF v_after IS DISTINCT FROM v_before THEN
        RAISE EXCEPTION 'function calls must not change the session tenant context';
    END IF;

    RESET ROLE;
    RESET app.tenant_id;
END $$;

-- 13) Owner fecha: estados terminais, leases vivas, sem PUBLISHING travada,
-- audit encadeado e terminal intocado.
DO $$
DECLARE
    stuck integer;
    audit_total integer;
    terminal_audit integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;

    SELECT count(*) INTO stuck FROM platform.outbox_messages AS m
    WHERE m.state = 'PUBLISHING'
      AND m.lease_expires_at IS NOT NULL
      AND m.lease_expires_at <= now();
    IF stuck <> 0 THEN
        RAISE EXCEPTION 'no PUBLISHING row may hold an expired lease at proof end, stuck %', stuck;
    END IF;
    IF EXISTS (SELECT 1 FROM platform.outbox_messages AS m
        WHERE m.topic LIKE 'proof.%' AND m.state = 'PUBLISHING' AND m.claim_token IS NULL) THEN
        RAISE EXCEPTION 'every live PUBLISHING row must carry its lease token';
    END IF;
    SELECT count(*) INTO audit_total FROM platform.outbox_transitions AS t
    WHERE t.outbox_id IN (SELECT m.id FROM platform.outbox_messages AS m WHERE m.topic LIKE 'proof.%');
    IF audit_total < 8 THEN
        RAISE EXCEPTION 'audit chain too short for the exercised transitions, got %', audit_total;
    END IF;
    SELECT count(*) INTO terminal_audit FROM platform.outbox_transitions AS t
    JOIN platform.outbox_messages AS m ON m.id = t.outbox_id
    WHERE m.topic = 'proof.a3';
    IF terminal_audit <> 0 THEN
        RAISE EXCEPTION 'the pre-existing terminal row must gain no audit entries';
    END IF;
END $$;

\echo 015: platform outbox worker proofs PASS: claim/fencing/renew/reclaim/crash-recovery/bounds/tenant-isolation/audit, EXECUTE-only worker, iptv_app and PUBLIC denied
ROLLBACK;
