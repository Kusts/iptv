-- 030 Platform message transcripts proof (migration 063, TRANSCRICAO-FIX-063-20261021).
-- RLS `tenant_isolation` + SELECT/INSERT grants on
-- `platform.message_transcripts` (append-only event log: no UPDATE/DELETE
-- grants by design, plus the `message_transcripts_append_only` trigger
-- rejecting mutations for EVERY role including the owner), outbox-role
-- boundary on the new table (050 EXECUTE-only), tenant A/B isolation,
-- partial-unique anti-double-claim (at most one CLAIMED row per
-- (tenant, message); outcome history unbounded), no-context fail-closed,
-- owner bypass. Fixture rows ROLLBACK; role/policy/grants persist.
-- Execute: cat file | docker exec -i iptv-postgres-1 psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 063 preconditions on the new table.
DO $$
BEGIN
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'iptv_app') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'app role iptv_app must exist with NOBYPASSRLS';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'platform.message_transcripts'::regclass) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'RLS is not enabled on platform.message_transcripts';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'platform'
          AND tablename = 'message_transcripts'
          AND policyname = 'tenant_isolation'
    ) THEN
        RAISE EXCEPTION 'tenant_isolation policy missing on platform.message_transcripts';
    END IF;
    IF has_table_privilege('iptv_app', 'platform.message_transcripts', 'SELECT') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'platform.message_transcripts', 'INSERT') IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'app role lacks SELECT+INSERT grants on platform.message_transcripts';
    END IF;
    -- Append-only event log by design: no UPDATE/DELETE grants.
    IF has_table_privilege('iptv_app', 'platform.message_transcripts', 'UPDATE') IS DISTINCT FROM false
        OR has_table_privilege('iptv_app', 'platform.message_transcripts', 'DELETE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'app role must NOT hold UPDATE/DELETE on platform.message_transcripts';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'platform'
          AND tablename = 'message_transcripts'
          AND indexname = 'message_transcripts_single_claim_idx'
    ) THEN
        RAISE EXCEPTION 'message_transcripts_single_claim_idx missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'message_transcripts_append_only'
          AND tgrelid = 'platform.message_transcripts'::regclass
    ) THEN
        RAISE EXCEPTION 'message_transcripts_append_only trigger missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'message_transcripts_message_fk'
        AND conrelid = 'platform.message_transcripts'::regclass
    ) THEN
        RAISE EXCEPTION 'message_transcripts_message_fk missing';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_class AS c, aclexplode(c.relacl) AS a
        WHERE c.oid = 'platform.message_transcripts'::regclass
        AND a.grantee = 0
    ) THEN
        RAISE EXCEPTION 'platform.message_transcripts is still granted to PUBLIC';
    END IF;
    RAISE NOTICE 'preconditions OK: iptv_app NOBYPASSRLS, RLS + tenant_isolation + SELECT/INSERT only + single-claim index + append-only trigger + no PUBLIC';
END $$;

