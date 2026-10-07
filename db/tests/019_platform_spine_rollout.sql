-- 019 Platform spine rollout (migration 053): RLS + grants on the four
-- platform ingress/bus tables, the policy_documents split, and the documented
-- global capability exception.
-- Proves as `iptv_app`: own CRUD, cross-tenant 0 rows, tenant_id rewrite
-- rejected (WITH CHECK => 42501), no-context fail-closed (SELECT 0 rows +
-- INSERT rejected), owner bypass, PARTNER-layer containment (own PARTNER row
-- visible, other-tenant PARTNER rows 0 rows + cross-tenant PARTNER INSERT
-- refused, authorized target-context insert lands). Plus: grant/policy/RLS
-- preconditions on all
-- enrolled tables, global-table allow-list assertion (exactly the two
-- documented global catalog tables carry no tenant_id), outbox-role boundary
-- (050 EXECUTE-only: worker/executor hold NOTHING on platform ingress
-- tables), append-only triggers intact, and capabilities staying RLS-free.
-- Fixture rows ROLLBACK; role/policy/grants/functions persist.
-- Execute: cat file | docker exec -i iptv-postgres-1 psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
-- (Regression: db/tests/017, 018. Producers/ingress behavior: db/tests/020.)
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 053 preconditions: app role, RLS + policies + DML grants.
DO $$
DECLARE
    tables text[] := ARRAY[
        'platform.inbox_messages',
        'platform.idempotency_keys',
        'platform.domain_events',
        'platform.audit_log',
        'platform.policy_documents'
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
        IF has_table_privilege('iptv_app', t, 'SELECT') IS DISTINCT FROM true
            OR has_table_privilege('iptv_app', t, 'INSERT') IS DISTINCT FROM true
            OR has_table_privilege('iptv_app', t, 'UPDATE') IS DISTINCT FROM true
            OR has_table_privilege('iptv_app', t, 'DELETE') IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'app role lacks full DML grants on %', t;
        END IF;
    END LOOP;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'platform' AND tablename = 'inbox_messages'
          AND policyname = 'tenant_isolation'
    ) THEN
        RAISE EXCEPTION 'tenant_isolation policy missing on platform.inbox_messages';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'platform' AND tablename = 'idempotency_keys'
          AND policyname = 'tenant_isolation'
    ) THEN
        RAISE EXCEPTION 'tenant_isolation policy missing on platform.idempotency_keys';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'platform' AND tablename = 'domain_events'
          AND policyname = 'tenant_isolation'
    ) THEN
        RAISE EXCEPTION 'tenant_isolation policy missing on platform.domain_events';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'platform' AND tablename = 'audit_log'
          AND policyname = 'tenant_isolation'
    ) THEN
        RAISE EXCEPTION 'tenant_isolation policy missing on platform.audit_log';
    END IF;
    FOREACH t IN ARRAY ARRAY[
        'policy_documents_select',
        'policy_documents_insert',
        'policy_documents_update',
        'policy_documents_delete'
    ] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'platform' AND tablename = 'policy_documents'
              AND policyname = t
        ) THEN
            RAISE EXCEPTION 'split policy % missing on platform.policy_documents', t;
        END IF;
    END LOOP;
    RAISE NOTICE 'rollout preconditions OK: iptv_app NOBYPASSRLS, RLS + policies + DML grants on 5 tables';
END $$;

-- 2) Allow-list assertion: every platform table EXCEPT the documented
-- globals must carry tenant_id. Exactly four globals, each justified:
--   * capabilities, capability_events -- the 014 global catalog (no
--     tenant_id by construction; scoping lives in resolution);
--   * outbox_runtime_control, outbox_runtime_transitions -- the 051 singleton
--     runtime authority + switch log (tenant-agnostic by design, owned by
--     `outbox_executor`, zero grants to any other role).
DO $$
DECLARE
    n_global integer;
    v_owner name;
