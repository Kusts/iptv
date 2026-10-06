-- 013 Control membership resolvers (migration 049).
-- Proves the three 043-shaped resolvers let `iptv_app` perform the exact
-- pre-context membership reads (login/resolveSession via session hash, tenant
-- switch via active check, PermissionsGuard via one role-resolution call)
-- with NO tenant context set, while the direct table reads on the now
-- RLS-enrolled `control.tenant_memberships` / `control.membership_roles`
-- stay fail-closed and the functions leak nothing else.
-- Asserts: EXECUTE granted to iptv_app / revoked from PUBLIC, SECURITY
-- DEFINER with pinned `search_path`, narrow bodies (control membership graph
-- only), switch/guard ACTIVE-only semantics (the session-bound listing keeps
-- FULL-status parity with the pre-049 read; user-ACTIVE gating on the
-- user_id-keyed functions), unknown-or-expired token -> 0 rows,
-- per-session/per-tenant containment, policy-expression pins on both tables,
-- enrolled-policy isolation sample on BOTH tables (own rows visible with
-- context, no-context fail-closed, cross-tenant writes blocked — 42501, plus
-- the pre-existing 012 trigger firing first on membership_roles), owner
-- bypass, and a login->switch->guarded-request rehearsal as `iptv_app`.
-- Fixture rows ROLLBACK; functions/policies/grants persist.
-- Execute: cat file | docker exec -i iptv-postgres-1 psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
-- (006/007/008/009/012 serve as regression: run all six.)
\set ON_ERROR_STOP on
BEGIN;

-- 1) Migration 049 preconditions: function shape, security, grants, enrollment.
DO $$
DECLARE
    v_secdef boolean;
    v_config text[];
    v_src text;
    v_qual text;
    v_check text;
    fn text;
    fns text[] := ARRAY[
        'control.list_memberships_for_session(text)',
        'control.check_membership_active(uuid, uuid)',
        'control.resolve_membership_roles(uuid, uuid)'
    ];
