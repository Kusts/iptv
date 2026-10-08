-- 024 RLS domain rollout (migration 057): support.* + knowledge.* +
-- agent.* (tenant-scoped) as iptv_app.
-- Representative sample, one table per schema: support.support_tickets,
-- knowledge.knowledge_items, agent.human_review_requests. Plus:
-- grant/policy/RLS preconditions on ALL 21 enrolled tables, allow-list
-- assertion (exactly one tenant_id-less GLOBAL table in scope —
-- agent.agent_releases with no tenant_id and no RLS by design, slice 058 —
-- plus the 058 academy globals partners.learning_content{,_versions} asserted
-- explicitly as NOT enrolled here and the 058 tenant-scoped
-- partners.learning_progress asserted explicitly as enrolled here (behavior
-- covered in 025)), outbox-role boundary assertion (050 EXECUTE-only:
-- outbox_worker/outbox_executor hold NOTHING on these tables), and owner
-- bypass. Covers: own CRUD on all 3 sampled tables, cross-tenant 0 rows,
-- tenant_id rewrite rejected (WITH CHECK => 42501), cross-tenant INSERT
-- rejected, no-context fail-closed (SELECT 0 rows + INSERT rejected). The
-- remaining 18 enrolled tables are covered by the preconditions (RLS +
-- tenant_isolation + DML) plus the allow-list sweep — declared coverage, not
-- row-exhaustive.
-- Fixture rows ROLLBACK; role/policy/grants persist.
-- Execute: cat file | docker exec -i iptv-pg-test psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
-- (Regression: db/tests/017, 022, 023.)
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 057 preconditions on all 21 enforced tables.
DO $$
DECLARE
    tables text[] := ARRAY[
        'support.incidents',
        'support.problems',
        'support.support_tickets',
        'support.ticket_incident_links',
        'support.ticket_problem_links',
        'support.solution_attempts',
        'support.technical_access_grants',
        'knowledge.knowledge_sources',
        'knowledge.knowledge_items',
        'knowledge.knowledge_versions',
        'knowledge.knowledge_source_links',
        'knowledge.solutions',
        'knowledge.solution_outcomes',
        'knowledge.knowledge_corrections',
        'knowledge.knowledge_gaps',
        'knowledge.knowledge_research_candidates',
        'agent.human_review_requests',
        'agent.human_review_actions',
        'agent.agent_runs',
        'agent.agent_tasks',
        'agent.copilot_review_consumptions'
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
    RAISE NOTICE 'rollout preconditions OK: iptv_app NOBYPASSRLS, RLS + tenant_isolation + DML grants on 21 tables';
END $$;

-- 2) Allow-list assertion: every tenant_id-bearing table in the 3-schema
-- scope must carry the enrolled tenant template (zero unenrolled — the full
-- 057 set is enrolled here); every tenant_id-less table in scope must be
-- exactly the ONE documented global (agent.agent_releases -> slice 058).
-- The 058 academy globals (partners.learning_content{,_versions}, no
-- tenant_id) are asserted explicitly as NOT enrolled here, and the 058
-- tenant-scoped partners.learning_progress is asserted explicitly as
-- enrolled here (behavior covered in 025), so a silent early enrollment
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
    WHERE pt.schemaname IN ('support', 'knowledge', 'agent')
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

    SELECT count(*), coalesce(string_agg(pt.schemaname || '.' || pt.tablename, ', ' ORDER BY 1), '')
      INTO n_global, global_list
    FROM pg_tables pt
    WHERE pt.schemaname IN ('support', 'knowledge', 'agent')
      AND NOT EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
          WHERE n.nspname = pt.schemaname AND c.relname = pt.tablename AND c.relkind = 'r'
      );
    IF n_global <> 1 OR global_list <> 'agent.agent_releases' THEN
        RAISE EXCEPTION 'global-table allow-list violated: expected exactly agent.agent_releases, saw % (%)', n_global, global_list;
    END IF;

    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'agent.agent_releases'::regclass) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'agent.agent_releases (GLOBAL, slice 058) must NOT be RLS-enrolled here';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'partners.learning_content'::regclass) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'partners.learning_content (GLOBAL academy, slice 058) must NOT be RLS-enrolled here';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'partners.learning_content_versions'::regclass) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'partners.learning_content_versions (GLOBAL academy, slice 058) must NOT be RLS-enrolled here';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'partners.learning_progress'::regclass) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'partners.learning_progress (tenant-scoped academy, slice 058) must be RLS-enrolled here (behavior covered in 025)';
    END IF;
    RAISE NOTICE 'allow-list OK: 21 enrolled; only agent.agent_releases (global) outside the tenant template; 058 academy globals unenrolled, learning_progress enrolled';