BEGIN
    SELECT count(*) INTO n_global
    FROM pg_tables pt
    WHERE pt.schemaname = 'platform'
      AND pt.tablename NOT IN (
          SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
          WHERE n.nspname = 'platform' AND c.relkind = 'r'
      );
    IF n_global <> 4 THEN
        RAISE EXCEPTION 'global-table allow-list violated: expected exactly 4 documented globals, found %', n_global;
    END IF;
    FOREACH v_owner IN ARRAY ARRAY['capabilities', 'capability_events', 'outbox_runtime_control', 'outbox_runtime_transitions'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'platform' AND tablename = v_owner) THEN
            RAISE EXCEPTION 'global-table allow-list violated: % must be the documented global', v_owner;
        END IF;
    END LOOP;
    -- The 051 runtime authority stays executor-owned with zero non-owner
    -- grantees (it is reachable only through functions, never directly).
    FOREACH v_owner IN ARRAY ARRAY['outbox_runtime_control', 'outbox_runtime_transitions'] LOOP
        IF (SELECT pg_get_userbyid(c.relowner) FROM pg_class AS c
            WHERE c.oid = ('platform.' || v_owner)::regclass) IS DISTINCT FROM 'outbox_executor' THEN
            RAISE EXCEPTION 'runtime table % must stay owned by outbox_executor', v_owner;
        END IF;
        IF EXISTS (
            SELECT 1 FROM pg_class AS c, aclexplode(c.relacl) AS a
            WHERE c.oid = ('platform.' || v_owner)::regclass
              AND a.grantee <> c.relowner
        ) THEN
            RAISE EXCEPTION 'runtime table % carries an unexpected grant (zero non-owner grantees allowed)', v_owner;
        END IF;
    END LOOP;
    -- The documented exception carries NO RLS (global catalog by design).
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'platform.capabilities'::regclass) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'platform.capabilities must stay without RLS (documented global exception)';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'platform.capability_events'::regclass) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'platform.capability_events must stay without RLS (documented global exception)';
    END IF;
    RAISE NOTICE 'allow-list OK: exactly the 4 documented globals (2 catalog RLS-free by design + 2 executor-owned runtime tables)';
END $$;

-- 3) Outbox-role boundary (migration 050 EXECUTE-only): neither the worker
-- identity nor the executor may hold ANY direct privilege on the enrolled
-- platform tables (050 grants live on outbox_messages/outbox_transitions
-- only; an injected GRANT here would silently widen the worker).
DO $$
DECLARE
    tables text[] := ARRAY[
        'platform.inbox_messages',
        'platform.idempotency_keys',
        'platform.domain_events',
        'platform.audit_log',
        'platform.policy_documents',
        'platform.capabilities',
        'platform.capability_events'
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
    RAISE NOTICE 'outbox boundary OK: worker/executor hold nothing on platform ingress tables';
END $$;

-- 4) Append-only / immutability triggers survive (001/014/050/051 intact).
DO $$
DECLARE
    triggers text[] := ARRAY[
        'audit_log_append_only',
        'domain_events_append_only',
        'capability_events_append_only',
        'policy_documents_published_immutable',
        'outbox_transitions_append_only',
        'outbox_runtime_transitions_append_only'
    ];
    g text;
BEGIN
    FOREACH g IN ARRAY triggers LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = g) THEN
            RAISE EXCEPTION 'trigger % is missing (001-051 must stay intact)', g;
        END IF;
    END LOOP;
    RAISE NOTICE 'triggers OK: 001/014/050/051 append-only surface intact';
END $$;

-- 5) Fixture: two tenants with one row each in the four tables, plus policy
-- documents (one PLATFORM global, one TENANT per tenant) and one capability.
CREATE TEMP TABLE platform_rollout_ids (ta uuid, tb uuid);

