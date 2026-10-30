-- 031 S1 provider integration bindings proof (migration 065, S1-DESIGN-R2).
-- Extends `provider.provider_accounts` in place (no new generic table):
-- environment (SANDBOX/PRODUCTION), connection_status (NOT_CONFIGURED,
-- DRAFT, TESTING, CONNECTED_READ_ONLY, REAUTH_REQUIRED, DEGRADED,
-- DISABLED), last_checked_at, last_error_code (sanitized code only, never
-- secret material), version (optimistic locking, >= 1); partial unique
-- (tenant_id, provider_id, environment) over live rows only
-- (connection_status <> 'DISABLED': DISABLED rows are history, so a fresh
-- configure after disable never collides); pre-existing rows backfilled
-- fail-closed to REAUTH_REQUIRED (never CONNECTED_* without a test) with
-- environment left on the SANDBOX default (fail-closed for money).
-- RLS `tenant_isolation` + full DML grants re-asserted (055 template),
-- no BYPASSRLS, no PUBLIC, outbox-role boundary preserved.
-- secret_ref stays NOT NULL by design: the row is created ONLY at
-- configure with the vault secret already provisioned server-side; DRAFT
-- lives as connection_status on a real row, never as a secretless
-- placeholder (the dispatcher gate assumes a resolvable ref).
-- Fixture rows ROLLBACK; role/policy/grants persist.
-- Execute: cat file | docker exec -i <disposable-pg> psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
-- RED: run against a DB at migration 064 (columns absent) => section 1
--   preconditions fail loudly. GREEN: run at/after 065 => full pass.
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 065 preconditions on provider.provider_accounts.
DO $$
DECLARE
    v_default text;
    v_nullable text;
    v_pred text;