END $$;

-- 3) Outbox-role boundary (migration 050 EXECUTE-only): neither the worker
-- identity nor the executor may hold ANY direct privilege on the 21 tables
-- (050 grants live on platform.* only; an injected GRANT here would silently
-- widen the worker past its lifecycle functions).
DO $$
DECLARE
    tables text[] := ARRAY[
        'support.incidents',
        'support.problems',
        'support.support_tickets',
        'support.ticket_incident_links',
        'support.ticket_problem_links',
        'support.solution_attempts',
        'support.technical_access_grants',
        'knowledge.knowledge_sources',
        'knowledge.knowledge_items',
        'knowledge.knowledge_versions',
        'knowledge.knowledge_source_links',
        'knowledge.solutions',
        'knowledge.solution_outcomes',
        'knowledge.knowledge_corrections',
        'knowledge.knowledge_gaps',
        'knowledge.knowledge_research_candidates',
        'agent.human_review_requests',
        'agent.human_review_actions',
        'agent.agent_runs',
        'agent.agent_tasks',
        'agent.copilot_review_consumptions'
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
    RAISE NOTICE 'outbox boundary OK: worker/executor hold nothing on operational tables';
END $$;

-- 4) Fixture: two tenants with persons, users+memberships, one full chain
-- each (ticket -> incident/problem links, attempt, technical grant;
-- knowledge source/item/version/link/solution/outcome/correction/gap/
-- candidate; human review request/action/run/task/consumption), as owner.
CREATE TEMP TABLE operational_ska_rollout_ids (
    ta uuid, tb uuid, pa uuid, pb uuid,
    ua uuid, ub uuid,
    tka uuid, tkb uuid,
    ita uuid, itb uuid,
    rva uuid, rvb uuid,
    runa uuid, runb uuid
);