-- 2) Outbox-role boundary (migration 050 EXECUTE-only): neither the worker
-- identity nor the executor may hold ANY direct privilege on the new table.
DO $$
BEGIN
    IF has_table_privilege('outbox_worker', 'platform.message_transcripts', 'SELECT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_worker', 'platform.message_transcripts', 'INSERT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_worker', 'platform.message_transcripts', 'UPDATE') IS DISTINCT FROM false
        OR has_table_privilege('outbox_worker', 'platform.message_transcripts', 'DELETE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_worker must hold no privilege on platform.message_transcripts (050 EXECUTE-only boundary)';
    END IF;
    IF has_table_privilege('outbox_executor', 'platform.message_transcripts', 'SELECT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_executor', 'platform.message_transcripts', 'INSERT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_executor', 'platform.message_transcripts', 'UPDATE') IS DISTINCT FROM false
        OR has_table_privilege('outbox_executor', 'platform.message_transcripts', 'DELETE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_executor must hold no privilege on platform.message_transcripts (050 EXECUTE-only boundary)';
    END IF;
    RAISE NOTICE 'outbox boundary OK: worker/executor hold nothing on the message transcripts table';
END $$;

-- 3) Fixture: two tenants, each with person + conversation + PENDING AUDIO
-- message (owner inserts), plus transcript history rows.
CREATE TEMP TABLE transcript_proof_ids (ta uuid, tb uuid, ma uuid, mb uuid);

DO $$
DECLARE
    ta uuid; tb uuid; pa uuid; pb uuid; ca uuid; cb uuid; ma uuid; mb uuid;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('tr-proof-a-' || gen_random_uuid(), 'Transcript Proof A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('tr-proof-b-' || gen_random_uuid(), 'Transcript Proof B') RETURNING id INTO tb;
    INSERT INTO identity.persons (tenant_id, canonical_name)
    VALUES (ta, 'Proof A') RETURNING id INTO pa;
    INSERT INTO identity.persons (tenant_id, canonical_name)
    VALUES (tb, 'Proof B') RETURNING id INTO pb;
    INSERT INTO communication.conversations (tenant_id, person_id, channel, external_thread_id, status, control_mode)
    VALUES (ta, pa, 'WHATSAPP', 'proof-a@c.us', 'OPEN', 'AI_CONTROL') RETURNING id INTO ca;
    INSERT INTO communication.conversations (tenant_id, person_id, channel, external_thread_id, status, control_mode)
    VALUES (tb, pb, 'WHATSAPP', 'proof-b@c.us', 'OPEN', 'AI_CONTROL') RETURNING id INTO cb;
    INSERT INTO communication.messages
        (tenant_id, conversation_id, person_id, direction, channel, sender_type,
         external_message_id, content_type, body_text, attachment_ref, metadata_json, occurred_at, received_at)
    VALUES (ta, ca, pa, 'INBOUND', 'WHATSAPP', 'PERSON',
            'tr-proof-a-msg', 'AUDIO', NULL, 'in-proof-a',
            '{"provider":"waha","transcription":{"status":"PENDING_FOLLOW_UP","engine":null,"transcriptRef":null}}',
            now(), now())
    RETURNING id INTO ma;
    INSERT INTO communication.messages
        (tenant_id, conversation_id, person_id, direction, channel, sender_type,
         external_message_id, content_type, body_text, attachment_ref, metadata_json, occurred_at, received_at)
    VALUES (tb, cb, pb, 'INBOUND', 'WHATSAPP', 'PERSON',
            'tr-proof-b-msg', 'AUDIO', NULL, 'in-proof-b',
            '{"provider":"waha","transcription":{"status":"PENDING_FOLLOW_UP","engine":null,"transcriptRef":null}}',
            now(), now())
    RETURNING id INTO mb;
    INSERT INTO platform.message_transcripts (tenant_id, message_id, status, attempt, error)
    VALUES (ta, ma, 'CLAIMED', 1, NULL),
           (ta, ma, 'FAILED', 1, 'proof failure');
    INSERT INTO platform.message_transcripts (tenant_id, message_id, status, attempt, engine, model, transcript)
    VALUES (tb, mb, 'CLAIMED', 1, NULL, NULL, NULL),
           (tb, mb, 'TRANSCRIBED', 1, 'groq', 'whisper-large-v3-turbo', 'bom dia');
    INSERT INTO transcript_proof_ids VALUES (ta, tb, ma, mb);
    RAISE NOTICE 'transcript fixture ready: tenants % / %, messages % / %', ta, tb, ma, mb;
END $$;

-- 4) Tenant A context sees ONLY tenant A transcript rows.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM transcript_proof_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM platform.message_transcripts;
    IF n_all <> 2 THEN
        RAISE EXCEPTION 'tenant A app role must see exactly 2 transcript rows, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM platform.message_transcripts WHERE tenant_id = tb;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'cross-tenant transcript read must return 0 rows, saw %', n_other;
    END IF;
    RAISE NOTICE 'tenant A isolation OK: 2 own transcript rows, 0 cross-tenant rows';
END $$;

-- 5) Tenant B context sees ONLY tenant B transcript rows (incl. TRANSCRIBED).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
    n_done integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM transcript_proof_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM platform.message_transcripts;
    IF n_all <> 2 THEN
        RAISE EXCEPTION 'tenant B app role must see exactly 2 transcript rows, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM platform.message_transcripts WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'cross-tenant transcript read must return 0 rows, saw %', n_other;
    END IF;
    SELECT count(*) INTO n_done FROM platform.message_transcripts WHERE status = 'TRANSCRIBED';
    IF n_done <> 1 THEN
        RAISE EXCEPTION 'tenant B must see its TRANSCRIBED row, saw %', n_done;
    END IF;
    RAISE NOTICE 'tenant B isolation OK: 2 own transcript rows, 0 cross-tenant rows';