BEGIN
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'iptv_app') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'app role iptv_app must exist with NOBYPASSRLS';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'provider.provider_accounts'::regclass) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'RLS is not enabled on provider.provider_accounts';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'provider'
          AND tablename = 'provider_accounts'
          AND policyname = 'tenant_isolation'
    ) THEN
        RAISE EXCEPTION 'tenant_isolation policy missing on provider.provider_accounts';
    END IF;
    IF has_table_privilege('iptv_app', 'provider.provider_accounts', 'SELECT') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'provider.provider_accounts', 'INSERT') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'provider.provider_accounts', 'UPDATE') IS DISTINCT FROM true
        OR has_table_privilege('iptv_app', 'provider.provider_accounts', 'DELETE') IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'app role lacks full DML grants on provider.provider_accounts';
    END IF;

    -- New columns exist with fail-closed defaults and nullability.
    SELECT column_default, is_nullable INTO v_default, v_nullable
    FROM information_schema.columns
    WHERE table_schema = 'provider' AND table_name = 'provider_accounts' AND column_name = 'environment';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RED: provider.provider_accounts.environment is absent (migration 065 not applied)';
    END IF;
    IF v_default NOT ILIKE '%SANDBOX%' OR v_nullable <> 'NO' THEN
        RAISE EXCEPTION 'environment must be NOT NULL DEFAULT SANDBOX, saw default=%, nullable=%', v_default, v_nullable;
    END IF;

    SELECT column_default, is_nullable INTO v_default, v_nullable
    FROM information_schema.columns
    WHERE table_schema = 'provider' AND table_name = 'provider_accounts' AND column_name = 'connection_status';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RED: provider.provider_accounts.connection_status is absent (migration 065 not applied)';
    END IF;
    IF v_default NOT ILIKE '%NOT_CONFIGURED%' OR v_nullable <> 'NO' THEN
        RAISE EXCEPTION 'connection_status must be NOT NULL DEFAULT NOT_CONFIGURED, saw default=%, nullable=%', v_default, v_nullable;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'provider' AND table_name = 'provider_accounts'
          AND column_name = 'last_checked_at' AND is_nullable = 'YES'
    ) THEN
        RAISE EXCEPTION 'RED: provider.provider_accounts.last_checked_at is absent (migration 065 not applied)';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'provider' AND table_name = 'provider_accounts'
          AND column_name = 'last_error_code' AND is_nullable = 'YES'
    ) THEN
        RAISE EXCEPTION 'RED: provider.provider_accounts.last_error_code is absent (migration 065 not applied)';
    END IF;

    SELECT column_default, is_nullable INTO v_default, v_nullable
    FROM information_schema.columns
    WHERE table_schema = 'provider' AND table_name = 'provider_accounts' AND column_name = 'version';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RED: provider.provider_accounts.version is absent (migration 065 not applied)';
    END IF;
    IF v_default <> '1' OR v_nullable <> 'NO' THEN
        RAISE EXCEPTION 'version must be NOT NULL DEFAULT 1, saw default=%, nullable=%', v_default, v_nullable;
    END IF;

    -- secret_ref stays NOT NULL by design (row only exists with a secret).
    SELECT is_nullable INTO v_nullable
    FROM information_schema.columns
    WHERE table_schema = 'provider' AND table_name = 'provider_accounts' AND column_name = 'secret_ref';
    IF v_nullable <> 'NO' THEN
        RAISE EXCEPTION 'secret_ref must stay NOT NULL (S1-DESIGN-R2: no secretless placeholder rows)';
    END IF;

    -- CHECK constraints carry the canonical S1 state machines.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'provider_accounts_environment_check'
          AND conrelid = 'provider.provider_accounts'::regclass
    ) THEN
        RAISE EXCEPTION 'provider_accounts_environment_check missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'provider_accounts_connection_status_check'
          AND conrelid = 'provider.provider_accounts'::regclass
    ) THEN
        RAISE EXCEPTION 'provider_accounts_connection_status_check missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'provider_accounts_version_check'
          AND conrelid = 'provider.provider_accounts'::regclass
    ) THEN
        RAISE EXCEPTION 'provider_accounts_version_check missing';
    END IF;

    -- Partial unique: one live binding per (tenant, provider, environment).
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'provider'
          AND tablename = 'provider_accounts'
          AND indexname = 'provider_accounts_tenant_provider_env_uniq'
    ) THEN
        RAISE EXCEPTION 'provider_accounts_tenant_provider_env_uniq missing';
    END IF;
    SELECT indexdef INTO v_pred FROM pg_indexes
    WHERE schemaname = 'provider'
      AND tablename = 'provider_accounts'
      AND indexname = 'provider_accounts_tenant_provider_env_uniq';
    IF v_pred NOT ILIKE '%DISABLED%' THEN
        RAISE EXCEPTION 'partial unique index must exclude DISABLED rows, saw: %', v_pred;
    END IF;

    -- No GRANT to PUBLIC; outbox roles hold nothing (050 boundary).
    IF EXISTS (
        SELECT 1 FROM pg_class AS c, aclexplode(c.relacl) AS a
        WHERE c.oid = 'provider.provider_accounts'::regclass
        AND a.grantee = 0
    ) THEN
        RAISE EXCEPTION 'provider.provider_accounts is still granted to PUBLIC';
    END IF;
    IF has_table_privilege('outbox_worker', 'provider.provider_accounts', 'SELECT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_worker', 'provider.provider_accounts', 'INSERT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_worker', 'provider.provider_accounts', 'UPDATE') IS DISTINCT FROM false
        OR has_table_privilege('outbox_worker', 'provider.provider_accounts', 'DELETE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_worker must hold no privilege on provider.provider_accounts (050 EXECUTE-only boundary)';
    END IF;
    IF has_table_privilege('outbox_executor', 'provider.provider_accounts', 'SELECT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_executor', 'provider.provider_accounts', 'INSERT') IS DISTINCT FROM false
        OR has_table_privilege('outbox_executor', 'provider.provider_accounts', 'UPDATE') IS DISTINCT FROM false
        OR has_table_privilege('outbox_executor', 'provider.provider_accounts', 'DELETE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'outbox_executor must hold no privilege on provider.provider_accounts (050 EXECUTE-only boundary)';
    END IF;
    RAISE NOTICE 'preconditions OK: S1 columns + CHECKs + partial unique + RLS/tenant_isolation + DML, no PUBLIC, outbox boundary kept';
END $$;

-- 2) Fixture: two tenants sharing one GLOBAL provider row, one SANDBOX
-- account each (owner inserts, pre-065 column shape + explicit S1 fields).
CREATE TEMP TABLE s1_binding_ids (ta uuid, tb uuid, prov uuid, acca uuid, accb uuid);

DO $$
DECLARE
    ta uuid; tb uuid; prov uuid; acca uuid; accb uuid;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('s1-bind-a-' || gen_random_uuid(), 'S1 Binding A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('s1-bind-b-' || gen_random_uuid(), 'S1 Binding B') RETURNING id INTO tb;
    INSERT INTO provider.providers (provider_key, name, provider_type)
    VALUES ('s1-bind-' || gen_random_uuid(), 'S1 binding provider', 'IPTV') RETURNING id INTO prov;
    INSERT INTO provider.provider_accounts
        (tenant_id, provider_id, name, secret_ref, environment, connection_status, version)
    VALUES (ta, prov, 'S1 account A', 'infisical://sandbox/s1-a/KEY', 'SANDBOX', 'DRAFT', 1)
    RETURNING id INTO acca;
    INSERT INTO provider.provider_accounts
        (tenant_id, provider_id, name, secret_ref, environment, connection_status, last_checked_at, last_error_code, version)
    VALUES (tb, prov, 'S1 account B', 'infisical://sandbox/s1-b/KEY', 'SANDBOX', 'CONNECTED_READ_ONLY', now(), NULL, 1)
    RETURNING id INTO accb;
    INSERT INTO s1_binding_ids VALUES (ta, tb, prov, acca, accb);
    RAISE NOTICE 's1 fixture ready: tenants % / %, provider %, accounts % / %', ta, tb, prov, acca, accb;
END $$;

-- 3) Defaults: a legacy-shaped INSERT (no S1 columns) lands fail-closed
-- (NOT_CONFIGURED / SANDBOX / version 1 / NULL health fields), then the
-- migration backfill shape (UPDATE ... WHERE still default) promotes it to
-- REAUTH_REQUIRED without touching explicitly set rows.
DO $$
DECLARE
    ta uuid;
    prov uuid;
    prov_legacy uuid;
    scratch uuid;
    st text;
    env text;
    ver integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.prov INTO ta, prov FROM s1_binding_ids s LIMIT 1;
    -- Separate provider: the fixture already holds (ta, prov, SANDBOX),
    -- and the partial unique index must refuse a second live key there.
    INSERT INTO provider.providers (provider_key, name, provider_type)
    VALUES ('s1-legacy-' || gen_random_uuid(), 'S1 legacy provider', 'IPTV')
    RETURNING id INTO prov_legacy;
    INSERT INTO provider.provider_accounts (tenant_id, provider_id, name, secret_ref)
    VALUES (ta, prov_legacy, 'S1 legacy scratch', 'infisical://sandbox/s1-legacy/KEY')
    RETURNING id INTO scratch;
    SELECT connection_status, environment, version
      INTO st, env, ver
      FROM provider.provider_accounts WHERE id = scratch;
    IF st <> 'NOT_CONFIGURED' OR env <> 'SANDBOX' OR ver <> 1 THEN
        RAISE EXCEPTION 'legacy-shaped row must default to NOT_CONFIGURED/SANDBOX/v1, saw %/%/%', st, env, ver;
    END IF;
    -- Migration 065 backfill shape: only still-default rows are promoted.
    UPDATE provider.provider_accounts SET connection_status = 'REAUTH_REQUIRED'
    WHERE connection_status = 'NOT_CONFIGURED';
    SELECT connection_status INTO st FROM provider.provider_accounts
    WHERE tenant_id = ta AND name = 'S1 account A';
    IF st <> 'DRAFT' THEN
        RAISE EXCEPTION 'backfill must not touch explicitly set rows, saw %', st;
    END IF;
    SELECT connection_status INTO st FROM provider.provider_accounts WHERE id = scratch;
    IF st <> 'REAUTH_REQUIRED' THEN
        RAISE EXCEPTION 'backfill must promote still-default rows to REAUTH_REQUIRED, saw %', st;
    END IF;
    DELETE FROM provider.provider_accounts WHERE id = scratch;
    RAISE NOTICE 'defaults+backfill OK: legacy shape fail-closed, backfill promotes only still-default rows';
END $$;

-- 4) State-machine guards: unknown environment / connection_status and
-- version < 1 are rejected; blank last_error_code is rejected.
DO $$
DECLARE
    ta uuid;
    prov uuid;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.prov INTO ta, prov FROM s1_binding_ids s LIMIT 1;
    -- Each refusal probe uses a key no other live row holds, so the
    -- CHECK (not the partial unique index) is what refuses it.
    BEGIN
        INSERT INTO provider.provider_accounts (tenant_id, provider_id, name, secret_ref, environment)
        VALUES (ta, prov, 'S1 bad env', 'infisical://sandbox/s1-x/KEY', 'HOMOLOG');
        RAISE EXCEPTION 'expected bad environment to fail the CHECK';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO provider.provider_accounts (tenant_id, provider_id, name, secret_ref, environment, connection_status)
        VALUES (ta, prov, 'S1 bad status', 'infisical://sandbox/s1-x/KEY', 'PRODUCTION', 'CONNECTED_WRITER');
        RAISE EXCEPTION 'expected bad connection_status to fail the CHECK';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO provider.provider_accounts (tenant_id, provider_id, name, secret_ref, environment, version)
        VALUES (ta, prov, 'S1 bad version', 'infisical://sandbox/s1-x/KEY', 'PRODUCTION', 0);
        RAISE EXCEPTION 'expected version 0 to fail the CHECK';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO provider.provider_accounts (tenant_id, provider_id, name, secret_ref, environment, last_error_code)
        VALUES (ta, prov, 'S1 blank code', 'infisical://sandbox/s1-x/KEY', 'PRODUCTION', '   ');
        RAISE EXCEPTION 'expected blank last_error_code to fail the CHECK';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    -- Every canonical status inserts cleanly (one live key each; scratch
    -- rows removed after).
    INSERT INTO provider.providers (provider_key, name, provider_type)
    SELECT 's1-canon-' || gen_random_uuid(), 'S1 canon provider ' || gs, 'IPTV'
    FROM (VALUES ('TESTING'), ('DEGRADED'), ('DISABLED')) AS t(gs);
    INSERT INTO provider.provider_accounts (tenant_id, provider_id, name, secret_ref, environment, connection_status)
    SELECT ta, p.id, 'S1 canonical ' || p.name, 'infisical://sandbox/s1-canon/KEY', 'PRODUCTION', s.st
    FROM provider.providers p
    JOIN (VALUES ('S1 canon provider TESTING', 'TESTING'),
                 ('S1 canon provider DEGRADED', 'DEGRADED'),
                 ('S1 canon provider DISABLED', 'DISABLED')) AS s(pname, st)
      ON s.pname = p.name;
    DELETE FROM provider.provider_accounts WHERE name LIKE 'S1 canonical %';
    DELETE FROM provider.providers WHERE name LIKE 'S1 canon provider %';
    RAISE NOTICE 'state-machine guards OK: bad env/status/version/code refused, canonical statuses land';
