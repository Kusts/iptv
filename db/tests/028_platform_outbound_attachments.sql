-- 028 Platform outbound attachments proof (migration 061, EXEC-WAHA-BACKING-20261020).
-- RLS `tenant_isolation` + SELECT/INSERT grants on
-- `platform.outbound_attachments` (immutable blob store: no UPDATE/DELETE
-- grants by design), outbox-role boundary on the new table (050
-- EXECUTE-only), tenant A/B isolation, tenant-scoped `ref` unique (same
-- ref reusable under the OTHER tenant), no-context fail-closed, owner
-- bypass. Fixture rows ROLLBACK; role/policy/grants persist.
-- Execute: cat file | docker exec -i iptv-postgres-1 psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 061 preconditions on the new table.
DO $$
BEGIN
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'iptv_app') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'app role iptv_app must exist with NOBYPASSRLS';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'platform.outbound_attachments'::regclass) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'RLS is not enabled on platform.outbound_attachments';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'platform'
          AND tablename = 'outbound_attachments'
          AND policyname = 'tenant_isolation'
    ) THEN
        RAISE EXCEPTION 'tenant_isolation policy missing on platform.outbound_attachments';
    END IF;
    IF has_table_privilege('iptv_app', 'platform.outbound_attachments', 'SELECT') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'platform.outbound_attachments', 'INSERT') IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'app role lacks SELECT+INSERT grants on platform.outbound_attachments';
    END IF;
    -- Immutable blob store by design: no UPDATE/DELETE grants.
    IF has_table_privilege('iptv_app', 'platform.outbound_attachments', 'UPDATE') IS DISTINCT FROM false
        OR has_table_privilege('iptv_app', 'platform.outbound_attachments', 'DELETE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'app role must NOT hold UPDATE/DELETE on platform.outbound_attachments';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'outbound_attachments_tenant_ref_unique'
          AND conrelid = 'platform.outbound_attachments'::regclass
    ) THEN
        RAISE EXCEPTION 'outbound_attachments_tenant_ref_unique missing';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_class AS c, aclexplode(c.relacl) AS a
        WHERE c.oid = 'platform.outbound_attachments'::regclass
          AND a.grantee = 0
    ) THEN
        RAISE EXCEPTION 'platform.outbound_attachments is still granted to PUBLIC';
    END IF;
    RAISE NOTICE 'preconditions OK: iptv_app NOBYPASSRLS, RLS + tenant_isolation + SELECT/INSERT only + tenant_ref unique + no PUBLIC';
END $$;