BEGIN
    FOREACH fn IN ARRAY fns LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_proc p
            WHERE p.oid = fn::regprocedure
        ) THEN
            RAISE EXCEPTION 'migration 049 not applied: % is missing', fn;
        END IF;
        SELECT p.prosecdef, p.proconfig INTO v_secdef, v_config
        FROM pg_proc p
        WHERE p.oid = fn::regprocedure;
        IF v_secdef IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'resolver % must be SECURITY DEFINER', fn;
        END IF;
        IF v_config IS NULL OR NOT EXISTS (
            SELECT 1 FROM unnest(v_config) g WHERE g = 'search_path=control, pg_temp'
        ) THEN
            RAISE EXCEPTION 'resolver % must pin search_path to control, pg_temp (saw %)', fn, v_config;
        END IF;
        -- PUBLIC EXECUTE appears in proacl as a bare "=X/grantor" entry
        -- (after "{" or ","); role grants look like "name=X/grantor".
        IF EXISTS (
            SELECT 1 FROM pg_proc p
            WHERE p.oid = fn::regprocedure
              AND (p.proacl::text LIKE '{=X/%' OR p.proacl::text LIKE '%,=X/%')
        ) THEN
            RAISE EXCEPTION 'resolver % must be revoked from PUBLIC (no public EXECUTE in proacl)', fn;
        END IF;
        IF has_function_privilege('iptv_app', fn, 'EXECUTE') IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'iptv_app must have EXECUTE on %', fn;
        END IF;
        SELECT pg_get_functiondef(fn::regprocedure) INTO v_src;
        IF v_src ILIKE '%billing.%' OR v_src ILIKE '%platform.%'
            OR v_src ILIKE '%crm.%' OR v_src ILIKE '%finance.%'
            OR v_src ILIKE '%identity.%' OR v_src ILIKE '%communication.%'
            OR v_src ILIKE '%partners.%' OR v_src ILIKE '%support.%'
            OR v_src ILIKE '%knowledge.%' OR v_src ILIKE '%agent.%' THEN
            RAISE EXCEPTION 'resolver % body must not reference tables outside the control membership graph', fn;
        END IF;
        IF v_src NOT ILIKE '%control.tenant_memberships%' THEN
            RAISE EXCEPTION 'resolver % body must read control.tenant_memberships', fn;
        END IF;
        RAISE NOTICE 'resolver OK: % (secdef, pinned search_path, iptv_app-only EXECUTE, narrow body)', fn;
    END LOOP;
    FOREACH fn IN ARRAY ARRAY['control.tenant_memberships', 'control.membership_roles'] LOOP
        IF (SELECT relrowsecurity FROM pg_class WHERE oid = fn::regclass) IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'RLS is not enabled on %', fn;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'control'
              AND tablename = split_part(fn, '.', 2)
              AND policyname = 'tenant_isolation'
        ) THEN
            RAISE EXCEPTION 'tenant_isolation policy missing on %', fn;
        END IF;
    END LOOP;
    RAISE NOTICE 'enrollment OK: tenant_memberships + membership_roles carry RLS + tenant_isolation';
    -- Policy-expression pin (ownOnly template, same style as the
    -- feature_flags assertions in 012): USING and WITH CHECK must match the
    -- fail-closed nullif(current_setting('app.tenant_id', ...))::uuid shape.
    FOREACH fn IN ARRAY ARRAY['tenant_memberships', 'membership_roles'] LOOP
        SELECT p.qual, p.with_check INTO v_qual, v_check
        FROM pg_policies p
        WHERE p.schemaname = 'control'
          AND p.tablename = fn
          AND p.policyname = 'tenant_isolation';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'tenant_isolation policy missing on control.%', fn;
        END IF;
        IF v_qual IS NULL OR v_qual NOT LIKE '%tenant_id =%NULLIF%current_setting(''app.tenant_id''%' THEN
            RAISE EXCEPTION 'control.% tenant_isolation USING must match the nullif(current_setting(''app.tenant_id'')) template (saw %)', fn, v_qual;
        END IF;
        IF v_check IS NULL OR v_check NOT LIKE '%tenant_id =%NULLIF%current_setting(''app.tenant_id''%' THEN
            RAISE EXCEPTION 'control.% tenant_isolation WITH CHECK must match the nullif(current_setting(''app.tenant_id'')) template (saw %)', fn, v_check;
        END IF;
        RAISE NOTICE 'policy expression OK: control.% tenant_isolation matches the plain tenant template', fn;
    END LOOP;
END $$;

-- 2) Fixture (as owner): two tenants, three ACTIVE users plus one SUSPENDED
-- user, one valid session per ACTIVE user plus one EXPIRED session, ACTIVE +
-- SUSPENDED memberships (incl. an ACTIVE membership held by the SUSPENDED
-- user), one extra role binding on tenant A.
CREATE TEMP TABLE member_ids (
    ta uuid, tb uuid, ua uuid, ub uuid, uc uuid, ud uuid,
    ma uuid, mb_suspended uuid, mb uuid, md uuid,
    hash_a text, hash_a_expired text, hash_b text, hash_unknown text
);

DO $$
DECLARE
    ta uuid;
    tb uuid;
    ua uuid;
    ub uuid;
    uc uuid;
    ud uuid;
    ma uuid;
    mbs uuid;
    mb uuid;
    md uuid;
    mra uuid;
    sa uuid;
    sae uuid;
    sb uuid;
    ha text;
    hae text;
    hb text;