DO $$
DECLARE
    ta uuid; tb uuid;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-pf-a-' || gen_random_uuid(), 'RLS Platform A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-pf-b-' || gen_random_uuid(), 'RLS Platform B') RETURNING id INTO tb;

    INSERT INTO platform.inbox_messages (tenant_id, provider, external_event_id, event_type, payload_hash, payload_json, state)
    VALUES (ta, 'test', 'ext-a-1', 'test.raw', 'hash-a', '{"n":1}', 'RECEIVED'),
           (tb, 'test', 'ext-b-1', 'test.raw', 'hash-b', '{"n":2}', 'RECEIVED');

    INSERT INTO platform.idempotency_keys (tenant_id, scope, idempotency_key, request_hash, state)
    VALUES (ta, 'scope-a', 'key-a-1', 'req-a', 'IN_PROGRESS'),
           (tb, 'scope-b', 'key-b-1', 'req-b', 'IN_PROGRESS');

    INSERT INTO platform.domain_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, occurred_at, correlation_id, actor_type, schema_version, data_json)
    VALUES (ta, 'test.created.v1', 'test', gen_random_uuid(), 1, now(), gen_random_uuid(), 'system', 1, '{"n":1}'),
           (tb, 'test.created.v1', 'test', gen_random_uuid(), 1, now(), gen_random_uuid(), 'system', 1, '{"n":2}');

    INSERT INTO platform.audit_log (tenant_id, actor_type, action_key, resource_type)
    VALUES (ta, 'system', 'test.action.a', 'test'),
           (tb, 'system', 'test.action.b', 'test');

    INSERT INTO platform.policy_documents (tenant_id, family, scope, class, version, status, document, published_at)
    VALUES (NULL, 'rollout-global', 'PLATFORM', 'PLATFORM_POLICY', 1, 'PUBLISHED', '{"allow":true}', now()),
           (ta, 'rollout-tenant', 'TENANT', 'TENANT_POLICY', 1, 'PUBLISHED', '{"tenant":"a"}', now()),
           (tb, 'rollout-tenant', 'TENANT', 'TENANT_POLICY', 1, 'PUBLISHED', '{"tenant":"b"}', now()),
           (ta, 'rollout-partner', 'PARTNER', 'PARTNER_POLICY', 1, 'PUBLISHED', '{"partner":"a"}', now()),
           (tb, 'rollout-partner', 'PARTNER', 'PARTNER_POLICY', 1, 'PUBLISHED', '{"partner":"b"}', now());

    INSERT INTO platform.capabilities (key, owner_context, policy_family)
    VALUES ('rollout.cap-' || gen_random_uuid(), 'platform', 'rollout-global');

    INSERT INTO platform_rollout_ids VALUES (ta, tb);
    RAISE NOTICE 'platform fixture ready: tenants % / %', ta, tb;
END $$;

-- 6) Tenant A context sees ONLY tenant A rows on the four tables; the
-- PLATFORM policy row stays visible to both (documented split semantics).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
    sampled text[] := ARRAY[
        'platform.inbox_messages',
        'platform.idempotency_keys',
        'platform.domain_events',
        'platform.audit_log'
    ];
    t text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM platform_rollout_ids s LIMIT 1;
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
    -- Policy split: own TENANT row + the GLOBAL row, never the other tenant.
    SELECT count(*) INTO n_all FROM platform.policy_documents
    WHERE family IN ('rollout-global', 'rollout-tenant');
    IF n_all <> 2 THEN
        RAISE EXCEPTION 'policy_documents: tenant A must see exactly 2 rows (global + own), saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM platform.policy_documents WHERE tenant_id = tb;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'policy_documents: cross-tenant read must return 0 rows, saw %', n_other;
    END IF;
    -- Global catalog: visible without tenant scoping.
    SELECT count(*) INTO n_all FROM platform.capabilities WHERE key LIKE 'rollout.cap-%';
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'capabilities: global row must stay visible, saw %', n_all;
    END IF;
    RAISE NOTICE 'tenant A isolation OK: 1 own row per table, 0 cross-tenant, global policy + capability visible';
END $$;

-- 7) Tenant B mirrors A (proves RESET between blocks).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM platform_rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM platform.inbox_messages;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'platform.inbox_messages: tenant B must see exactly 1 row, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM platform.inbox_messages WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'platform.inbox_messages: cross-tenant read must return 0 rows, saw %', n_other;
    END IF;
    SELECT count(*) INTO n_all FROM platform.domain_events;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'platform.domain_events: tenant B must see exactly 1 row, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM platform.domain_events WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'platform.domain_events: cross-tenant read must return 0 rows, saw %', n_other;
    END IF;
    SELECT count(*) INTO n_all FROM platform.policy_documents
    WHERE family IN ('rollout-global', 'rollout-tenant');
    IF n_all <> 2 THEN
        RAISE EXCEPTION 'policy_documents: tenant B must see exactly 2 rows (global + own), saw %', n_all;
    END IF;
    RAISE NOTICE 'tenant B isolation OK: 1 own row per table, 0 cross-tenant, global policy visible';
