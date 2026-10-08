-- 016 Platform outbox runtime live-interlock proofs against migration 051.
-- Proves the database authority for who may publish (LEGACY -> QUIESCING
-- -> WORKER, plus forward-fix rollback), the unfenced-activation refusal,
-- the CAS concurrency rule, crash/restart semantics, and that in-flight
-- leased work finishes across a rollback while new claims stay gated.
-- SINGLE SESSION: the CAS section proves the stale-generation refusal
-- (correct modes, old generation) plus the stale-from refusal, NOT lock
-- contention under two concurrent writers (the switch is ONE predicated
-- UPDATE on (mode, generation), so the second writer observes 0 rows by
-- construction).
-- Fixture rows, transitions and control updates ROLLBACK; the 051 objects
-- persist with the LEGACY gen-1 seed restored. Execute only on a
-- disposable database after applying every migration:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/016_platform_outbox_runtime_interlock.sql
\set ON_ERROR_STOP on
BEGIN;

-- 1) Preconditions: tables, seed, owners, grants, functions, gate, trigger.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'platform.outbox_runtime_control'::regclass) THEN
        RAISE EXCEPTION 'migration 051 not applied: platform.outbox_runtime_control is missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'platform.outbox_runtime_transitions'::regclass) THEN
        RAISE EXCEPTION 'migration 051 not applied: platform.outbox_runtime_transitions is missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM platform.outbox_runtime_control AS c
                   WHERE c.id = 1 AND c.mode = 'LEGACY' AND c.generation = 1) THEN
        RAISE EXCEPTION 'runtime control seed must be exactly (id=1, LEGACY, generation=1)';
    END IF;
    IF (SELECT pg_get_userbyid(c.relowner) FROM pg_class AS c
        WHERE c.oid = 'platform.outbox_runtime_control'::regclass) <> 'outbox_executor' THEN
        RAISE EXCEPTION 'runtime control table must be owned by outbox_executor';
    END IF;
    IF (SELECT pg_get_userbyid(c.relowner) FROM pg_class AS c
        WHERE c.oid = 'platform.outbox_runtime_transitions'::regclass) <> 'outbox_executor' THEN
        RAISE EXCEPTION 'runtime transitions table must be owned by outbox_executor';
    END IF;
    -- Zero non-owner grantees on both runtime tables (worker/app reach
    -- them ONLY through functions, never directly).
    IF EXISTS (
        SELECT 1 FROM pg_class AS c, aclexplode(c.relacl) AS a
        WHERE c.oid IN ('platform.outbox_runtime_control'::regclass,
                        'platform.outbox_runtime_transitions'::regclass)
          AND a.grantee <> c.relowner
    ) THEN
        RAISE EXCEPTION 'runtime tables must carry zero non-owner grants';
    END IF;
    IF has_table_privilege('outbox_worker', 'platform.outbox_runtime_control', 'SELECT')
        OR has_table_privilege('iptv_app', 'platform.outbox_runtime_control', 'SELECT') THEN
        RAISE EXCEPTION 'worker/app roles must hold zero table privileges on runtime control';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'outbox_runtime_transitions_append_only') THEN
        RAISE EXCEPTION 'append-only trigger missing on platform.outbox_runtime_transitions';
    END IF;

    -- mode()/set() exist, are SECURITY DEFINER, executor-owned, pinned.
    IF EXISTS (
        SELECT 1 FROM pg_proc AS p
        WHERE p.oid IN ('platform.outbox_runtime_mode()'::regprocedure,
                        'platform.outbox_runtime_set(text, text, text, integer)'::regprocedure)
          AND (p.prosecdef IS DISTINCT FROM true
               OR pg_get_userbyid(p.proowner) <> 'outbox_executor'
               OR p.proconfig IS DISTINCT FROM ARRAY['search_path=platform, pg_temp'])
    ) THEN
        RAISE EXCEPTION 'runtime functions must be SECURITY DEFINER, executor-owned, search_path pinned';
    END IF;
    -- mode() is worker/app EXECUTE-only (narrow read authority); a PUBLIC
    -- entry would read as an empty grantee (`{=X/...}`).
    IF NOT has_function_privilege('outbox_worker', 'platform.outbox_runtime_mode()', 'EXECUTE') THEN
        RAISE EXCEPTION 'outbox_worker must hold EXECUTE on outbox_runtime_mode';
    END IF;
    IF NOT has_function_privilege('iptv_app', 'platform.outbox_runtime_mode()', 'EXECUTE') THEN
        RAISE EXCEPTION 'iptv_app must hold EXECUTE on outbox_runtime_mode';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_proc AS p
        WHERE p.oid = 'platform.outbox_runtime_mode()'::regprocedure
          AND (p.proacl::text LIKE '{=X/%' OR p.proacl::text LIKE '%,=X/%')
    ) THEN
        RAISE EXCEPTION 'outbox_runtime_mode must be revoked from PUBLIC';
    END IF;
    -- set() is granted to NOBODY: only the operator (superuser bypass) may
    -- switch the mode; worker/app roles must receive permission denied.
    IF EXISTS (
        SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS a
        JOIN pg_roles AS r ON r.oid = a.grantee
        WHERE p.oid = 'platform.outbox_runtime_set(text, text, text, integer)'::regprocedure
          AND r.rolname NOT IN ('outbox_executor')
    ) THEN
        RAISE EXCEPTION 'outbox_runtime_set must name no grantee besides its owner';
    END IF;
    -- The replaced claim carries the WORKER-mode gate.
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc AS p
        WHERE p.oid = 'platform.outbox_claim(integer, text, integer)'::regprocedure
          AND p.prosrc LIKE '%runtime mode is not WORKER%'
    ) THEN
        RAISE EXCEPTION 'outbox_claim is missing the WORKER-mode gate';
    END IF;