DO $$
DECLARE
    ta uuid; tb uuid; pa uuid; pb uuid;
    ua uuid; ub uuid;
    tka uuid; tkb uuid;
    ita uuid; itb uuid;
    va uuid; vb uuid;
    sola uuid; solb uuid;
    ga uuid; gb uuid;
    rva uuid; rvb uuid;
    runa uuid; runb uuid;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-ska-a-' || gen_random_uuid(), 'RLS Operational SKA A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-ska-b-' || gen_random_uuid(), 'RLS Operational SKA B') RETURNING id INTO tb;
    INSERT INTO identity.persons (tenant_id) VALUES (ta) RETURNING id INTO pa;
    INSERT INTO identity.persons (tenant_id) VALUES (tb) RETURNING id INTO pb;
    INSERT INTO control.users (auth_subject) VALUES ('ska-a-' || gen_random_uuid()) RETURNING id INTO ua;
    INSERT INTO control.users (auth_subject) VALUES ('ska-b-' || gen_random_uuid()) RETURNING id INTO ub;
    INSERT INTO control.tenant_memberships (tenant_id, user_id, role_key)
    VALUES (ta, ua, 'tenant_admin'), (tb, ub, 'tenant_admin');

    -- Support chain per tenant.
    INSERT INTO support.support_tickets (tenant_id, person_id, summary)
    VALUES (ta, pa, 'rollout fixture ticket a') RETURNING id INTO tka;
    INSERT INTO support.support_tickets (tenant_id, person_id, summary)
    VALUES (tb, pb, 'rollout fixture ticket b') RETURNING id INTO tkb;
    INSERT INTO support.incidents (tenant_id, title) VALUES (ta, 'rollout incident a');
    INSERT INTO support.incidents (tenant_id, title) VALUES (tb, 'rollout incident b');
    INSERT INTO support.problems (tenant_id, title) VALUES (ta, 'rollout problem a');
    INSERT INTO support.problems (tenant_id, title) VALUES (tb, 'rollout problem b');
    INSERT INTO support.ticket_incident_links (tenant_id, support_ticket_id, incident_id, linked_by_type)
    SELECT ta, tka, id, 'system' FROM support.incidents WHERE tenant_id = ta;
    INSERT INTO support.ticket_incident_links (tenant_id, support_ticket_id, incident_id, linked_by_type)
    SELECT tb, tkb, id, 'system' FROM support.incidents WHERE tenant_id = tb;
    INSERT INTO support.ticket_problem_links (tenant_id, support_ticket_id, problem_id, linked_by_type)
    SELECT ta, tka, id, 'system' FROM support.problems WHERE tenant_id = ta;
    INSERT INTO support.ticket_problem_links (tenant_id, support_ticket_id, problem_id, linked_by_type)
    SELECT tb, tkb, id, 'system' FROM support.problems WHERE tenant_id = tb;
    INSERT INTO support.solution_attempts (tenant_id, support_ticket_id, procedure_key, attempt_no, actor_type)
    VALUES (ta, tka, 'rollout-proc-a', 1, 'system'), (tb, tkb, 'rollout-proc-b', 1, 'system');
    INSERT INTO support.technical_access_grants (tenant_id, person_id, support_ticket_id, reason, expires_at)
    VALUES (ta, pa, tka, 'rollout fixture a', now() + interval '1 hour'),
           (tb, pb, tkb, 'rollout fixture b', now() + interval '1 hour');

    -- Knowledge chain per tenant.
    INSERT INTO knowledge.knowledge_sources (tenant_id, source_type)
    VALUES (ta, 'RUNBOOK'), (tb, 'RUNBOOK');
    INSERT INTO knowledge.knowledge_items (tenant_id, knowledge_type)
    VALUES (ta, 'FAQ') RETURNING id INTO ita;
    INSERT INTO knowledge.knowledge_items (tenant_id, knowledge_type)
    VALUES (tb, 'FAQ') RETURNING id INTO itb;
    INSERT INTO knowledge.knowledge_versions (tenant_id, knowledge_item_id, version_no, content_text)
    VALUES (ta, ita, 1, 'rollout content a') RETURNING id INTO va;
    INSERT INTO knowledge.knowledge_versions (tenant_id, knowledge_item_id, version_no, content_text)
    VALUES (tb, itb, 1, 'rollout content b') RETURNING id INTO vb;
    UPDATE knowledge.knowledge_items SET current_version_id = va WHERE id = ita;
    UPDATE knowledge.knowledge_items SET current_version_id = vb WHERE id = itb;
    INSERT INTO knowledge.knowledge_source_links (tenant_id, knowledge_item_id, knowledge_source_id)
    SELECT ta, ita, id FROM knowledge.knowledge_sources WHERE tenant_id = ta;
    INSERT INTO knowledge.knowledge_source_links (tenant_id, knowledge_item_id, knowledge_source_id)
    SELECT tb, itb, id FROM knowledge.knowledge_sources WHERE tenant_id = tb;
    INSERT INTO knowledge.solutions (tenant_id, knowledge_item_id, procedure_json)
    VALUES (ta, ita, '{}') RETURNING id INTO sola;
    INSERT INTO knowledge.solutions (tenant_id, knowledge_item_id, procedure_json)
    VALUES (tb, itb, '{}') RETURNING id INTO solb;
    INSERT INTO knowledge.solution_outcomes (tenant_id, solution_id, context_fingerprint, outcome)
    VALUES (ta, sola, 'rollout-fp-a', 'SUCCEEDED'), (tb, solb, 'rollout-fp-b', 'SUCCEEDED');
    INSERT INTO knowledge.knowledge_corrections (tenant_id, knowledge_item_id, proposed_text)
    VALUES (ta, ita, 'rollout correction a'), (tb, itb, 'rollout correction b');
    INSERT INTO knowledge.knowledge_gaps (tenant_id, question)
    VALUES (ta, 'rollout gap a?') RETURNING id INTO ga;
    INSERT INTO knowledge.knowledge_gaps (tenant_id, question)
    VALUES (tb, 'rollout gap b?') RETURNING id INTO gb;
    INSERT INTO knowledge.knowledge_research_candidates (tenant_id, knowledge_gap_id, knowledge_item_id)
    VALUES (ta, ga, ita), (tb, gb, itb);

    -- Agent chain per tenant.
    INSERT INTO agent.human_review_requests
        (tenant_id, review_mode, reason, risk_class, resource_type, resource_id, requested_by_type, summary)
    VALUES (ta, 'REVIEW', 'OTHER', 'R1', 'ticket', tka, 'system', 'rollout review a')
    RETURNING id INTO rva;
    INSERT INTO agent.human_review_requests
        (tenant_id, review_mode, reason, risk_class, resource_type, resource_id, requested_by_type, summary)
    VALUES (tb, 'REVIEW', 'OTHER', 'R1', 'ticket', tkb, 'system', 'rollout review b')
    RETURNING id INTO rvb;
    INSERT INTO agent.human_review_actions (tenant_id, human_review_request_id, action_type, actor_user_id)
    VALUES (ta, rva, 'NOTE', ua), (tb, rvb, 'NOTE', ub);
    INSERT INTO agent.agent_runs (tenant_id, release_key, release_version, mode, model)
    VALUES (ta, 'customer-agent-v1', 1, 'SHADOW', 'echo-1') RETURNING id INTO runa;
    INSERT INTO agent.agent_runs (tenant_id, release_key, release_version, mode, model)
    VALUES (tb, 'customer-agent-v1', 1, 'SHADOW', 'echo-1') RETURNING id INTO runb;
    INSERT INTO agent.agent_tasks (tenant_id, run_id, kind)
    VALUES (ta, runa, 'specialist_tool'), (tb, runb, 'specialist_tool');
    INSERT INTO agent.copilot_review_consumptions
        (tenant_id, human_review_request_id, command, command_hash, consumed_by_actor_id)
    VALUES (ta, rva, 'crm.lookup', 'hash-a', 'actor-a'),
           (tb, rvb, 'crm.lookup', 'hash-b', 'actor-b');

    INSERT INTO operational_ska_rollout_ids
    VALUES (ta, tb, pa, pb, ua, ub, tka, tkb, ita, itb, rva, rvb, runa, runb);
    RAISE NOTICE 'operational SKA fixture ready: tenants % / %', ta, tb;
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
        'support.support_tickets',
        'knowledge.knowledge_items',
        'agent.human_review_requests'
    ];
    t text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM operational_ska_rollout_ids s LIMIT 1;
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
    SELECT s.ta, s.tb INTO ta, tb FROM operational_ska_rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM support.support_tickets;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'support.support_tickets: tenant B must see exactly 1 row, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM support.support_tickets WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'support.support_tickets: cross-tenant read must return 0 rows, saw %', n_other;
    END IF;
    SELECT count(*) INTO n_all FROM agent.human_review_requests;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'agent.human_review_requests: tenant B must see exactly 1 row, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM agent.human_review_requests WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'agent.human_review_requests: cross-tenant read must return 0 rows, saw %', n_other;
    END IF;
    RAISE NOTICE 'tenant B isolation OK: 1 own ticket + 1 own review, 0 cross-tenant rows';