END $$;

-- 8) Write path as tenant A: own INSERT/UPDATE/DELETE succeed where the
-- table allows mutation; cross-tenant UPDATE touches 0 rows; tenant_id
-- rewrite and cross-tenant INSERT are rejected WITH CHECK (42501); global
-- policy rows are immutable through the app role (048 steal defect stays
-- closed); append-only tables refuse UPDATE/DELETE by trigger.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    scratch uuid;
    ev uuid;
    affected integer;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM platform_rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;

    -- inbox: full own lifecycle on a scratch row.
    INSERT INTO platform.inbox_messages (tenant_id, provider, external_event_id, payload_hash, state)
    VALUES (ta, 'test', 'scratch-' || gen_random_uuid(), 'h', 'RECEIVED') RETURNING id INTO scratch;
    UPDATE platform.inbox_messages SET state = 'PROCESSING' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own inbox UPDATE must affect 1 row, affected %', affected;
    END IF;
    UPDATE platform.inbox_messages SET state = 'PROCESSING' WHERE tenant_id = tb;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'cross-tenant inbox UPDATE must touch 0 rows, touched %', affected;
    END IF;
    BEGIN
        UPDATE platform.inbox_messages SET tenant_id = tb WHERE id = scratch;
        RAISE EXCEPTION 'expected tenant_id rewrite to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    DELETE FROM platform.inbox_messages WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch inbox DELETE must affect 1 row, affected %', affected;
    END IF;
    BEGIN
        INSERT INTO platform.inbox_messages (tenant_id, provider, external_event_id, payload_hash, state)
        VALUES (tb, 'test', 'x-' || gen_random_uuid(), 'h', 'RECEIVED');
        RAISE EXCEPTION 'expected cross-tenant inbox INSERT to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    -- idempotency: own INSERT + reclaim-style UPDATE land; cross-tenant fails.
    INSERT INTO platform.idempotency_keys (tenant_id, scope, idempotency_key, request_hash, state)
    VALUES (ta, 'scope-a', 'scratch-' || gen_random_uuid(), 'req', 'IN_PROGRESS') RETURNING id INTO scratch;
    UPDATE platform.idempotency_keys SET state = 'SUCCEEDED' WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own idempotency UPDATE must affect 1 row, affected %', affected;
    END IF;
    DELETE FROM platform.idempotency_keys WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch idempotency DELETE must affect 1 row, affected %', affected;
    END IF;
    BEGIN
        INSERT INTO platform.idempotency_keys (tenant_id, scope, idempotency_key, request_hash, state)
        VALUES (tb, 'scope-b', 'x-' || gen_random_uuid(), 'req', 'IN_PROGRESS');
        RAISE EXCEPTION 'expected cross-tenant idempotency INSERT to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    -- domain_events: own INSERT lands; cross-tenant INSERT rejected;
    -- mutation refused by the append-only trigger (not RLS).
    ev := gen_random_uuid();
    INSERT INTO platform.domain_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, occurred_at, correlation_id, actor_type, schema_version)
    VALUES (ta, 'test.write.v1', 'test', ev, 1, now(), gen_random_uuid(), 'system', 1);
    BEGIN
        INSERT INTO platform.domain_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, occurred_at, correlation_id, actor_type, schema_version)
        VALUES (tb, 'test.write.v1', 'test', gen_random_uuid(), 1, now(), gen_random_uuid(), 'system', 1);
        RAISE EXCEPTION 'expected cross-tenant domain_event INSERT to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        UPDATE platform.domain_events SET event_type = 'test.mutated.v1'
        WHERE tenant_id = ta AND aggregate_id = ev;
        RAISE EXCEPTION 'expected domain_events UPDATE to fail on the append-only trigger';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;

    -- audit_log: own INSERT lands; cross-tenant INSERT rejected; DELETE
    -- refused by the append-only trigger.
    INSERT INTO platform.audit_log (tenant_id, actor_type, action_key, resource_type)
    VALUES (ta, 'system', 'test.write', 'test');
    BEGIN
        INSERT INTO platform.audit_log (tenant_id, actor_type, action_key, resource_type)
        VALUES (tb, 'system', 'test.write', 'test');
        RAISE EXCEPTION 'expected cross-tenant audit INSERT to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        DELETE FROM platform.audit_log WHERE tenant_id = ta AND action_key = 'test.write';
        RAISE EXCEPTION 'expected audit_log DELETE to fail on the append-only trigger';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;

    -- policy split: own TENANT INSERT lands; cross-tenant INSERT rejected;
    -- PLATFORM publish (NULL tenant) allowed through the app command path;
    -- global rows invisible to UPDATE (steal closed); own rows updatable.
    INSERT INTO platform.policy_documents (tenant_id, family, scope, class, version, status, published_at)
    VALUES (ta, 'rollout-write', 'TENANT', 'TENANT_POLICY', 1, 'DRAFT', NULL);
    BEGIN
        INSERT INTO platform.policy_documents (tenant_id, family, scope, class, version, status, published_at)
        VALUES (tb, 'rollout-write', 'TENANT', 'TENANT_POLICY', 1, 'DRAFT', NULL);
        RAISE EXCEPTION 'expected cross-tenant policy INSERT to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    INSERT INTO platform.policy_documents (tenant_id, family, scope, class, version, status, published_at)
    VALUES (NULL, 'rollout-platform-write', 'PLATFORM', 'PLATFORM_POLICY', 1, 'DRAFT', NULL);
    UPDATE platform.policy_documents SET status = 'PUBLISHED', published_at = now()
    WHERE tenant_id = ta AND family = 'rollout-write';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own policy UPDATE must affect 1 row, affected %', affected;
    END IF;
    UPDATE platform.policy_documents SET document = '{"stolen":true}'
    WHERE family = 'rollout-global' AND tenant_id IS NULL;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'global policy UPDATE must touch 0 rows (steal closed), touched %', affected;
    END IF;
    DELETE FROM platform.policy_documents WHERE family = 'rollout-global' AND tenant_id IS NULL;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'global policy DELETE must touch 0 rows, touched %', affected;
    END IF;
    -- Deletion through the app role: PUBLISHED rows raise (014 immutable
    -- history); DRAFT rows are a SILENT no-op (014's guard returns NEW,
    -- which is NULL in a DELETE context, so the row is skipped without an
    -- error -- frozen 014 behavior, out of 053 scope to change, and no app
    -- path deletes policy rows). Either way nothing is destructible here.
    BEGIN
        DELETE FROM platform.policy_documents WHERE tenant_id = ta AND family = 'rollout-write';
        RAISE EXCEPTION 'expected PUBLISHED policy DELETE to fail on the immutability trigger';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    INSERT INTO platform.policy_documents (tenant_id, family, scope, class, version, status, published_at)
    VALUES (ta, 'rollout-write-del', 'TENANT', 'TENANT_POLICY', 1, 'DRAFT', NULL);
    DELETE FROM platform.policy_documents WHERE tenant_id = ta AND family = 'rollout-write-del';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'draft policy DELETE unexpectedly removed rows, affected %', affected;
    END IF;
    DELETE FROM platform.policy_documents WHERE tenant_id IS NULL AND family = 'rollout-platform-write';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'platform draft DELETE unexpectedly removed rows, affected %', affected;
    END IF;
    RAISE NOTICE 'write path OK: own CRUD lands, cross-tenant filtered/rejected, globals immutable via app role';