END $$;

-- 2) LEGACY: the worker claim is refused; both roles read the authority.
DO $$
DECLARE
    v_rejected boolean;
    v_mode text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SET LOCAL ROLE outbox_worker;

    v_rejected := false;
    BEGIN
        PERFORM platform.outbox_claim(10, 'wLegacy', 300);
    EXCEPTION WHEN raise_exception THEN v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'claim in LEGACY mode must fail'; END IF;

    SELECT platform.outbox_runtime_mode() INTO v_mode;
    IF v_mode <> 'LEGACY' THEN RAISE EXCEPTION 'worker must read LEGACY from the authority'; END IF;

    RESET ROLE;
    SET LOCAL ROLE iptv_app;
    SELECT platform.outbox_runtime_mode() INTO v_mode;
    IF v_mode <> 'LEGACY' THEN RAISE EXCEPTION 'app role must read LEGACY from the authority'; END IF;

    RESET ROLE;
END $$;

-- 3) LEGACY -> QUIESCING switches the authority (gen 2, transition logged);
-- new legacy publishing stays blocked (claim still refused in QUIESCING).
DO $$
DECLARE
    v_gen integer;
    v_exp integer;
    v_rejected boolean;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;

    SELECT c.generation INTO v_exp FROM platform.outbox_runtime_control AS c WHERE c.id = 1;
    SELECT platform.outbox_runtime_set('LEGACY', 'QUIESCING', 'proof', v_exp) INTO v_gen;
    IF v_gen <> 2 THEN RAISE EXCEPTION 'first switch must land on generation 2, got %', v_gen; END IF;
    IF NOT EXISTS (SELECT 1 FROM platform.outbox_runtime_transitions AS t
                   WHERE t.from_mode = 'LEGACY' AND t.to_mode = 'QUIESCING'
                     AND t.generation = 2 AND t.actor = 'proof') THEN
        RAISE EXCEPTION 'switch must append exactly one transition row';
    END IF;

    SET LOCAL ROLE outbox_worker;
    v_rejected := false;
    BEGIN
        PERFORM platform.outbox_claim(10, 'wQuiescing', 300);
    EXCEPTION WHEN raise_exception THEN v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'claim in QUIESCING mode must fail'; END IF;
    RESET ROLE;