END $$;

-- 7) Write path as tenant A: own INSERT/UPDATE/DELETE on every sampled
-- table; cross-tenant UPDATE touches 0 rows; tenant_id rewrite and
-- cross-tenant INSERT are rejected by WITH CHECK (42501).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    pa uuid;
    tka uuid;
    tkb uuid;
    itb uuid;
    scratch uuid;
    affected integer;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.pa, s.tka, s.tkb, s.itb
      INTO ta, tb, pa, tka, tkb, itb
      FROM operational_ska_rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;

    -- support.support_tickets scratch lifecycle (childless: no links,
    -- attempts or grants reference it).
    INSERT INTO support.support_tickets (tenant_id, person_id, summary)
    VALUES (ta, pa, 'rollout scratch ticket') RETURNING id INTO scratch;
    SELECT count(*) INTO n FROM support.support_tickets WHERE id = scratch;
    IF n <> 1 THEN
        RAISE EXCEPTION 'own ticket INSERT must be visible, saw % rows', n;
    END IF;
    UPDATE support.support_tickets SET summary = 'rollout scratch ticket 2' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own ticket UPDATE must affect 1 row, affected %', affected;
    END IF;
    UPDATE support.support_tickets SET summary = 'cross write' WHERE id = tkb;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'cross-tenant ticket UPDATE must touch 0 rows, touched %', affected;
    END IF;
    BEGIN
        UPDATE support.support_tickets SET tenant_id = tb WHERE id = scratch;
        RAISE EXCEPTION 'expected tenant_id rewrite to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO support.support_tickets (tenant_id, person_id, summary)
        VALUES (tb, pa, 'cross-tenant ticket');
        RAISE EXCEPTION 'expected cross-tenant ticket INSERT to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    DELETE FROM support.support_tickets WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch ticket DELETE must affect 1 row, affected %', affected;
    END IF;

    -- knowledge.knowledge_items scratch lifecycle (childless: no versions,
    -- links, solutions, corrections or candidates reference it).
    INSERT INTO knowledge.knowledge_items (tenant_id, knowledge_type)
    VALUES (ta, 'FAQ') RETURNING id INTO scratch;
    UPDATE knowledge.knowledge_items SET status = 'CANDIDATE' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own item UPDATE must affect 1 row, affected %', affected;
    END IF;
    UPDATE knowledge.knowledge_items SET status = 'CANDIDATE' WHERE id = itb;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'cross-tenant item UPDATE must touch 0 rows, touched %', affected;
    END IF;
    BEGIN
        UPDATE knowledge.knowledge_items SET tenant_id = tb WHERE id = scratch;
        RAISE EXCEPTION 'expected tenant_id rewrite to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    DELETE FROM knowledge.knowledge_items WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch item DELETE must affect 1 row, affected %', affected;
    END IF;

    -- agent.human_review_requests scratch lifecycle (childless: no actions,
    -- runs or consumptions reference it).
    INSERT INTO agent.human_review_requests
        (tenant_id, review_mode, reason, risk_class, resource_type, resource_id, requested_by_type, summary)
    VALUES (ta, 'REVIEW', 'OTHER', 'R1', 'ticket', tka, 'system', 'rollout scratch review')
    RETURNING id INTO scratch;
    UPDATE agent.human_review_requests SET priority = 'HIGH' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own review UPDATE must affect 1 row, affected %', affected;
    END IF;
    DELETE FROM agent.human_review_requests WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch review DELETE must affect 1 row, affected %', affected;
    END IF;

    RAISE NOTICE 'write path OK: own CRUD on all 3 sampled tables, cross-tenant UPDATE filtered, rewrite + cross-tenant INSERT rejected (42501)';
