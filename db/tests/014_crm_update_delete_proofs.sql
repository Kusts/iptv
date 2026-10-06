-- 014 RLS write-authorization proofs on the 041 crm.customers surface
-- (adapted from PR #3 `012_rls_update_delete_proofs.sql`; renumbered because
-- main already registers a different 012 for the control/identity rollout).
-- Proves UPDATE USING row isolation, WITH CHECK row-theft prevention, DELETE
-- isolation independent from UPDATE, and no-context fail-closed behavior as
-- iptv_app. This does NOT enroll any new table or prove other domains/workers.
-- Fixture rows and attempted writes ROLLBACK; roles/grants/policies persist.
-- Execute only on a disposable database after applying every migration:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/014_crm_update_delete_proofs.sql
\set ON_ERROR_STOP on
BEGIN;

-- 1) Preconditions: the persistent app role and the 041 policy are active.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iptv_app') THEN
        RAISE EXCEPTION 'migration 041 not applied: role iptv_app is missing';
    END IF;
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'iptv_app') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'iptv_app must be NOBYPASSRLS';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'crm.customers'::regclass) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'RLS is not enabled on crm.customers';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'crm'
          AND tablename = 'customers'
          AND policyname = 'tenant_isolation'
    ) THEN
        RAISE EXCEPTION 'tenant_isolation policy missing on crm.customers';
    END IF;
END $$;

-- 2) Owner fixture: two tenants, one customer each, and one spare person per
-- tenant for no-context INSERT checks. IDs are captured in a session temp table.
CREATE TEMP TABLE rls_write_proof_ids (
    tenant_a uuid,
    tenant_b uuid,
    person_a uuid,
    person_b uuid,
    person_a_extra uuid,
    person_b_extra uuid,
    customer_a uuid,
    customer_b uuid
);

DO $$
DECLARE
    tenant_a uuid;
    tenant_b uuid;
    person_a uuid;
    person_b uuid;
    person_a_extra uuid;
    person_b_extra uuid;
    customer_a uuid;
    customer_b uuid;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-write-a-' || gen_random_uuid(), 'RLS Write A')
    RETURNING id INTO tenant_a;
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-write-b-' || gen_random_uuid(), 'RLS Write B')
    RETURNING id INTO tenant_b;

    INSERT INTO identity.persons (tenant_id) VALUES (tenant_a) RETURNING id INTO person_a;
    INSERT INTO identity.persons (tenant_id) VALUES (tenant_b) RETURNING id INTO person_b;
    INSERT INTO identity.persons (tenant_id) VALUES (tenant_a) RETURNING id INTO person_a_extra;
    INSERT INTO identity.persons (tenant_id) VALUES (tenant_b) RETURNING id INTO person_b_extra;

    INSERT INTO crm.customers (tenant_id, person_id)
    VALUES (tenant_a, person_a) RETURNING id INTO customer_a;
    INSERT INTO crm.customers (tenant_id, person_id)
    VALUES (tenant_b, person_b) RETURNING id INTO customer_b;

    INSERT INTO rls_write_proof_ids VALUES (
        tenant_a, tenant_b, person_a, person_b,
        person_a_extra, person_b_extra, customer_a, customer_b
    );
END $$;

-- 3) Tenant A: own UPDATE succeeds; UPDATE cannot read-steal B's row; changing
-- A's tenant_id is rejected by WITH CHECK; DELETE of B is filtered separately.
DO $$
DECLARE
    tenant_a uuid;
    tenant_b uuid;
    customer_a uuid;
    customer_b uuid;
    affected integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT f.tenant_a, f.tenant_b, f.customer_a, f.customer_b
    INTO tenant_a, tenant_b, customer_a, customer_b
    FROM rls_write_proof_ids AS f;

    EXECUTE format('SET LOCAL app.tenant_id = %L', tenant_a::text);
    SET LOCAL ROLE iptv_app;

    UPDATE crm.customers
    SET status = 'LAPSED', updated_at = now()
    WHERE id = customer_a;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'tenant A own UPDATE must affect 1 row, affected %', affected;
    END IF;

    UPDATE crm.customers
    SET status = 'REACTIVATING', updated_at = now()
    WHERE id = customer_b;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'tenant A UPDATE must not affect tenant B row, affected %', affected;
    END IF;

    BEGIN
        UPDATE crm.customers
        SET tenant_id = tenant_b
        WHERE id = customer_a;
        RAISE EXCEPTION 'expected tenant A row migration to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    DELETE FROM crm.customers WHERE id = customer_b;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'tenant A DELETE must not affect tenant B row, affected %', affected;
    END IF;