END $$;

-- 3b) CAS on (mode, generation): a stale p_from refuses, a stale
-- generation refuses even when the modes are correct (ABA replay), NULL
-- modes / NULL generation refuse with fixed messages, and order
-- validation refuses same-mode steps; a blank actor refuses without
-- touching the mode.
DO $$
DECLARE
    v_rejected boolean;
    v_gen_before integer;
    v_msg text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT c.generation INTO v_gen_before FROM platform.outbox_runtime_control AS c WHERE c.id = 1;

    v_rejected := false;
    BEGIN
        PERFORM platform.outbox_runtime_set('LEGACY', 'QUIESCING', 'proof-stale', v_gen_before);
    EXCEPTION WHEN raise_exception THEN v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'stale-from switch must fail (CAS)'; END IF;

    -- Stale generation: modes name an allowed step (QUIESCING -> WORKER)
    -- and the current mode matches, but the observed generation is old —
    -- the predicated UPDATE sees 0 rows and the fixed CAS message is
    -- raised (never echoing values).
    v_msg := NULL;
    BEGIN
        PERFORM platform.outbox_runtime_set('QUIESCING', 'WORKER', 'proof-stale-gen', v_gen_before - 1);
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    END;
    IF v_msg IS NULL THEN RAISE EXCEPTION 'stale-generation switch must fail (CAS)'; END IF;
    IF v_msg <> 'outbox_runtime_set: runtime mode changed concurrently (expected mode is no longer current)' THEN
        RAISE EXCEPTION 'stale-generation failure must carry the fixed CAS message';
    END IF;

    -- NULL modes fail closed with the fixed NULL message (never the
    -- native NOT NULL error, never echoing values).
    v_msg := NULL;
    BEGIN
        PERFORM platform.outbox_runtime_set(NULL, 'QUIESCING', 'proof-null', v_gen_before);
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    END;
    IF v_msg IS NULL THEN RAISE EXCEPTION 'NULL p_from switch must fail'; END IF;
    IF v_msg <> 'outbox_runtime_set: p_from and p_to must be non-null runtime modes' THEN
        RAISE EXCEPTION 'NULL p_from failure must carry the fixed NULL message';
    END IF;

    v_msg := NULL;
    BEGIN
        PERFORM platform.outbox_runtime_set('QUIESCING', NULL, 'proof-null', v_gen_before);
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    END;
    IF v_msg IS NULL THEN RAISE EXCEPTION 'NULL p_to switch must fail'; END IF;
    IF v_msg <> 'outbox_runtime_set: p_from and p_to must be non-null runtime modes' THEN
        RAISE EXCEPTION 'NULL p_to failure must carry the fixed NULL message';
    END IF;

    -- NULL generation fails closed with its own fixed message.
    v_msg := NULL;
    BEGIN
        PERFORM platform.outbox_runtime_set('QUIESCING', 'WORKER', 'proof-null-gen', NULL);
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    END;
    IF v_msg IS NULL THEN RAISE EXCEPTION 'NULL generation switch must fail'; END IF;
    IF v_msg <> 'outbox_runtime_set: p_expected_generation must be a non-null generation' THEN
        RAISE EXCEPTION 'NULL generation failure must carry the fixed generation message';
    END IF;

    v_rejected := false;
    BEGIN
        PERFORM platform.outbox_runtime_set('QUIESCING', 'QUIESCING', 'proof-same', v_gen_before);
    EXCEPTION WHEN raise_exception THEN v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'same-mode step must fail (order)'; END IF;

    v_rejected := false;
    BEGIN
        PERFORM platform.outbox_runtime_set('QUIESCING', 'WORKER', '   ', v_gen_before);
    EXCEPTION WHEN raise_exception THEN v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'blank actor must fail'; END IF;

    -- Crash-during-switch analogue: every refused set() above leaves the
    -- mode AND generation untouched (the switch is ONE predicated UPDATE,
    -- so a crash mid-statement keeps the OLD mode by construction).
    IF NOT EXISTS (SELECT 1 FROM platform.outbox_runtime_control AS c
                   WHERE c.id = 1 AND c.mode = 'QUIESCING' AND c.generation = v_gen_before) THEN
        RAISE EXCEPTION 'refused switches must leave mode and generation unchanged';
    END IF;
