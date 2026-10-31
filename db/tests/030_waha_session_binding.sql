-- 030 WAHA per-tenant session binding (migration 067).
-- Proves the `communication.tenant_channels` session columns plus
-- `communication.resolve_waha_session_owner(text)`: the owner lookup lets
-- `iptv_app` map a WAHA session name to its tenant WITHOUT `app.tenant_id`
-- set (the cross-tenant check in `waha-session-store.ts` runs exactly
-- there), while the function leaks nothing else.
-- Asserts: new columns exist; partial UNIQUE on `waha_session_name`
-- (non-NULL only); function is SECURITY DEFINER with pinned search_path,
-- EXECUTE `iptv_app`-only (revoked from PUBLIC), narrow body (only
-- `communication.tenant_channels`), ACTIVE-only semantics, unknown/NULL
-- sessions → 0 rows; a second live binding of the same session name fails
-- loudly instead of sharing a session between tenants. Fixture rows
-- ROLLBACK; columns/index/function persist.
-- Execute: cat file | docker exec -i iptv-postgres-1 psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
-- (007/008/009/021 serve as regression: run all after this.)
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 067 preconditions: columns, partial unique, function shape.
DO $$
DECLARE
    v_secdef boolean;
    v_config text[];
    v_src text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'communication' AND table_name = 'tenant_channels'
          AND column_name = 'waha_session_name'
    ) THEN
        RAISE EXCEPTION 'migration 067 not applied: communication.tenant_channels.waha_session_name is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'communication' AND table_name = 'tenant_channels'
          AND column_name = 'waha_status'
    ) THEN
        RAISE EXCEPTION 'migration 067 not applied: communication.tenant_channels.waha_status is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'communication' AND tablename = 'tenant_channels'
          AND indexname = 'tenant_channels_waha_session_unique_idx'
    ) THEN
        RAISE EXCEPTION 'migration 067 not applied: partial unique index tenant_channels_waha_session_unique_idx is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'communication'
          AND p.proname = 'resolve_waha_session_owner'
    ) THEN
        RAISE EXCEPTION 'migration 067 not applied: communication.resolve_waha_session_owner(text) is missing';
    END IF;
    SELECT p.prosecdef, p.proconfig INTO v_secdef, v_config
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'communication' AND p.proname = 'resolve_waha_session_owner';
    IF v_secdef IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'owner lookup must be SECURITY DEFINER';
    END IF;
    IF v_config IS NULL OR NOT EXISTS (
        SELECT 1 FROM unnest(v_config) g WHERE g LIKE 'search_path=%'
    ) THEN
        RAISE EXCEPTION 'owner lookup must pin search_path (saw %)', v_config;
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'communication' AND p.proname = 'resolve_waha_session_owner'
          AND (p.proacl::text LIKE '{=X/%' OR p.proacl::text LIKE '%,=X/%')
    ) THEN
        RAISE EXCEPTION 'owner lookup must be revoked from PUBLIC (no public EXECUTE in proacl)';
    END IF;
    IF has_function_privilege('iptv_app', 'communication.resolve_waha_session_owner(text)', 'EXECUTE') IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'iptv_app must have EXECUTE on the owner lookup';
    END IF;
    SELECT pg_get_functiondef(
        (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'communication' AND p.proname = 'resolve_waha_session_owner')
    ) INTO v_src;
    IF v_src ILIKE '%billing.%' OR v_src ILIKE '%platform.%'
        OR v_src ILIKE '%crm.%' OR v_src ILIKE '%finance.%'
        OR v_src ILIKE '%identity.%' THEN
        RAISE EXCEPTION 'owner lookup body must not reference tables outside communication.tenant_channels';
    END IF;
    IF v_src NOT ILIKE '%communication.tenant_channels%' THEN
        RAISE EXCEPTION 'owner lookup body must read communication.tenant_channels';
    END IF;
    RAISE NOTICE 'owner lookup preconditions OK: columns + partial unique + SECURITY DEFINER, pinned search_path, EXECUTE iptv_app-only, narrow body';
END $$;

-- 2) Fixture: two tenants; A bound ACTIVE, B bound DISABLED (same-shape row,
-- different session), plus an unbound row.
CREATE TEMP TABLE binding_ids (ta uuid, tb uuid, sa text, sb text);