END $$;

-- 9) Fail-closed: app role with NO tenant context sees nothing tenant-scoped
-- (global policy + capability rows stay visible by design) and cannot insert.
DO $$
DECLARE
    ta uuid;
    n integer;
    sampled text[] := ARRAY[
        'platform.inbox_messages',
        'platform.idempotency_keys',
        'platform.domain_events',
        'platform.audit_log'
    ];
    t text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta INTO ta FROM platform_rollout_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    FOREACH t IN ARRAY sampled LOOP
        EXECUTE format('SELECT count(*) FROM %s', t) INTO n;
        IF n <> 0 THEN
            RAISE EXCEPTION '%: app role without tenant context must see 0 rows, saw %', t, n;
        END IF;
    END LOOP;
    SELECT count(*) INTO n FROM platform.policy_documents WHERE tenant_id = ta;
    IF n <> 0 THEN
        RAISE EXCEPTION 'policy_documents: tenant rows without context must be 0, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM platform.policy_documents WHERE tenant_id IS NULL AND family = 'rollout-global';
    IF n <> 1 THEN
        RAISE EXCEPTION 'policy_documents: global row must stay visible without context, saw %', n;
    END IF;
    BEGIN
        INSERT INTO platform.inbox_messages (tenant_id, provider, external_event_id, payload_hash, state)
        VALUES (ta, 'test', 'noctx-' || gen_random_uuid(), 'h', 'RECEIVED');
        RAISE EXCEPTION 'expected no-context inbox INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO platform.audit_log (tenant_id, actor_type, action_key, resource_type)
        VALUES (ta, 'system', 'test.noctx', 'test');
        RAISE EXCEPTION 'expected no-context audit INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'fail-closed OK: no tenant context => 0 tenant rows + INSERTs rejected, globals still readable';