END $$;

-- 5) Partial uniqueness: a second live (tenant, provider, environment)
-- binding is refused; DISABLED history does not block a fresh binding.
DO $$
DECLARE
    ta uuid;
    prov uuid;
    first uuid;
    second uuid;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.prov, s.acca INTO ta, prov, first FROM s1_binding_ids s LIMIT 1;
    BEGIN
        INSERT INTO provider.provider_accounts (tenant_id, provider_id, name, secret_ref, environment)
        VALUES (ta, prov, 'S1 duplicate live', 'infisical://sandbox/s1-dup/KEY', 'SANDBOX');
        RAISE EXCEPTION 'expected duplicate live binding to fail the partial unique index';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    -- A second environment for the same (tenant, provider) is allowed.
    INSERT INTO provider.provider_accounts
        (tenant_id, provider_id, name, secret_ref, environment, connection_status)
    VALUES (ta, prov, 'S1 prod binding', 'infisical://production/s1-p/KEY', 'PRODUCTION', 'DRAFT')
    RETURNING id INTO second;
    DELETE FROM provider.provider_accounts WHERE id = second;
    -- Disable the live row: history stays, and a fresh SANDBOX binding
    -- lands without colliding with the DISABLED row.
    UPDATE provider.provider_accounts SET connection_status = 'DISABLED' WHERE id = first;
    INSERT INTO provider.provider_accounts
        (tenant_id, provider_id, name, secret_ref, environment, connection_status)
    VALUES (ta, prov, 'S1 rebound binding', 'infisical://sandbox/s1-r/KEY', 'SANDBOX', 'DRAFT')
    RETURNING id INTO second;
    DELETE FROM provider.provider_accounts WHERE id = second;
    UPDATE provider.provider_accounts SET connection_status = 'DRAFT' WHERE id = first;
    RAISE NOTICE 'partial uniqueness OK: live duplicate refused, PRODUCTION env independent, DISABLED history non-blocking';
