-- 051 Platform outbox runtime live-interlock (append-only; never edit 001-050).
--
-- Replaces the manual env-copied activation gate (P1 live-interlock declined
-- by scope in `apps/outbox-worker/src/activation.ts`) with a DATABASE
-- authority for who may publish:
--
--   LEGACY -> QUIESCING -> WORKER   (+ rollback WORKER -> QUIESCING -> LEGACY)
--
-- What this migration creates:
--   * `platform.outbox_runtime_control` — singleton (`id = 1`) holding
--     `mode` (LEGACY/QUIESCING/WORKER), a `generation` CAS counter and
--     audit columns (`updated_at`, `updated_by`, `note`); seeded
--     `LEGACY` at generation 1. Owned by `outbox_executor`, `REVOKE ALL
--     FROM PUBLIC`, NO grants to any other role (the executor reads it by
--     ownership; the API and worker roles reach it ONLY through functions).
--   * `platform.outbox_runtime_transitions` — append-only log of every
--     mode switch (from/to/generation/actor/recorded_at) under the same
--     append-only trigger idiom as 050; owned by `outbox_executor`, no
--     grants to any other role.
--   * `platform.outbox_runtime_mode()` — `text`, `STABLE`, `SECURITY
--     DEFINER`, fixed `search_path`, `REVOKE FROM PUBLIC`, `EXECUTE` to
--     `outbox_worker` + `iptv_app` ONLY. The narrow read authority the
--     legacy drainer consults before every drain (C-LEGACY-GATE).
--   * `platform.outbox_runtime_set(p_from, p_to, p_actor,
--     p_expected_generation)` — the ONLY writer. Validates the step
--     order, rejects NULL modes / NULL generation with fixed messages
--     (never echoing values), refuses `->WORKER` while unfenced
--     (legacy `PUBLISHING` without a lease) rows exist, then performs
--     ONE atomic `UPDATE ... WHERE mode = p_from AND generation =
--     p_expected_generation` that bumps `generation`: a concurrent
--     second writer — or a stale ABA replay whose mode matches again
--     but whose generation is old — finds 0 rows and fails with a
--     fixed message (CAS). A crash mid-switch leaves the OLD mode
--     (never a half state). Rollback is a forward transition
--     (`WORKER -> QUIESCING -> LEGACY`), never a DOWN migration.
--     `REVOKE FROM PUBLIC`, granted to NOBODY: the superuser
--     operator bypasses privilege checks, so no grant is needed — and no
--     app/worker role must ever switch the mode.
--   * `platform.outbox_claim` is `CREATE OR REPLACE`d with the 050 body
--     byte-identical PLUS a gate in its first lines: it reads the
--     singleton and `RAISE`s unless the mode is `WORKER`. The worker
--     therefore needs NO new hot-path call — the claim itself consults
--     the authority (C-050/051 correction).
--
-- Deliberately NOT in this migration:
--   * No `EXECUTE` on `outbox_runtime_set` for any role (operator-only).
--   * No direct table grants for worker/app roles (roleGuard stays green).
--   * No BYPASSRLS anywhere; no new roles (criterion "no new owner").
--   * No RLS on the new tables: they carry zero grants, so no other role
--     can reach them at all; the owner bypasses RLS on its own tables, so
--     a policy here would be decorative, not load-bearing.
--   * An API restart cannot change the mode by construction: the mode
--     lives in this table, and no code path writes it except `set()`.
--
-- At-least-once is unchanged (see 050 header). Rollback of THIS migration
-- = a new append-only migration dropping what 051 added and restoring the
-- 050 `outbox_claim` body; rollback of the MODE (once switched) is a
-- forward `set()` transition, never a data repair.
BEGIN;

-- Install identity (050 precedent P1a): transferring table/function
-- ownership to the zero-membership executor needs superuser, and the
-- membership rule forbids the membership path by design — so fail closed
-- HERE with a clear message instead of obscurely at ALTER/CREATE.
-- SESSION_USER (not CURRENT_USER) is the authenticated identity.
DO $$
DECLARE
    v_login name;
    v_is_super boolean;