BEGIN
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-mem-a-' || gen_random_uuid(), 'RLS Membership A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name)
    VALUES ('rls-mem-b-' || gen_random_uuid(), 'RLS Membership B') RETURNING id INTO tb;
    INSERT INTO control.users (auth_subject, display_name, status)
    VALUES ('email:mem-a@example.com', 'Mem A', 'ACTIVE') RETURNING id INTO ua;
    INSERT INTO control.users (auth_subject, display_name, status)
    VALUES ('email:mem-b@example.com', 'Mem B', 'ACTIVE') RETURNING id INTO ub;
    INSERT INTO control.users (auth_subject, display_name, status)
    VALUES ('email:mem-c@example.com', 'Mem C', 'ACTIVE') RETURNING id INTO uc;
    INSERT INTO control.users (auth_subject, display_name, status)
    VALUES ('email:mem-d@example.com', 'Mem D', 'SUSPENDED') RETURNING id INTO ud;
    -- uA: ACTIVE in A (+ extra tenant_admin binding), SUSPENDED in B.
    INSERT INTO control.tenant_memberships (tenant_id, user_id, role_key, status)
    VALUES (ta, ua, 'tenant_owner', 'ACTIVE') RETURNING id INTO ma;
    INSERT INTO control.tenant_memberships (tenant_id, user_id, role_key, status)
    VALUES (tb, ua, 'tenant_operator', 'SUSPENDED') RETURNING id INTO mbs;
    -- uB: ACTIVE in B, no extra bindings.
    INSERT INTO control.tenant_memberships (tenant_id, user_id, role_key, status)
    VALUES (tb, ub, 'tenant_operator', 'ACTIVE') RETURNING id INTO mb;
    -- uD: SUSPENDED user holding an ACTIVE membership in A (F3 pin: the
    -- user_id-keyed resolvers must still read inactive via user-ACTIVE gating).
    INSERT INTO control.tenant_memberships (tenant_id, user_id, role_key, status)
    VALUES (ta, ud, 'tenant_operator', 'ACTIVE') RETURNING id INTO md;
    INSERT INTO control.membership_roles (tenant_id, membership_id, role_key)
    VALUES (ta, ma, 'tenant_admin') RETURNING id INTO mra;
    -- Sessions: valid A, EXPIRED A, valid B. Hashes are opaque fixtures here
    -- (the app stores sha256(secret:token); the resolver only compares).
    ha := 'mem-hash-a-' || gen_random_uuid();
    hae := 'mem-hash-a-expired-' || gen_random_uuid();
    hb := 'mem-hash-b-' || gen_random_uuid();
    INSERT INTO control.auth_sessions (user_id, token_hash, active_tenant_id, expires_at)
    VALUES (ua, ha, ta, now() + interval '1 day') RETURNING id INTO sa;
    INSERT INTO control.auth_sessions (user_id, token_hash, active_tenant_id, expires_at)
    VALUES (ua, hae, ta, now() - interval '1 hour') RETURNING id INTO sae;
    INSERT INTO control.auth_sessions (user_id, token_hash, active_tenant_id, expires_at)
    VALUES (ub, hb, tb, now() + interval '1 day') RETURNING id INTO sb;
    INSERT INTO member_ids (ta, tb, ua, ub, uc, ud, ma, mb_suspended, mb, md, hash_a, hash_a_expired, hash_b, hash_unknown)
    VALUES (ta, tb, ua, ub, uc, ud, ma, mbs, mb, md, ha, hae, hb, 'mem-hash-unknown-' || gen_random_uuid());
    RAISE NOTICE 'membership fixture ready: tenants % / %, users % / % / %', ta, tb, ua, ub, uc;
END $$;

-- 3) As iptv_app with NO tenant context: the session resolver returns ALL
-- session-bound memberships (F4 parity with the pre-049 auth.listMemberships,
-- whose rows carried non-ACTIVE statuses; ACTIVE-filtering lives at the login
-- call site), while the direct table read stays fail-closed.
DO $$
DECLARE
    ha text;
    ta uuid;
    tb uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.hash_a, s.ta, s.tb INTO ha, ta, tb FROM member_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM control.list_memberships_for_session(ha);
    IF n <> 2 THEN
        RAISE EXCEPTION 'session resolver must return both session-bound memberships (ACTIVE + SUSPENDED), saw %', n;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM control.list_memberships_for_session(ha)
        WHERE tenant_id = ta AND role_key = 'tenant_owner' AND status = 'ACTIVE'
          AND tenant_slug IS NOT NULL AND tenant_name IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'session resolver must include the ACTIVE membership payload with tenant slug and name';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM control.list_memberships_for_session(ha)
        WHERE tenant_id = tb AND status = 'SUSPENDED'
    ) THEN
        RAISE EXCEPTION 'session resolver must include the SUSPENDED membership row (F4 parity with the pre-049 read)';
    END IF;
    SELECT count(*) INTO n FROM control.tenant_memberships;
    IF n <> 0 THEN
        RAISE EXCEPTION 'direct membership read without context must stay fail-closed (0 rows), saw %', n;
    END IF;
    SELECT count(*) INTO n FROM control.membership_roles;
    IF n <> 0 THEN
        RAISE EXCEPTION 'direct membership_roles read without context must stay fail-closed (0 rows), saw %', n;
    END IF;
    RAISE NOTICE 'pre-context list OK: resolver returns ALL session-bound memberships, direct reads stay 0 rows';