END $$;

-- 4) Tenant B: inverse UPDATE theft, row migration, and DELETE checks.
DO $$
DECLARE
    tenant_a uuid;
    tenant_b uuid;
    customer_a uuid;
    customer_b uuid;
    affected integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT f.tenant_a, f.tenant_b, f.customer_a, f.customer_b
    INTO tenant_a, tenant_b, customer_a, customer_b
    FROM rls_write_proof_ids AS f;

    EXECUTE format('SET LOCAL app.tenant_id = %L', tenant_b::text);
    SET LOCAL ROLE iptv_app;

    UPDATE crm.customers
    SET status = 'CHURNED', updated_at = now()
    WHERE id = customer_b;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'tenant B own UPDATE must affect 1 row, affected %', affected;
    END IF;

    UPDATE crm.customers
    SET status = 'REACTIVATING', updated_at = now()
    WHERE id = customer_a;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'tenant B UPDATE must not affect tenant A row, affected %', affected;
    END IF;

    BEGIN
        UPDATE crm.customers
        SET tenant_id = tenant_a
        WHERE id = customer_b;
        RAISE EXCEPTION 'expected tenant B row migration to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    DELETE FROM crm.customers WHERE id = customer_a;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'tenant B DELETE must not affect tenant A row, affected %', affected;
    END IF;
END $$;

-- 5) No tenant context: SELECT fails closed and INSERT is rejected by WITH CHECK.
DO $$
DECLARE
    tenant_a uuid;
    person_a_extra uuid;
    visible_rows integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT f.tenant_a, f.person_a_extra INTO tenant_a, person_a_extra
    FROM rls_write_proof_ids AS f;
    SET LOCAL ROLE iptv_app;

    SELECT count(*) INTO visible_rows FROM crm.customers;
    IF visible_rows <> 0 THEN
        RAISE EXCEPTION 'no-context SELECT must see 0 rows, saw %', visible_rows;
    END IF;

    BEGIN
        INSERT INTO crm.customers (tenant_id, person_id)
        VALUES (tenant_a, person_a_extra);
        RAISE EXCEPTION 'expected no-context INSERT to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
END $$;

-- 6) Owner can see both tenants and verify unauthorized mutations did not land.
DO $$
DECLARE
    tenant_a uuid;
    tenant_b uuid;
    customer_a uuid;
    customer_b uuid;
    status_a text;
    status_b text;
    visible_rows integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT f.tenant_a, f.tenant_b, f.customer_a, f.customer_b
    INTO tenant_a, tenant_b, customer_a, customer_b
    FROM rls_write_proof_ids AS f;

    SELECT count(*) INTO visible_rows
    FROM crm.customers
    WHERE tenant_id IN (tenant_a, tenant_b);
    IF visible_rows <> 2 THEN
        RAISE EXCEPTION 'owner must see both fixture customers, saw %', visible_rows;
    END IF;
    SELECT status INTO status_a FROM crm.customers WHERE tenant_id = tenant_a AND id = customer_a;
    SELECT status INTO status_b FROM crm.customers WHERE tenant_id = tenant_b AND id = customer_b;
    IF status_a <> 'LAPSED' OR status_b <> 'CHURNED' THEN
        RAISE EXCEPTION 'cross-tenant UPDATE/DELETE changed rows: A status %, B status %', status_a, status_b;
    END IF;
END $$;

\echo 014: RLS UPDATE/DELETE proofs PASS: tenant A/B own writes, UPDATE row theft, WITH CHECK row migration, DELETE isolation, no-context fail-closed, owner visibility
ROLLBACK;