END $$;

-- 6) Tenant A context sees ONLY tenant A bindings (new columns visible);
-- cross-tenant read returns 0 rows.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
    st text;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM s1_binding_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM provider.provider_accounts;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'tenant A app role must see exactly 1 binding, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM provider.provider_accounts WHERE tenant_id = tb;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'cross-tenant binding read must return 0 rows, saw %', n_other;
    END IF;
    SELECT connection_status INTO st FROM provider.provider_accounts;
    IF st <> 'DRAFT' THEN
        RAISE EXCEPTION 'tenant A must see its DRAFT binding, saw %', st;
    END IF;
    RAISE NOTICE 'tenant A isolation OK: 1 own binding, 0 cross-tenant rows';
END $$;

-- 7) Tenant B context sees ONLY tenant B bindings (incl. health columns).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n_all integer;
    n_other integer;
    checked timestamptz;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM s1_binding_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', tb::text);
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n_all FROM provider.provider_accounts;
    IF n_all <> 1 THEN
        RAISE EXCEPTION 'tenant B app role must see exactly 1 binding, saw %', n_all;
    END IF;
    SELECT count(*) INTO n_other FROM provider.provider_accounts WHERE tenant_id = ta;
    IF n_other <> 0 THEN
        RAISE EXCEPTION 'cross-tenant binding read must return 0 rows, saw %', n_other;
    END IF;
    SELECT last_checked_at INTO checked FROM provider.provider_accounts;
    IF checked IS NULL THEN
        RAISE EXCEPTION 'tenant B must see its last_checked_at health column';
    END IF;
    RAISE NOTICE 'tenant B isolation OK: 1 own binding, 0 cross-tenant rows';