-- 2) Outbox-role boundary (migration 050 EXECUTE-only): neither the worker
-- identity nor the executor may hold ANY direct privilege on the new table.
DO $$
BEGIN
    IF has_table_privilege('outbox_worker', 'platform.outbound_attachments', 'SELECT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_worker', 'platform.outbound_attachments', 'INSERT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_worker', 'platform.outbound_attachments', 'UPDATE') IS DISTINCT FROM false
        OR has_table_privilege('outbox_worker', 'platform.outbound_attachments', 'DELETE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_worker must hold no privilege on platform.outbound_attachments (050 EXECUTE-only boundary)';
    END IF;
    IF has_table_privilege('outbox_executor', 'platform.outbound_attachments', 'SELECT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_executor', 'platform.outbound_attachments', 'INSERT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_executor', 'platform.outbound_attachments', 'UPDATE') IS DISTINCT FROM false
        OR has_table_privilege('outbox_executor', 'platform.outbound_attachments', 'DELETE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_executor must hold no privilege on platform.outbound_attachments (050 EXECUTE-only boundary)';
    END IF;
    RAISE NOTICE 'outbox boundary OK: worker/executor hold nothing on the attachments table';
END $$;

-- 3) Fixture: two tenants, one attachment row each, as owner.
CREATE TEMP TABLE attachment_proof_ids (ta uuid, tb uuid);

DO $$
DECLARE
    ta uuid; tb uuid;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('att-proof-a-' || gen_random_uuid(), 'Attachment Proof A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('att-proof-b-' || gen_random_uuid(), 'Attachment Proof B') RETURNING id INTO tb;
    INSERT INTO platform.outbound_attachments (tenant_id, ref, kind, mime_type, file_name, content, size_bytes, sha256)
    VALUES (ta, 'att-proof-a-0001', 'IMAGE', 'image/jpeg', 'a.jpg', decode('ffd8ffe0', 'hex'), 4,
            '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'),
           (tb, 'att-proof-b-0001', 'IMAGE', 'image/jpeg', 'b.jpg', decode('ffd8ffe0', 'hex'), 4,
            '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
    INSERT INTO attachment_proof_ids VALUES (ta, tb);
    RAISE NOTICE 'attachment fixture ready: tenants % / %', ta, tb;
END $$;

-- 4) Tenant A context sees ONLY tenant A attachments.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM attachment_proof_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM platform.outbound_attachments;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'tenant A app role must see exactly 1 attachment, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM platform.outbound_attachments WHERE tenant_id = tb;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'cross-tenant attachment read must return 0 rows, saw %', n_other;
    END IF;
    RAISE NOTICE 'tenant A isolation OK: 1 own attachment, 0 cross-tenant rows';
END $$;

-- 5) Tenant B context sees ONLY tenant B attachments.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM attachment_proof_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM platform.outbound_attachments;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'tenant B app role must see exactly 1 attachment, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM platform.outbound_attachments WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'cross-tenant attachment read must return 0 rows, saw %', n_other;
    END IF;
    RAISE NOTICE 'tenant B isolation OK: 1 own attachment, 0 cross-tenant rows';
END $$;

-- 6) Uniqueness: duplicate (tenant, ref) is rejected; the SAME ref under the
-- OTHER tenant is allowed (unique is tenant-scoped by design).
DO $$
DECLARE
    ta uuid;
    tb uuid;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM attachment_proof_ids s LIMIT 1;
    BEGIN
        INSERT INTO platform.outbound_attachments (tenant_id, ref, kind, mime_type, file_name, content, size_bytes, sha256)
        VALUES (ta, 'att-proof-a-0001', 'IMAGE', 'image/jpeg', 'dup.jpg', decode('ffd8ffe0', 'hex'), 4,
                '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
        RAISE EXCEPTION 'expected tenant_ref_unique violation for duplicate (tenant, ref)';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    INSERT INTO platform.outbound_attachments (tenant_id, ref, kind, mime_type, file_name, content, size_bytes, sha256)
    VALUES (tb, 'att-proof-a-0001', 'IMAGE', 'image/jpeg', 'shared.jpg', decode('ffd8ffe0', 'hex'), 4,
            '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
    RAISE NOTICE 'unique OK: duplicate (tenant, ref) refused, cross-tenant ref reuse allowed';
END $$;

-- 7) Write path as tenant A: own INSERT lands and is visible; cross-tenant
-- INSERT rejected (WITH CHECK => 42501); UPDATE/DELETE refused (no grant).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    scratch uuid;
    affected integer;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM attachment_proof_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;

    INSERT INTO platform.outbound_attachments (tenant_id, ref, kind, mime_type, file_name, content, size_bytes, sha256)
    VALUES (ta, 'att-proof-a-scratch', 'DOCUMENT', 'application/pdf', 's.pdf', decode('25504446', 'hex'), 4,
            '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')
    RETURNING id INTO scratch;
    SELECT count(*) INTO n FROM platform.outbound_attachments WHERE id = scratch;
    IF n <> 1 THEN
        RAISE EXCEPTION 'own attachment INSERT must be visible, saw % rows', n;
    END IF;
    BEGIN
        INSERT INTO platform.outbound_attachments (tenant_id, ref, kind, mime_type, file_name, content, size_bytes, sha256)
        VALUES (tb, 'att-proof-x', 'IMAGE', 'image/jpeg', 'x.jpg', decode('ffd8ffe0', 'hex'), 4,
                '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
        RAISE EXCEPTION 'expected cross-tenant attachment INSERT to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        UPDATE platform.outbound_attachments SET file_name = 'renamed.jpg' WHERE id = scratch;
        RAISE EXCEPTION 'expected attachment UPDATE to fail (no grant)';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        DELETE FROM platform.outbound_attachments WHERE id = scratch;
        RAISE EXCEPTION 'expected attachment DELETE to fail (no grant)';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RAISE NOTICE 'write path OK: own INSERT lands, cross-tenant INSERT rejected (42501), UPDATE/DELETE refused (no grant)';
END $$;

-- 8) Fail-closed: app role with NO tenant context sees nothing and cannot insert.
DO $$
DECLARE
    ta uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta INTO ta FROM attachment_proof_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM platform.outbound_attachments;
    IF n <> 0 THEN
        RAISE EXCEPTION 'app role without tenant context must see 0 attachments, saw %', n;
    END IF;
    BEGIN
        INSERT INTO platform.outbound_attachments (tenant_id, ref, kind, mime_type, file_name, content, size_bytes, sha256)
        VALUES (ta, 'att-proof-noctx', 'IMAGE', 'image/jpeg', 'n.jpg', decode('ffd8ffe0', 'hex'), 4,
                '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
        RAISE EXCEPTION 'expected no-context attachment INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'fail-closed OK: no tenant context => 0 rows + INSERT rejected';
END $$;

-- 9) Owner bypasses RLS: sees BOTH tenants regardless of context.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM attachment_proof_ids s LIMIT 1;
    SELECT count(*) INTO n FROM platform.outbound_attachments WHERE tenant_id IN (ta, tb);
    IF n < 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see both tenants attachments, saw %', n;
    END IF;
    RAISE NOTICE 'owner bypass OK: superuser sees all tenants (BYPASSRLS)';
END $$;

ROLLBACK;