END $$;

-- 4) Unknown and expired tokens resolve to 0 rows (fail-closed login path).
DO $$
DECLARE
    hae text;
    hu text;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.hash_a_expired, s.hash_unknown INTO hae, hu FROM member_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    SELECT count(*) INTO n FROM control.list_memberships_for_session(hae);
    IF n <> 0 THEN
        RAISE EXCEPTION 'expired session must resolve to 0 memberships, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM control.list_memberships_for_session(hu);
    IF n <> 0 THEN
        RAISE EXCEPTION 'unknown token must resolve to 0 memberships, saw %', n;
    END IF;
    RAISE NOTICE 'negative paths OK: expired and unknown tokens resolve to 0 rows';
END $$;

-- 5) Per-session/per-tenant containment: session B yields only tenant B rows.
DO $$
DECLARE
    hb text;
    ta uuid;
    tb uuid;
    r record;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.hash_b, s.ta, s.tb INTO hb, ta, tb FROM member_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    SELECT * INTO r FROM control.list_memberships_for_session(hb);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'session B must resolve to its own membership';
    END IF;
    IF r.tenant_id IS DISTINCT FROM tb THEN
        RAISE EXCEPTION 'session B resolved to wrong tenant: % (expected %)', r.tenant_id, tb;
    END IF;
    IF r.tenant_id = ta THEN
        RAISE EXCEPTION 'resolver leaked across tenants';
    END IF;
    RAISE NOTICE 'containment OK: each session resolves to exactly its own ACTIVE memberships';
END $$;

-- 6) Switch check matrix via control.check_membership_active (ACTIVE
-- membership AND ACTIVE user).
DO $$
DECLARE
    ua uuid;
    ub uuid;
    ud uuid;
    ta uuid;
    tb uuid;
    ok boolean;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ua, s.ub, s.ud, s.ta, s.tb INTO ua, ub, ud, ta, tb FROM member_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    SELECT control.check_membership_active(ua, ta) INTO ok;
    IF ok IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'uA must be ACTIVE in tenant A';
    END IF;
    SELECT control.check_membership_active(ua, tb) INTO ok;
    IF ok IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'uA SUSPENDED membership in tenant B must read as inactive';
    END IF;
    SELECT control.check_membership_active(ub, ta) INTO ok;
    IF ok IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'uB must read as inactive in tenant A';
    END IF;
    SELECT control.check_membership_active(ub, tb) INTO ok;
    IF ok IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'uB must be ACTIVE in tenant B';
    END IF;
    SELECT control.check_membership_active(gen_random_uuid(), ta) INTO ok;
    IF ok IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'unknown user must read as inactive';
    END IF;
    -- F3 pin: a SUSPENDED user holding an ACTIVE membership still reads as
    -- inactive (user-ACTIVE gating at the DB layer).
    SELECT control.check_membership_active(ud, ta) INTO ok;
    IF ok IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'SUSPENDED user with an ACTIVE membership must read as inactive';
    END IF;
    SELECT control.check_membership_active(ua, gen_random_uuid()) INTO ok;
    IF ok IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'nonexistent tenant must read as inactive';
    END IF;
    RAISE NOTICE 'switch-check OK: ACTIVE-membership AND ACTIVE-user matrix incl. SUSPENDED=false';
END $$;