END $$;

-- 4) Fixture: one due PENDING row (proof.rt1). QUIESCING -> WORKER lands
-- gen 3 even with a LEASED PUBLISHING row absent; claim now succeeds.
DO $$
DECLARE
    v_gen integer;
    v_exp integer;
    v_claimed integer;
    v_tenant uuid;
    v_ev uuid;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;

    INSERT INTO control.tenants (slug, name)
    VALUES ('outbox-rt-proof-' || gen_random_uuid(), 'Outbox Runtime Proof')
    RETURNING id INTO v_tenant;
    INSERT INTO platform.domain_events
        (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, occurred_at, correlation_id, actor_type)
    VALUES (v_tenant, 'proof.event', 'proof', gen_random_uuid(), 1, now(), gen_random_uuid(), 'system')
    RETURNING id INTO v_ev;
    INSERT INTO platform.outbox_messages
        (tenant_id, domain_event_id, topic, payload_json, state, next_attempt_at)
    VALUES (v_tenant, v_ev, 'proof.rt1', '{"n":1}',
        'PENDING', now() - make_interval(secs => 10));

    SELECT c.generation INTO v_exp FROM platform.outbox_runtime_control AS c WHERE c.id = 1;
    SELECT platform.outbox_runtime_set('QUIESCING', 'WORKER', 'proof', v_exp) INTO v_gen;
    IF v_gen <> 3 THEN RAISE EXCEPTION 'activation must land on generation 3, got %', v_gen; END IF;

    SET LOCAL ROLE outbox_worker;
    SELECT count(*) INTO v_claimed FROM platform.outbox_claim(10, 'wActive', 300);
    IF v_claimed < 1 THEN RAISE EXCEPTION 'claim in WORKER mode must return the due row'; END IF;
    RESET ROLE;
END $$;

-- 5) Rollback is forward-fix: WORKER -> QUIESCING keeps the leased
-- PUBLISHING row completable (in-flight finishes), while new claims stop.
DO $$
DECLARE
    v_gen integer;
    v_exp integer;
    v_id uuid;
    v_token uuid;
    v_result integer;
    v_rejected boolean;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT m.id, m.claim_token INTO v_id, v_token
    FROM platform.outbox_messages AS m WHERE m.topic = 'proof.rt1';

    SELECT c.generation INTO v_exp FROM platform.outbox_runtime_control AS c WHERE c.id = 1;
    SELECT platform.outbox_runtime_set('WORKER', 'QUIESCING', 'proof-rollback', v_exp) INTO v_gen;
    IF v_gen <> 4 THEN RAISE EXCEPTION 'rollback step must land on generation 4, got %', v_gen; END IF;

    SET LOCAL ROLE outbox_worker;
    -- In-flight finishes across the rollback: current token still completes.
    SELECT platform.outbox_complete(v_id, v_token) INTO v_result;
    IF v_result <> 1 THEN RAISE EXCEPTION 'in-flight complete must still apply after rollback to QUIESCING'; END IF;
    -- But no NEW claim is possible outside WORKER.
    v_rejected := false;
    BEGIN
        PERFORM platform.outbox_claim(10, 'wRolledBack', 300);
    EXCEPTION WHEN raise_exception THEN v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'claim after rollback to QUIESCING must fail'; END IF;
    RESET ROLE;
END $$;