END $$;

-- 8) Fail-closed: app role with NO tenant context sees nothing and cannot insert.
DO $$
DECLARE
    ta uuid;
    pa uuid;
    tka uuid;
    ita uuid;
    n integer;
    sampled text[] := ARRAY[
        'support.support_tickets',
        'knowledge.knowledge_items',
        'agent.human_review_requests'
    ];
    t text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.pa, s.tka, s.ita INTO ta, pa, tka, ita FROM operational_ska_rollout_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    FOREACH t IN ARRAY sampled LOOP
        EXECUTE format('SELECT count(*) FROM %s', t) INTO n;
        IF n <> 0 THEN
            RAISE EXCEPTION '%: app role without tenant context must see 0 rows, saw %', t, n;
        END IF;
    END LOOP;
    BEGIN
        INSERT INTO support.support_tickets (tenant_id, person_id, summary)
        VALUES (ta, pa, 'no-context ticket');
        RAISE EXCEPTION 'expected no-context ticket INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO knowledge.knowledge_items (tenant_id, knowledge_type)
        VALUES (ta, 'FAQ');
        RAISE EXCEPTION 'expected no-context item INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO agent.human_review_requests
            (tenant_id, review_mode, reason, risk_class, resource_type, resource_id, requested_by_type, summary)
        VALUES (ta, 'REVIEW', 'OTHER', 'R1', 'ticket', tka, 'system', 'no-context review');
        RAISE EXCEPTION 'expected no-context review INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'fail-closed OK: no tenant context => 0 rows + INSERTs rejected';
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
    SELECT s.ta, s.tb INTO ta, tb FROM operational_ska_rollout_ids s LIMIT 1;
    SELECT count(*) INTO n FROM support.support_tickets WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout tickets, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM knowledge.knowledge_items WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout items, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM agent.human_review_requests WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout reviews, saw %', n;
    END IF;
    RAISE NOTICE 'owner bypass OK: superuser sees all tenants (BYPASSRLS)';
END $$;

ROLLBACK;