-- 7) Guard resolution matrix via control.resolve_membership_roles (one row:
-- base role + extras array; zero rows without an ACTIVE membership).
DO $$
DECLARE
    ua uuid;
    ub uuid;
    ud uuid;
    ta uuid;
    tb uuid;
    ma uuid;
    r record;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ua, s.ub, s.ud, s.ta, s.tb, s.ma INTO ua, ub, ud, ta, tb, ma FROM member_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    SELECT * INTO r FROM control.resolve_membership_roles(ua, ta);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'uA must resolve roles in tenant A';
    END IF;
    IF r.membership_id IS DISTINCT FROM ma THEN
        RAISE EXCEPTION 'guard resolver returned wrong membership id';
    END IF;
    IF r.base_role_key IS DISTINCT FROM 'tenant_owner' THEN
        RAISE EXCEPTION 'guard resolver returned wrong base role: %', r.base_role_key;
    END IF;
    IF NOT (r.extra_role_keys @> ARRAY['tenant_admin']) THEN
        RAISE EXCEPTION 'guard resolver must include the tenant_admin extra binding (saw %)', r.extra_role_keys;
    END IF;
    SELECT count(*) INTO n FROM control.resolve_membership_roles(ua, tb);
    IF n <> 0 THEN
        RAISE EXCEPTION 'SUSPENDED membership must resolve to 0 role rows, saw %', n;
    END IF;
    SELECT * INTO r FROM control.resolve_membership_roles(ub, tb);
    IF NOT FOUND OR r.base_role_key IS DISTINCT FROM 'tenant_operator' THEN
        RAISE EXCEPTION 'uB must resolve its base role in tenant B';
    END IF;
    IF coalesce(array_length(r.extra_role_keys, 1), 0) <> 0 THEN
        RAISE EXCEPTION 'uB has no extra bindings; expected an empty array';
    END IF;
    -- F3 pin: a SUSPENDED user holding an ACTIVE membership resolves to 0
    -- role rows (user-ACTIVE gating at the DB layer).
    SELECT count(*) INTO n FROM control.resolve_membership_roles(ud, ta);
    IF n <> 0 THEN
        RAISE EXCEPTION 'SUSPENDED user with an ACTIVE membership must resolve to 0 role rows, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM control.resolve_membership_roles(ua, gen_random_uuid());
    IF n <> 0 THEN
        RAISE EXCEPTION 'nonexistent tenant must resolve to 0 role rows, saw %', n;
    END IF;
    RAISE NOTICE 'guard resolution OK: base + extras in one row, 0 rows without ACTIVE membership of an ACTIVE user';
END $$;

-- 8) Enrolled-policy isolation sample on BOTH tables as iptv_app: own rows
-- visible with context, cross-tenant writes blocked (42501 on
-- tenant_memberships, the pre-existing 012 trigger P0001 on
-- membership_roles), cross-tenant UPDATE/DELETE touch 0 rows.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    uc uuid;
    n integer;
    new_mid uuid;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb, s.uc INTO ta, tb, uc FROM member_ids s LIMIT 1;
    EXECUTE format('SET LOCAL app.tenant_id = %L', ta::text);
    SET LOCAL ROLE iptv_app;
    -- Own-context reads: tenant A sees its memberships, never B's.
    SELECT count(*) INTO n FROM control.tenant_memberships WHERE tenant_id = ta;
    IF n < 1 THEN
        RAISE EXCEPTION 'tenant A context must see its own memberships, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM control.tenant_memberships WHERE tenant_id = tb;
    IF n <> 0 THEN
        RAISE EXCEPTION 'cross-tenant membership read must return 0 rows, saw %', n;
    END IF;
    -- Own-tenant INSERT passes WITH CHECK (the provision-path shape).
    INSERT INTO control.tenant_memberships (tenant_id, user_id, role_key, status)
    VALUES (ta, uc, 'tenant_operator', 'ACTIVE') RETURNING id INTO new_mid;
    INSERT INTO control.membership_roles (tenant_id, membership_id, role_key)
    VALUES (ta, new_mid, 'tenant_admin');
    SELECT count(*) INTO n FROM control.membership_roles WHERE membership_id = new_mid;
    IF n <> 1 THEN
        RAISE EXCEPTION 'own-tenant role binding insert must be visible, saw %', n;
    END IF;
    -- Cross-tenant INSERTs fail. Defense-in-depth layering: the
    -- tenant_memberships probe is denied by RLS (WITH CHECK =>
    -- insufficient_privilege — no trigger there), while the membership_roles
    -- probe hits the PRE-EXISTING trigger
    -- control.enforce_membership_role_tenant() (migration 012) BEFORE RLS:
    -- SQLSTATE P0001 (raise_exception) with 'membership ... belongs to
    -- tenant ..., not ...'. Both fences hold.
    BEGIN
        INSERT INTO control.tenant_memberships (tenant_id, user_id, role_key, status)
        VALUES (tb, uc, 'tenant_operator', 'ACTIVE');
        RAISE EXCEPTION 'expected cross-tenant membership insert to fail';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO control.membership_roles (tenant_id, membership_id, role_key)
        VALUES (tb, new_mid, 'tenant_admin');
        RAISE EXCEPTION 'expected cross-tenant role binding insert to fail';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'membership % belongs to tenant %, not %' THEN
            RAISE;
        END IF;
    END;
    -- RLS filters UPDATE targets silently: cross-tenant UPDATE touches 0 rows.
    UPDATE control.tenant_memberships SET status = 'REVOKED' WHERE tenant_id = tb;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
        RAISE EXCEPTION 'cross-tenant membership UPDATE must touch 0 rows, touched %', n;
    END IF;
    -- RLS filters DELETE targets silently: cross-tenant DELETE touches 0 rows.
    DELETE FROM control.tenant_memberships WHERE tenant_id = tb;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
        RAISE EXCEPTION 'cross-tenant membership DELETE must touch 0 rows, touched %', n;
    END IF;
    DELETE FROM control.membership_roles WHERE tenant_id = tb;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
        RAISE EXCEPTION 'cross-tenant role binding DELETE must touch 0 rows, touched %', n;
    END IF;
    RAISE NOTICE 'enrolled isolation OK: own rows visible+writable, cross-tenant writes blocked';