END $$;

-- 6) Anti-double-claim: a second CLAIMED row for the same
-- (tenant, message, attempt) cycle is rejected by the partial unique index;
-- the NEXT cycle is unaffected (a retry is never fenced by its own history);
-- outcome history (FAILED / TRANSCRIBED) stays unbounded and other messages
-- are unaffected.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    ma uuid;
    mb uuid;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.ma, s.mb INTO ta, tb, ma, mb FROM transcript_proof_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;
    -- Tenant A message currently ends in FAILED (no live CLAIMED): a fresh
    -- CLAIMED lands...
    INSERT INTO platform.message_transcripts (tenant_id, message_id, status, attempt)
    VALUES (ta, ma, 'CLAIMED', 2);
    -- ...but a second concurrent CLAIMED for the SAME cycle is refused.
    BEGIN
        INSERT INTO platform.message_transcripts (tenant_id, message_id, status, attempt)
        VALUES (ta, ma, 'CLAIMED', 2);
        RAISE EXCEPTION 'expected single-claim unique violation for duplicate CLAIMED cycle';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    -- The next cycle is never fenced by history: CLAIMED(3) lands, then its
    -- outcome history stays unbounded.
    INSERT INTO platform.message_transcripts (tenant_id, message_id, status, attempt)
    VALUES (ta, ma, 'CLAIMED', 3);
    -- Outcome history stays unbounded: FAILED rows never conflict.
    INSERT INTO platform.message_transcripts (tenant_id, message_id, status, attempt, error)
    VALUES (ta, ma, 'FAILED', 2, 'second failure');
    INSERT INTO platform.message_transcripts (tenant_id, message_id, status, attempt, error)
    VALUES (ta, ma, 'FAILED', 3, 'third failure');
    RESET ROLE;
    RESET app.tenant_id;
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    SET LOCAL ROLE iptv_app;
    -- Tenant B message shows the other side: TRANSCRIBED history coexists
    -- with further FAILED rows (no fence on outcomes, only on live races).
    INSERT INTO platform.message_transcripts (tenant_id, message_id, status, attempt, error)
    VALUES (tb, mb, 'FAILED', 2, 'late failure after success');
    RAISE NOTICE 'claim fence OK: duplicate CLAIMED cycle refused, next cycle + outcome history unbounded';
END $$;

-- 7) Write path as tenant A: own INSERT lands and is visible; cross-tenant
-- INSERT rejected (WITH CHECK => 42501); UPDATE/DELETE refused (no grant).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    ma uuid;
    scratch uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.ma INTO ta, tb, ma FROM transcript_proof_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;

    INSERT INTO platform.message_transcripts (tenant_id, message_id, status, attempt, error)
    VALUES (ta, ma, 'FAILED', 4, 'scratch failure')
    RETURNING id INTO scratch;
    SELECT count(*) INTO n FROM platform.message_transcripts WHERE id = scratch;
    IF n <> 1 THEN
        RAISE EXCEPTION 'own transcript INSERT must be visible, saw % rows', n;
    END IF;
    BEGIN
        INSERT INTO platform.message_transcripts (tenant_id, message_id, status, attempt)
        VALUES (tb, ma, 'CLAIMED', 9);
        RAISE EXCEPTION 'expected cross-tenant transcript INSERT to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        UPDATE platform.message_transcripts SET error = 'renamed' WHERE id = scratch;
        RAISE EXCEPTION 'expected transcript UPDATE to fail (no grant)';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        DELETE FROM platform.message_transcripts WHERE id = scratch;
        RAISE EXCEPTION 'expected transcript DELETE to fail (no grant)';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'write path OK: own INSERT lands, cross-tenant INSERT rejected (42501), UPDATE/DELETE refused (no grant)';