DO $$
DECLARE
    ta uuid;
    tb uuid;
    sa text;
    sb text;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-bind-a-' || gen_random_uuid(), 'RLS Binding A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-bind-b-' || gen_random_uuid(), 'RLS Binding B') RETURNING id INTO tb;
    sa := 'tenant-bind-a-' || substr(gen_random_uuid()::text, 1, 8);
    sb := 'tenant-bind-b-' || substr(gen_random_uuid()::text, 1, 8);
    INSERT INTO communication.tenant_channels
        (tenant_id, channel, tenant_key, webhook_secret_hash, status, waha_session_name, waha_status)
    VALUES
        (ta, 'WHATSAPP', 'bind-a-' || gen_random_uuid(), 'hash-a', 'ACTIVE', sa, 'WORKING'),
        (tb, 'WHATSAPP', 'bind-b-' || gen_random_uuid(), 'hash-b', 'DISABLED', sb, 'STOPPED'),
        (tb, 'WHATSAPP', 'bind-b-loose-' || gen_random_uuid(), 'hash-loose', 'ACTIVE', NULL, NULL);
    INSERT INTO binding_ids (ta, tb, sa, sb) VALUES (ta, tb, sa, sb);
    RAISE NOTICE 'binding fixture ready: A ACTIVE(%), B DISABLED(%)', sa, sb;
END $$;

-- 3) As iptv_app with NO tenant context: ACTIVE session resolves to its
-- tenant; DISABLED and unknown sessions resolve to 0 rows.
DO $$
DECLARE
    sa text;
    sb text;
    ta uuid;
    r record;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.sa, s.sb, s.ta INTO sa, sb, ta FROM binding_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    SELECT * INTO r FROM communication.resolve_waha_session_owner(sa);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'owner lookup must return the ACTIVE-bound tenant without tenant context';
    END IF;
    IF r.tenant_id IS DISTINCT FROM ta THEN
        RAISE EXCEPTION 'owner lookup returned wrong tenant: % (expected %)', r.tenant_id, ta;
    END IF;
    SELECT count(*) INTO n FROM communication.resolve_waha_session_owner(sb);
    IF n <> 0 THEN
        RAISE EXCEPTION 'DISABLED-bound session must resolve to 0 rows, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM communication.resolve_waha_session_owner('tenant-unknown-' || gen_random_uuid());
    IF n <> 0 THEN
        RAISE EXCEPTION 'unknown session must resolve to 0 rows, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM communication.resolve_waha_session_owner(NULL);
    IF n <> 0 THEN
        RAISE EXCEPTION 'NULL session must resolve to 0 rows, saw %', n;
    END IF;
    RAISE NOTICE 'owner lookup OK: ACTIVE resolves, DISABLED/unknown/NULL stay 0 rows';
END $$;

-- 4) Double-binding fails loudly: a second live row with the same session
-- name violates the partial unique index (no silent session sharing).
DO $$
DECLARE
    sa text;
    tb uuid;
BEGIN
    RESET ROLE;
    SELECT s.sa, s.tb INTO sa, tb FROM binding_ids s LIMIT 1;
    BEGIN
        INSERT INTO communication.tenant_channels
            (tenant_id, channel, tenant_key, webhook_secret_hash, status, waha_session_name, waha_status)
        VALUES (tb, 'WHATSAPP', 'bind-dup-' || gen_random_uuid(), 'hash-dup', 'ACTIVE', sa, 'WORKING');
        RAISE EXCEPTION 'double-binding the same session name must fail on the partial unique index';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'double-binding refused OK: partial unique index holds';
    END;
    -- NULL bindings never collide (unprovisioned tenants stay insertable).
    INSERT INTO communication.tenant_channels
        (tenant_id, channel, tenant_key, webhook_secret_hash, status, waha_session_name, waha_status)
    VALUES (tb, 'WHATSAPP', 'bind-null-' || gen_random_uuid(), 'hash-null', 'ACTIVE', NULL, NULL);
    RAISE NOTICE 'NULL bindings OK: unprovisioned rows never collide';
END $$;

ROLLBACK;