END $$;

-- 9) Login->switch->guarded-request rehearsal as iptv_app (no context):
-- session-hash list (login), active check (switch), role resolution (guard).
DO $$
DECLARE
    ha text;
    ta uuid;
    ua uuid;
    ma uuid;
    r record;
    n integer;
    ok boolean;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.hash_a, s.ta, s.ua, s.ma INTO ha, ta, ua, ma FROM member_ids s LIMIT 1;
    SET LOCAL ROLE iptv_app;
    -- Login: memberships through the new session (F4 parity: ALL statuses
    -- session-bound, so uA's ACTIVE + SUSPENDED rows both list).
    SELECT count(*) INTO n FROM control.list_memberships_for_session(ha);
    IF n <> 2 THEN
        RAISE EXCEPTION 'rehearsal login must list both session-bound memberships, saw %', n;
    END IF;
    -- Switch: ACTIVE check for the discovered tenant.
    SELECT control.check_membership_active(ua, ta) INTO ok;
    IF ok IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'rehearsal switch must confirm the ACTIVE membership';
    END IF;
    -- Guarded request: one role-resolution call feeds the actor.
    SELECT * INTO r FROM control.resolve_membership_roles(ua, ta);
    IF NOT FOUND OR r.membership_id IS DISTINCT FROM ma THEN
        RAISE EXCEPTION 'rehearsal guard must resolve the active membership';
    END IF;
    RAISE NOTICE 'rehearsal OK: login->switch->guard resolves through the three functions';
END $$;

-- 10) Owner/superuser bypasses RLS: sees every membership regardless of context.
DO $$
DECLARE
    ta uuid;
    tb uuid;
    n integer;
BEGIN
    RESET ROLE;
    RESET app.tenant_id;
    SELECT s.ta, s.tb INTO ta, tb FROM member_ids s LIMIT 1;
    SELECT count(*) INTO n FROM control.tenant_memberships WHERE tenant_id = ta;
    IF n < 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see all tenant A memberships, saw %', n;
    END IF;
    SELECT count(*) INTO n FROM control.tenant_memberships WHERE tenant_id = tb;
    IF n < 2 THEN
        RAISE EXCEPTION 'owner must bypass RLS and see all tenant B memberships, saw %', n;
    END IF;
    RAISE NOTICE 'owner bypass OK: superuser sees all memberships (BYPASSRLS)';
END $$;

ROLLBACK;