END $$;

-- 8) Append-only trigger: even the OWNER (all grants, RLS bypass) cannot
-- UPDATE or DELETE transcript rows. The guard matches the trigger's message
-- (`%is append-only%`) so a DIFFERENT failure (wrong table, dropped trigger,
-- mistyped predicate) re-raises loudly instead of passing as a refusal.
DO $$
DECLARE
    scratch uuid;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT id INTO scratch FROM platform.message_transcripts LIMIT 1;
    BEGIN
        UPDATE platform.message_transcripts SET error = 'owner rewrite' WHERE id = scratch;
        RAISE EXCEPTION 'expected owner transcript UPDATE to fail (append-only trigger)';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE '%is append-only%' THEN RAISE; END IF;
    END;
    BEGIN
        DELETE FROM platform.message_transcripts WHERE id = scratch;
        RAISE EXCEPTION 'expected owner transcript DELETE to fail (append-only trigger)';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE '%is append-only%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'trigger OK: owner UPDATE/DELETE rejected (message_transcripts is append-only)';
END $$;

-- 8b) Anti-false-positive control: the SAME guarded shape against a TEMP
-- table WITHOUT the trigger MUST let the mutation through. This proves 8a's
-- refusals come from the trigger itself — not from grants, RLS, or a broken
-- guard that swallows every error. If the trigger is ever dropped, 8a fails
-- (no refusal); if this control ever reports a refusal, the guard is broken.
DO $$
DECLARE
    scratch uuid;
    seen text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    CREATE TEMP TABLE no_trigger_control (id uuid PRIMARY KEY, val text NOT NULL);
    INSERT INTO no_trigger_control VALUES (gen_random_uuid(), 'before') RETURNING id INTO scratch;
    BEGIN
        UPDATE no_trigger_control SET val = 'after' WHERE id = scratch;
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE '%is append-only%' THEN RAISE; END IF;
        RAISE EXCEPTION 'false-positive control broken: untriggered UPDATE was refused';
    END;
    SELECT val INTO seen FROM no_trigger_control WHERE id = scratch;
    IF seen IS DISTINCT FROM 'after' THEN
        RAISE EXCEPTION 'false-positive control broken: untriggered UPDATE did not land';
    END IF;
    RAISE NOTICE 'anti-false-positive OK: untriggered UPDATE lands, so section 8 refusals come from the trigger';
END $$;

-- 9) Fail-closed: app role with NO tenant context sees nothing and cannot insert.
DO $$
DECLARE
    ta uuid;
    ma uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.ma INTO ta, ma FROM transcript_proof_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM platform.message_transcripts;
    IF n <> 0 THEN
        RAISE EXCEPTION 'app role without tenant context must see 0 transcript rows, saw %', n;
    END IF;
    BEGIN
        INSERT INTO platform.message_transcripts (tenant_id, message_id, status, attempt)
        VALUES (ta, ma, 'CLAIMED', 9);
        RAISE EXCEPTION 'expected no-context transcript INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'fail-closed OK: no tenant context => 0 rows + INSERT rejected';
END $$;

-- 10) Owner bypasses RLS: sees BOTH tenants regardless of context.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM transcript_proof_ids s LIMIT 1;
    SELECT count(*) INTO n FROM platform.message_transcripts WHERE tenant_id IN (ta, tb);
    IF n < 4 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see both tenants transcript rows, saw %', n;
    END IF;
    RAISE NOTICE 'owner bypass OK: superuser sees all tenants (BYPASSRLS)';
END $$;

ROLLBACK;