BEGIN
    SELECT session_user INTO v_login;
    SELECT r.rolsuper INTO v_is_super FROM pg_roles AS r WHERE r.rolname = v_login;
    IF NOT COALESCE(v_is_super, false) THEN
        RAISE EXCEPTION 'migration 051 refused: must run as a superuser owner (executor ownership transfer cannot succeed otherwise, and pre-granted memberships are refused by design)';
    END IF;
END $$;

-- Singleton runtime authority: one row (`id = 1`), seeded LEGACY gen 1.
CREATE TABLE platform.outbox_runtime_control (
    id integer PRIMARY KEY CHECK (id = 1),
    mode text NOT NULL CHECK (mode IN ('LEGACY', 'QUIESCING', 'WORKER')),
    generation integer NOT NULL CHECK (generation >= 1),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text NOT NULL DEFAULT '',
    note text NOT NULL DEFAULT ''
);

INSERT INTO platform.outbox_runtime_control (id, mode, generation, updated_by, note)
VALUES (1, 'LEGACY', 1, 'migration-051', 'initial seed: legacy drain owns publishing');

-- Append-only switch log: every set() lands exactly one row here.
CREATE TABLE platform.outbox_runtime_transitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_mode text NOT NULL,
    to_mode text NOT NULL,
    generation integer NOT NULL,
    actor text NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER outbox_runtime_transitions_append_only
BEFORE UPDATE OR DELETE ON platform.outbox_runtime_transitions
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

-- Narrow read authority: STABLE, definer-owned, search_path pinned.
CREATE OR REPLACE FUNCTION platform.outbox_runtime_mode()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = platform, pg_temp
AS $$
    SELECT mode FROM platform.outbox_runtime_control WHERE id = 1;
$$;