-- 6) Stranded-legacy guard: a legacy PUBLISHING row WITHOUT a lease blocks
-- activation; PUBLISHING rows WITH a lease never block (reclaim covers).
DO $$
DECLARE
    v_rejected boolean;
    v_gen integer;
    v_exp integer;
    v_legacy_id uuid;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;

    -- Legacy-style stranded row: PUBLISHING, no lease, no token (the old
    -- drainer flips state with no fencing).
    INSERT INTO platform.outbox_messages
        (tenant_id, domain_event_id, topic, payload_json, state, next_attempt_at)
    SELECT m.tenant_id, m.domain_event_id, 'proof.rt-stranded', '{"n":9}',
        'PENDING', now() - make_interval(secs => 5)
    FROM platform.outbox_messages AS m LIMIT 1
    RETURNING id INTO v_legacy_id;
    UPDATE platform.outbox_messages AS m
    SET state = 'PUBLISHING', claim_token = NULL, claimed_by = NULL, lease_expires_at = NULL
    WHERE m.id = v_legacy_id;

    v_rejected := false;
    BEGIN
        SELECT c.generation INTO v_exp FROM platform.outbox_runtime_control AS c WHERE c.id = 1;
        PERFORM platform.outbox_runtime_set('QUIESCING', 'WORKER', 'proof-blocked', v_exp);
    EXCEPTION WHEN raise_exception THEN v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'activation with unfenced PUBLISHING must fail'; END IF;
    IF (SELECT c.mode FROM platform.outbox_runtime_control AS c WHERE c.id = 1) <> 'QUIESCING' THEN
        RAISE EXCEPTION 'refused activation must leave the mode at QUIESCING';
    END IF;

    -- Forward repair (owner-side, no data invention): the stranded row is
    -- published through the normal terminal state, then activation passes.
    UPDATE platform.outbox_messages AS m
    SET state = 'PUBLISHED', published_at = now()
    WHERE m.id = v_legacy_id;
    SELECT c.generation INTO v_exp FROM platform.outbox_runtime_control AS c WHERE c.id = 1;
    SELECT platform.outbox_runtime_set('QUIESCING', 'WORKER', 'proof', v_exp) INTO v_gen;
    IF v_gen <> 5 THEN RAISE EXCEPTION 'activation after repair must land on generation 5, got %', v_gen; END IF;

    RESET ROLE;
END $$;

-- 7) Authority-DB (C-QUIESCING): the mode is read fresh from the table in a
-- new role context — no env snapshot exists to go stale across a restart.
DO $$
DECLARE
    v_mode text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SET LOCAL ROLE iptv_app;
    SELECT platform.outbox_runtime_mode() INTO v_mode;
    IF v_mode <> 'WORKER' THEN RAISE EXCEPTION 'fresh authority read must report WORKER'; END IF;
    RESET ROLE;
    RESET app.tenant_id;
END $$;

-- 8) Owner close-out: no unfenced rows remain, every proof row is terminal
-- or leased, the transition chain is append-only and ordered.
DO $$
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    IF EXISTS (SELECT 1 FROM platform.outbox_messages AS m
               WHERE m.topic LIKE 'proof.rt%' AND m.state = 'PUBLISHING'
                 AND m.lease_expires_at IS NULL) THEN
        RAISE EXCEPTION 'no proof row may end PUBLISHING without a lease';
    END IF;
    IF (SELECT count(*) FROM platform.outbox_runtime_transitions) < 4 THEN
        RAISE EXCEPTION 'transition chain too short for the exercised switches';
    END IF;
    IF EXISTS (SELECT 1 FROM platform.outbox_runtime_transitions AS t
               WHERE t.from_mode NOT IN ('LEGACY', 'QUIESCING', 'WORKER')
                  OR t.to_mode NOT IN ('LEGACY', 'QUIESCING', 'WORKER')) THEN
        RAISE EXCEPTION 'transition rows must name known modes only';
    END IF;
END $$;

\echo 016: platform outbox runtime interlock proofs PASS: LEGACY/QUIESCING/WORKER gating, CAS, unfenced refusal, in-flight-across-rollback, authority-DB reads, append-only switch log
ROLLBACK;