END $$;

-- 8) Write path as tenant A: own INSERT/UPDATE/DELETE; cross-tenant
-- UPDATE/DELETE touch 0 rows; tenant_id rewrite and cross-tenant INSERT
-- rejected (WITH CHECK => 42501).
DO $$
DECLARE
    ta uuid;
    tb uuid;
    prov uuid;
    accb uuid;
    scratch uuid;
    affected integer;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.prov, s.accb INTO ta, tb, prov, accb FROM s1_binding_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;
    INSERT INTO provider.provider_accounts
        (tenant_id, provider_id, name, secret_ref, environment, connection_status)
    VALUES (ta, prov, 'S1 scratch', 'infisical://production/s1-s/KEY', 'PRODUCTION', 'TESTING')
    RETURNING id INTO scratch;
    SELECT count(*) INTO n FROM provider.provider_accounts WHERE id = scratch;
    IF n <> 1 THEN
        RAISE EXCEPTION 'own binding INSERT must be visible, saw % rows', n;
    END IF;
    UPDATE provider.provider_accounts
    SET connection_status = 'DRAFT', last_error_code = 'INVALID_CREDENTIALS'
    WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own binding UPDATE must affect 1 row, affected %', affected;
    END IF;
    UPDATE provider.provider_accounts SET connection_status = 'DISABLED' WHERE id = accb;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'cross-tenant binding UPDATE must touch 0 rows, touched %', affected;
    END IF;
    DELETE FROM provider.provider_accounts WHERE id = accb;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'cross-tenant binding DELETE must touch 0 rows, touched %', affected;
    END IF;
    BEGIN
        UPDATE provider.provider_accounts SET tenant_id = tb WHERE name = 'S1 account A';
        RAISE EXCEPTION 'expected tenant_id rewrite to fail WITH CHECK';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO provider.provider_accounts (tenant_id, provider_id, name, secret_ref)
        VALUES (tb, prov, 'S1 cross insert', 'infisical://sandbox/s1-x/KEY');
        RAISE EXCEPTION 'expected cross-tenant binding INSERT to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    DELETE FROM provider.provider_accounts WHERE id = scratch;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'own scratch binding DELETE must affect 1 row, affected %', affected;
    END IF;
    RAISE NOTICE 'write path OK: own CRUD lands, cross-tenant filtered, rewrite + cross-tenant INSERT rejected (42501)';
END $$;

-- 9) Fail-closed: app role with NO tenant context sees nothing and cannot insert.
DO $$
DECLARE
    ta uuid;
    prov uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.prov INTO ta, prov FROM s1_binding_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM provider.provider_accounts;
    IF n <> 0 THEN
        RAISE EXCEPTION 'app role without tenant context must see 0 bindings, saw %', n;
    END IF;
    BEGIN
        INSERT INTO provider.provider_accounts (tenant_id, provider_id, name, secret_ref)
        VALUES (ta, prov, 'S1 no-context', 'infisical://sandbox/s1-x/KEY');
        RAISE EXCEPTION 'expected no-context binding INSERT to fail WITH CHECK';
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
    SELECT s.ta, s.tb INTO ta, tb FROM s1_binding_ids s LIMIT 1;
    SELECT count(*) INTO n FROM provider.provider_accounts WHERE tenant_id IN (ta, tb);
    IF n <> 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see 2 S1 bindings, saw %', n;
    END IF;
    RAISE NOTICE 'owner bypass OK: superuser sees all tenants (BYPASSRLS)';
END $$;

ROLLBACK;