-- The ONLY writer: order validation + unfenced guard + two-key CAS.
CREATE OR REPLACE FUNCTION platform.outbox_runtime_set(
    p_from text,
    p_to text,
    p_actor text,
    p_expected_generation integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, pg_temp
AS $$
DECLARE
    v_generation integer;
BEGIN
    IF p_actor IS NULL OR btrim(p_actor) = '' THEN
        RAISE EXCEPTION 'outbox_runtime_set: p_actor must be a non-blank operator name';
    END IF;
    -- NULL modes fail closed HERE with a fixed message: a NULL side makes
    -- every `=` comparison below NULL (never true), so without this guard
    -- the step check would silently SKIP its RAISE and the call would fall
    -- through to the UPDATE (wrong message, or a native NOT NULL error).
    -- No value is ever echoed.
    IF p_from IS NULL OR p_to IS NULL THEN
        RAISE EXCEPTION 'outbox_runtime_set: p_from and p_to must be non-null runtime modes';
    END IF;
    -- The caller must name the generation it observed: a stale or missing
    -- expectation fails closed instead of silently winning an ABA race.
    IF p_expected_generation IS NULL THEN
        RAISE EXCEPTION 'outbox_runtime_set: p_expected_generation must be a non-null generation';
    END IF;
    -- Allowed steps only.
    IF NOT ((p_from = 'LEGACY' AND p_to = 'QUIESCING')
        OR (p_from = 'QUIESCING' AND p_to = 'WORKER')
        OR (p_from = 'WORKER' AND p_to = 'QUIESCING')
        OR (p_from = 'QUIESCING' AND p_to = 'LEGACY')) THEN
        RAISE EXCEPTION 'outbox_runtime_set: transition is not an allowed runtime step';
    END IF;
    -- Stranded-legacy guard (C-STRANDED): activating the worker while a
    -- legacy PUBLISHING row without a lease exists would strand it — the
    -- lease-aware reclaim only selects non-NULL leases. PUBLISHING rows
    -- WITH a lease (live or expired) do NOT block: reclaim covers them.
    IF p_to = 'WORKER' THEN
        IF EXISTS (SELECT 1 FROM platform.outbox_messages AS m
                   WHERE m.state = 'PUBLISHING'
                     AND m.lease_expires_at IS NULL) THEN
            RAISE EXCEPTION 'outbox_runtime_set: unfenced PUBLISHING rows block worker activation';
        END IF;
    END IF;

    -- CAS on (mode, generation): exactly one UPDATE predicated on BOTH
    -- the expected mode and the caller-observed generation. A concurrent
    -- second writer — or a stale ABA replay whose mode matches again but
    -- whose generation is old — sees 0 rows and fails below with a fixed
    -- message; a crash leaves the OLD mode, never a half state.
    UPDATE platform.outbox_runtime_control AS c
    SET mode = p_to,
        generation = c.generation + 1,
        updated_at = now(),
        updated_by = p_actor
    WHERE c.id = 1 AND c.mode = p_from AND c.generation = p_expected_generation
    RETURNING c.generation INTO v_generation;

    IF v_generation IS NULL THEN
        RAISE EXCEPTION 'outbox_runtime_set: runtime mode changed concurrently (expected mode is no longer current)';
    END IF;

    INSERT INTO platform.outbox_runtime_transitions (from_mode, to_mode, generation, actor)
    VALUES (p_from, p_to, v_generation, p_actor);

    RETURN v_generation;
END;
$$;

-- Claim gate (C-050/051): 050 body byte-identical, gate added as the first
-- lines. The function runs as the executor (table owner), so it reads the
-- singleton directly — no EXECUTE grant needed for this internal read.
CREATE OR REPLACE FUNCTION platform.outbox_claim(
    p_limit integer,
    p_worker text,
    p_lease_seconds integer DEFAULT 300
)
RETURNS TABLE (
    id uuid,
    tenant_id uuid,
    domain_event_id uuid,
    topic text,
    message_key text,
    payload_json jsonb,
    headers_json jsonb,
    claim_token uuid,
    lease_expires_at timestamptz,
    attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, pg_temp
AS $$
DECLARE
    -- One captured wall-clock instant per call: `clock_timestamp()` is
    -- volatile, so pinning it keeps the expiry predicate an index-range
    -- comparison (outbox_lease_recovery_idx) instead of a per-row volatile
    -- evaluation, and makes the claim deterministic within the call.
    v_now timestamptz := clock_timestamp();
BEGIN
    -- 051 live-interlock gate: the leased worker protocol is authoritative
    -- ONLY in WORKER mode. IS DISTINCT FROM fails closed on NULL too.
    IF (SELECT c.mode FROM platform.outbox_runtime_control AS c WHERE c.id = 1) IS DISTINCT FROM 'WORKER' THEN
        RAISE EXCEPTION 'outbox_claim: runtime mode is not WORKER (worker protocol is not active)';
    END IF;
    IF p_worker IS NULL OR btrim(p_worker) = '' THEN
        RAISE EXCEPTION 'outbox_claim: p_worker must be a non-blank worker name';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'outbox_claim: p_limit must be between 1 and 100, got %', p_limit;
    END IF;
    IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN
        RAISE EXCEPTION 'outbox_claim: p_lease_seconds must be between 1 and 3600, got %', p_lease_seconds;
    END IF;

    RETURN QUERY
    WITH candidate AS (
        SELECT m.id, m.state AS from_state
        FROM platform.outbox_messages AS m
        WHERE (
            m.state IN ('PENDING', 'FAILED')
            AND m.next_attempt_at <= v_now
        )
        OR (
            m.state = 'PUBLISHING'
            AND m.lease_expires_at IS NOT NULL
            AND m.lease_expires_at <= v_now
        )
        ORDER BY m.next_attempt_at ASC, m.created_at ASC
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    ),
    updated AS (
        UPDATE platform.outbox_messages AS m
        SET state = 'PUBLISHING',
            claim_token = gen_random_uuid(),
            claimed_by = p_worker,
            -- Wall clock (not `now()`): `now()` is frozen at transaction
            -- start, so a single-transaction proof could never observe a
            -- real expiry; across production transactions both agree.
            lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
            attempt_count = m.attempt_count + 1,
            last_error_code = NULL
        FROM candidate AS c
        WHERE m.id = c.id
        RETURNING m.id, m.tenant_id, m.domain_event_id, m.topic,
            m.message_key, m.payload_json, m.headers_json,
            m.claim_token, m.lease_expires_at, m.attempt_count,
            c.from_state
    ),
    logged AS (
        INSERT INTO platform.outbox_transitions
            (outbox_id, tenant_id, from_state, to_state, worker, claim_token)
        SELECT u.id, u.tenant_id, u.from_state, 'PUBLISHING', p_worker, u.claim_token
        FROM updated AS u
    )
    SELECT u.id, u.tenant_id, u.domain_event_id, u.topic,
        u.message_key, u.payload_json, u.headers_json,
        u.claim_token, u.lease_expires_at, u.attempt_count
    FROM updated AS u;
END;
$$;

-- Fixed owner: the NOLOGIN executor keeps owning the definer surface, so
-- every mode read/switch/claim runs as the executor and nothing else.
-- Direct ALTER (050 idiom): the owner here is the existing executor role,
-- never a new role.
ALTER TABLE platform.outbox_runtime_control OWNER TO outbox_executor;
ALTER TABLE platform.outbox_runtime_transitions OWNER TO outbox_executor;
ALTER FUNCTION platform.outbox_runtime_mode() OWNER TO outbox_executor;
ALTER FUNCTION platform.outbox_runtime_set(text, text, text, integer) OWNER TO outbox_executor;
ALTER FUNCTION platform.outbox_claim(integer, text, integer) OWNER TO outbox_executor;

-- Least privilege: new tables carry ZERO grants (owner-implicit only);
-- PUBLIC is revoked explicitly so a default-privilege injection cannot
-- linger silently (the verification below refuses any named grantee).
REVOKE ALL ON TABLE platform.outbox_runtime_control FROM PUBLIC;
REVOKE ALL ON TABLE platform.outbox_runtime_transitions FROM PUBLIC;

-- mode() is the narrow read authority: worker + app roles may EXECUTE it,
-- nobody else. (Schema USAGE for iptv_app: without it the EXECUTE grant
-- below is unusable; it confers no table access by itself.)
GRANT USAGE ON SCHEMA platform TO iptv_app;
REVOKE ALL ON FUNCTION platform.outbox_runtime_mode() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.outbox_runtime_mode() TO outbox_worker;
GRANT EXECUTE ON FUNCTION platform.outbox_runtime_mode() TO iptv_app;

-- set() is granted to NOBODY: the superuser operator bypasses privilege
-- checks, so no grant is needed — and no app/worker role must ever be
-- able to switch the runtime mode.
REVOKE ALL ON FUNCTION platform.outbox_runtime_set(text, text, text, integer) FROM PUBLIC;

-- Install verification (same transaction: any failure rolls EVERYTHING back).
-- Asserts the exact installed boundary:
--   * both new tables executor-owned with NO named grantee besides the
--     owner (PUBLIC revoked above; any third grantee — pre-existing or
--     concurrent — aborts);
--   * mode() carries ONLY outbox_worker + iptv_app EXECUTE without grant
--     option (plus tolerated owner entries: PostgreSQL materializes an
--     explicit EXECUTE entry for the owner on OWNER TO);
--   * set() carries NO named grantee besides the tolerated owner entries;
--   * neither function is PUBLIC-executable;
--   * the singleton seed is exactly (1, LEGACY, gen 1);
--   * the replaced claim is still SECURITY DEFINER, executor-owned,
--     search_path pinned, and carries the 051 gate.
DO $$
DECLARE
    v_owner name;
BEGIN
    SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class AS c WHERE c.oid = 'platform.outbox_runtime_control'::regclass;
    IF v_owner IS DISTINCT FROM 'outbox_executor' THEN
        RAISE EXCEPTION 'migration 051 refused: runtime control table must be owned by outbox_executor';
    END IF;
    SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class AS c WHERE c.oid = 'platform.outbox_runtime_transitions'::regclass;
    IF v_owner IS DISTINCT FROM 'outbox_executor' THEN
        RAISE EXCEPTION 'migration 051 refused: runtime transitions table must be owned by outbox_executor';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_class AS c, aclexplode(c.relacl) AS a
        WHERE c.oid IN ('platform.outbox_runtime_control'::regclass,
                        'platform.outbox_runtime_transitions'::regclass)
          AND a.grantee <> c.relowner
    ) THEN
        RAISE EXCEPTION 'migration 051 refused: runtime tables carry an unexpected grant (zero non-owner grantees allowed)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM platform.outbox_runtime_control AS c
                   WHERE c.id = 1 AND c.mode = 'LEGACY' AND c.generation = 1) THEN
        RAISE EXCEPTION 'migration 051 refused: runtime control seed must be exactly (id=1, LEGACY, generation=1)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'outbox_runtime_transitions_append_only') THEN
        RAISE EXCEPTION 'migration 051 refused: append-only trigger missing on platform.outbox_runtime_transitions';
    END IF;

    -- mode(): exact privilege (not just grantee identity): ONLY
    -- worker/app EXECUTE without grant option, plus tolerated owner
    -- entries. PUBLIC (empty-grantee entry) is refused too.
    IF EXISTS (
        SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS a
        WHERE p.oid = 'platform.outbox_runtime_mode()'::regprocedure
          AND NOT ((a.grantee = p.proowner)
                OR (a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'outbox_worker')
                    AND a.privilege_type = 'EXECUTE'
                    AND NOT a.is_grantable)
                OR (a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'iptv_app')
                    AND a.privilege_type = 'EXECUTE'
                    AND NOT a.is_grantable))
    ) THEN
        RAISE EXCEPTION 'migration 051 refused: outbox_runtime_mode carries an unexpected grant (only worker/app EXECUTE without grant option is allowed)';
    END IF;
    IF (SELECT p.proacl::text FROM pg_proc AS p
        WHERE p.oid = 'platform.outbox_runtime_mode()'::regprocedure) ~ '([,{])=X/' THEN
        RAISE EXCEPTION 'migration 051 refused: outbox_runtime_mode is still executable by PUBLIC';
    END IF;

    -- set(): NOBODY besides the tolerated owner entries, and not PUBLIC.
    IF EXISTS (
        SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS a
        WHERE p.oid = 'platform.outbox_runtime_set(text, text, text, integer)'::regprocedure
          AND a.grantee <> p.proowner
    ) THEN
        RAISE EXCEPTION 'migration 051 refused: outbox_runtime_set carries an unexpected grant (no grantee besides the owner is allowed)';
    END IF;
    IF (SELECT p.proacl::text FROM pg_proc AS p
        WHERE p.oid = 'platform.outbox_runtime_set(text, text, text, integer)'::regprocedure) ~ '([,{])=X/' THEN
        RAISE EXCEPTION 'migration 051 refused: outbox_runtime_set is still executable by PUBLIC';
    END IF;

    -- Replaced claim: executor-owned, SECURITY DEFINER, pinned search_path,
    -- still worker-EXECUTE-only (050 boundary preserved), gate present.
    IF EXISTS (
        SELECT 1 FROM pg_proc AS p
        WHERE p.oid = 'platform.outbox_claim(integer, text, integer)'::regprocedure
          AND (p.prosecdef IS DISTINCT FROM true
               OR pg_get_userbyid(p.proowner) <> 'outbox_executor'
               OR p.proconfig IS DISTINCT FROM ARRAY['search_path=platform, pg_temp'])
    ) THEN
        RAISE EXCEPTION 'migration 051 refused: replaced outbox_claim must stay SECURITY DEFINER, executor-owned, search_path pinned';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS a
        WHERE p.oid = 'platform.outbox_claim(integer, text, integer)'::regprocedure
          AND NOT ((a.grantee = p.proowner)
                OR (a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'outbox_worker')
                    AND a.privilege_type = 'EXECUTE'
                    AND NOT a.is_grantable))
    ) THEN
        RAISE EXCEPTION 'migration 051 refused: replaced outbox_claim carries an unexpected grant (only worker=EXECUTE without grant option is allowed)';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc AS p
        WHERE p.oid = 'platform.outbox_claim(integer, text, integer)'::regprocedure
          AND p.prosrc LIKE '%runtime mode is not WORKER%'
    ) THEN
        RAISE EXCEPTION 'migration 051 refused: replaced outbox_claim is missing the WORKER-mode gate';
    END IF;
END $$;

COMMIT;