END $$;

-- 10) Owner/superuser bypasses RLS: sees BOTH tenants regardless of context.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM platform_rollout_ids s LIMIT 1;
    SELECT count(*) INTO n FROM platform.inbox_messages WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 rollout inbox rows, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM platform.domain_events WHERE tenant_id IN (ta, tb);
    -- 2 fixture rows + the 1 own-tenant row landed by the block-8 write path.
    IF n <> 3 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 3 rollout domain events, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM platform.audit_log WHERE tenant_id IN (ta, tb);
    -- 2 fixture rows + the 1 own-tenant row landed by the block-8 write path.
    IF n <> 3 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 3 rollout audit rows, saw %', n;
    END IF;
    RAISE NOTICE 'owner bypass OK: superuser sees all tenants (BYPASSRLS)';
END $$;

-- 11) PARTNER-layer containment (MEDIUM finding): as `iptv_app` in tenant A
-- context, the own PARTNER row stays visible, the other tenant's PARTNER rows
-- read 0 rows, a direct cross-tenant PARTNER INSERT is refused WITH CHECK
-- (42501), and a cross-tenant PARTNER UPDATE touches 0 rows -- no generic
-- cross-tenant opening. The authorized narrow path (the exact mechanism the
-- app command uses: statements scoped to the TARGET tenant) lands the row.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n integer;
    affected integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM platform_rollout_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;

    -- Own PARTNER row visible; the other tenant's PARTNER rows denied.
    SELECT count(*) INTO n FROM platform.policy_documents
    WHERE family = 'rollout-partner' AND tenant_id = ta;
    IF n <> 1 THEN
        RAISE EXCEPTION 'policy_documents: own PARTNER row must be visible, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM platform.policy_documents
    WHERE family = 'rollout-partner' AND tenant_id = tb;
    IF n <> 0 THEN
        RAISE EXCEPTION 'policy_documents: other-tenant PARTNER read must return 0 rows, saw %', n;
    END IF;
    -- Direct cross-tenant PARTNER INSERT refused (no generic opening).
    BEGIN
        INSERT INTO platform.policy_documents (tenant_id, family, scope, class, version, status, published_at)
        VALUES (tb, 'rollout-partner-x', 'PARTNER', 'PARTNER_POLICY', 1, 'DRAFT', NULL);
        RAISE EXCEPTION 'expected cross-tenant PARTNER INSERT to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    UPDATE platform.policy_documents SET document = '{"stolen":true}'
    WHERE family = 'rollout-partner' AND tenant_id = tb;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'cross-tenant PARTNER UPDATE must touch 0 rows, touched %', affected;
    END IF;
    -- Authorized narrow path: the same statements scoped to the TARGET tenant
    -- (what the app `policy.publish` PARTNER flow does for platform admins)
    -- land the row.
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    INSERT INTO platform.policy_documents (tenant_id, family, scope, class, version, status, document, published_at)
    VALUES (tb, 'rollout-partner-write', 'PARTNER', 'PARTNER_POLICY', 1, 'PUBLISHED', '{"partner":"b2"}', now());
    SELECT count(*) INTO n FROM platform.policy_documents
    WHERE family = 'rollout-partner-write' AND tenant_id = tb;
    IF n <> 1 THEN
        RAISE EXCEPTION 'target-context PARTNER INSERT must land, saw %', n;
    END IF;
    RAISE NOTICE 'PARTNER containment OK: own visible, cross-tenant denied, target-context lands';
END $$;

ROLLBACK;
