-- 009 Pre-context channel resolver (migration 043).
-- Proves `communication.resolve_tenant_channel(text)` lets `iptv_app` map a
-- webhook routing key to its tenant WITHOUT `app.tenant_id` set (the exact
-- pre-context state `WahaWebhookService.resolveChannel` runs in), while the
-- direct table read stays fail-closed and the function leaks nothing else.
-- Asserts: EXECUTE granted to iptv_app / revoked from PUBLIC, SECURITY
-- DEFINER with restricted search_path, body touches only
-- `communication.tenant_channels`, ACTIVE-only semantics, unknown key →
-- 0 rows. Fixture rows ROLLBACK; function/grants persist.
-- Execute: cat file | docker exec -i iptv-postgres-1 psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
-- (007/008 serve as regression: run all three after this.)
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 043 preconditions: function shape, security, grants.
DO $$
DECLARE
    v_secdef boolean;
    v_config text[];
    v_src text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'communication'
          AND p.proname = 'resolve_tenant_channel'
    ) THEN
        RAISE EXCEPTION 'migration 043 not applied: communication.resolve_tenant_channel(text) is missing';
    END IF;
    SELECT p.prosecdef, p.proconfig INTO v_secdef, v_config
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'communication' AND p.proname = 'resolve_tenant_channel';
    IF v_secdef IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'resolver must be SECURITY DEFINER';
    END IF;
    IF v_config IS NULL OR NOT EXISTS (
        SELECT 1 FROM unnest(v_config) g WHERE g LIKE 'search_path=%'
    ) THEN
        RAISE EXCEPTION 'resolver must pin search_path (saw %) ', v_config;
    END IF;
    -- PUBLIC EXECUTE appears in proacl as a bare "=X/grantor" entry
-- (after "{" or ","); role grants look like "name=X/grantor".
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'communication' AND p.proname = 'resolve_tenant_channel'
          AND (p.proacl::text LIKE '{=X/%' OR p.proacl::text LIKE '%,=X/%')
    ) THEN
        RAISE EXCEPTION 'resolver must be revoked from PUBLIC (no public EXECUTE in proacl)';
    END IF;
    IF has_function_privilege('iptv_app', 'communication.resolve_tenant_channel(text)', 'EXECUTE') IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'iptv_app must have EXECUTE on the resolver';
    END IF;
    SELECT pg_get_functiondef(
        (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'communication' AND p.proname = 'resolve_tenant_channel')
    ) INTO v_src;
    IF v_src ILIKE '%billing.%' OR v_src ILIKE '%platform.%'
        OR v_src ILIKE '%crm.%' OR v_src ILIKE '%finance.%'
        OR v_src ILIKE '%identity.%' THEN
        RAISE EXCEPTION 'resolver body must not reference tables outside communication.tenant_channels';
    END IF;
    IF v_src NOT ILIKE '%communication.tenant_channels%' THEN
        RAISE EXCEPTION 'resolver body must read communication.tenant_channels';
    END IF;
    RAISE NOTICE 'resolver preconditions OK: SECURITY DEFINER, pinned search_path, EXECUTE iptv_app-only, narrow body';
END $$;

-- 2) Fixture: one tenant + ACTIVE channel + DISABLED channel (as owner).
CREATE TEMP TABLE resolver_ids (t uuid, active_key text, disabled_key text);

DO $$
DECLARE
    t uuid;
    p uuid;
    akey text;
    dkey text;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-res-a-' || gen_random_uuid(), 'RLS Resolver A') RETURNING id INTO t;
    INSERT INTO identity.persons (tenant_id) VALUES (t) RETURNING id INTO p;
    akey := 'res-active-' || gen_random_uuid();
    dkey := 'res-disabled-' || gen_random_uuid();
    INSERT INTO communication.tenant_channels (tenant_id, channel, tenant_key, webhook_secret_hash, status)
    VALUES (t, 'WHATSAPP', akey, 'hash-active', 'ACTIVE'),
           (t, 'WHATSAPP', dkey, 'hash-disabled', 'DISABLED');
    INSERT INTO resolver_ids (t, active_key, disabled_key) VALUES (t, akey, dkey);
    RAISE NOTICE 'resolver fixture ready: tenant %', t;
END $$;

-- 3) As iptv_app with NO tenant context: resolver returns the ACTIVE row,
-- while the direct table read stays fail-closed (0 rows).
DO $$
DECLARE
    akey text;
    t uuid;
    r record;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.t, s.active_key INTO t, akey FROM resolver_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    SELECT * INTO r FROM communication.resolve_tenant_channel(akey);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'resolver must return the ACTIVE channel without tenant context';
    END IF;
    IF r.tenant_id IS DISTINCT FROM t THEN
        RAISE EXCEPTION 'resolver returned wrong tenant: % (expected %)', r.tenant_id, t;
    END IF;
    IF r.channel IS DISTINCT FROM 'WHATSAPP' OR r.webhook_secret_hash IS DISTINCT FROM 'hash-active'
        OR r.status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'resolver returned wrong channel payload';
    END IF;
    SELECT count(*) INTO n FROM communication.tenant_channels;
    IF n <> 0 THEN
        RAISE EXCEPTION 'direct table read without context must stay fail-closed (0 rows), saw %', n;
    END IF;
    RAISE NOTICE 'pre-context lookup OK: function returns ACTIVE row, direct read stays 0 rows';
END $$;

-- 4) DISABLED key and unknown key return 0 rows through the function.
DO $$
DECLARE
    dkey text;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.disabled_key INTO dkey FROM resolver_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM communication.resolve_tenant_channel(dkey);
    IF n <> 0 THEN
        RAISE EXCEPTION 'DISABLED key must resolve to 0 rows, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM communication.resolve_tenant_channel('res-unknown-' || gen_random_uuid());
    IF n <> 0 THEN
        RAISE EXCEPTION 'unknown key must resolve to 0 rows, saw %', n;
    END IF;
    RAISE NOTICE 'negative paths OK: DISABLED and unknown keys resolve to 0 rows';
END $$;

-- 5) Cross-tenant containment: a second tenant's key resolves to ITS tenant only.
DO $$
DECLARE
    t2 uuid;
    p2 uuid;
    k2 text;
    r record;
    t1 uuid;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.t INTO t1 FROM resolver_ids s LIMIT 1;
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-res-b-' || gen_random_uuid(), 'RLS Resolver B') RETURNING id INTO t2;
    INSERT INTO identity.persons (tenant_id) VALUES (t2) RETURNING id INTO p2;
    k2 := 'res-b-' || gen_random_uuid();
    INSERT INTO communication.tenant_channels (tenant_id, channel, tenant_key, webhook_secret_hash, status)
    VALUES (t2, 'WHATSAPP', k2, 'hash-b', 'ACTIVE');
    SET LOCAL ROLE iptv_app;
    SELECT * INTO r FROM communication.resolve_tenant_channel(k2);
    IF NOT FOUND OR r.tenant_id IS DISTINCT FROM t2 THEN
        RAISE EXCEPTION 'second tenant key must resolve to its own tenant';
    END IF;
    IF r.tenant_id = t1 THEN
        RAISE EXCEPTION 'resolver leaked across tenants';
    END IF;
    RAISE NOTICE 'containment OK: each key resolves to exactly its own tenant';
END $$;

ROLLBACK;
