-- 050 Platform outbox worker isolation (append-only; never edit 001/041-049).
-- Implements the ACCEPTED hybrid-C direction recorded in
-- docs/10-operations/runbooks/rls-role-split-cutover.md ("Platform/outbox
-- worker RLS — ACCEPTED DESIGN DIRECTION"): a dedicated LOGIN worker role
-- that owns nothing and holds ONLY EXECUTE on four narrow, static
-- SECURITY DEFINER lifecycle functions (claim/renew/complete/fail).
--
-- What this migration creates:
--   * `outbox_worker` LOGIN NOBYPASSRLS — the worker process identity.
--     No password is set here: the operator rotates it with
--     `ALTER ROLE outbox_worker PASSWORD ...` (see runbook revocation).
--   * `outbox_executor` NOLOGIN NOINHERIT NOBYPASSRLS — owns the four
--     functions, so every definer call runs as this role and nothing else.
--   * Lease columns on `platform.outbox_messages` (NULL-safe, no backfill,
--     045 style): `claim_token`, `claimed_by`, `lease_expires_at`.
--   * `platform.outbox_transitions` append-only audit (INSERT/SELECT for the
--     executor only; UPDATE/DELETE refused by trigger AND by missing grants).
--   * Four functions, fixed `search_path = platform, pg_temp`, static SQL,
--     bounded batch, server-generated token + CAS fencing:
--       - `platform.outbox_claim(p_limit, p_worker, p_lease_seconds)` —
--         claims due PENDING/FAILED rows plus expired-lease PUBLISHING rows
--         (crash reclaim, no manual repair), oldest-first, SKIP LOCKED.
--       - `platform.outbox_renew(p_id, p_token, p_lease_seconds)` — extends
--         ONLY a live lease whose token matches (stale renew is denied).
--       - `platform.outbox_complete(p_id, p_token)` — PUBLISHED terminal,
--         token-matched only (stale completion writes 0 rows).
--       - `platform.outbox_fail(p_id, p_token, p_code, p_retry_at)` — FAILED
--         with retry, token-matched only, retry clamped to [now()+60s,
--         now()+7d], blank codes rejected.
--   * `REVOKE ALL ... FROM PUBLIC` on every function; EXECUTE granted to
--     `outbox_worker` ONLY — `iptv_app` receives "permission denied".
--   * RLS on `platform.outbox_messages` + `platform.outbox_transitions`
--     with an executor-only policy each (scope: exactly these tables).
--   * `outbox_lease_recovery_idx` partial on in-flight PUBLISHING leases.
--     The claim pins ONE `clock_timestamp()` per call so the expiry
--     predicate is a plain range comparison the planner can drive from this
--     index (the runbook requires its shape be re-measured against real
--     volume before activation; it is additive and harmless on rollback).
--     `outbox_pending_idx` (001) is preserved UNCHANGED.
--
-- Deliberately NOT in this migration:
--   * No EXECUTE for `iptv_app` and no direct table grants for the worker:
--     the API process must not become a worker executor (option A rejected).
--   * No BYPASSRLS anywhere (option B rejected).
--   * No worker process and no scheduler/dispatcher/inbox changes: the
--     in-process `OutboxDrainer.drain(25)` still runs on the API pool.
--     This DB protocol must NOT be activated while the legacy drain is live:
--     coexistence is worse than double-publish, because the legacy drainer
--     sets `PUBLISHING` with NO lease and completes by `id` alone (no CAS),
--     so it could overwrite a fenced outcome and leave rows this reclaim
--     (which requires a non-NULL lease) will never select. Activation gate
--     (next slice): PROVE no legacy publisher is in flight — stopping new
--     ticks is not enough, because a running legacy drain holds no lease and
--     completes by `id` alone — then start the worker. Rollback of THIS
--     migration = a new append-only migration dropping functions/policies/
--     grants; new columns/index stay in place. Rollback of the WORKER (once
--     active) is forward-fix, and must NEVER complete a claimed row just to
--     clear state: reclaim → publish with confirmation → complete, or
--     re-publish when delivery is uncertain. A legacy `PUBLISHING` row with
--     a NULL lease left by the OLD drain is a pre-existing condition this
--     migration does not silently repair (see runbook Rollback).
--
-- At-least-once (explicitly NOT exactly-once): a lease expiry lets a second
-- worker reclaim and re-publish a row while the first sender is paused; what
-- the database fences is the RECORDED outcome (stale tokens write 0 rows).
-- Transport-side idempotency stays out of scope here.
-- Migrations keep running as the owner role on a direct connection.
BEGIN;

-- Roles: worker identity (login, least privilege) + function owner (no login).
-- FAIL-CLOSED pre-existing posture gate (P1): role names are cluster-global,
-- so a coinciding name proves nothing about attributes, ownership, or
-- memberships. Policy: CREATE when absent; VALIDATE rigorously when present;
-- ABORT on anything unexpected. Never ALTER a divergent role into compliance:
-- silent normalization could mask a compromise or a concurrent configuration.
--
-- Expected posture when a role already exists:
--   outbox_worker:   LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
--                     NOREPLICATION, NOBYPASSRLS.
--   outbox_executor: NOLOGIN, NOINHERIT, NOSUPERUSER, NOCREATEDB,
--                     NOCREATEROLE, NOREPLICATION, NOBYPASSRLS.
--   (INHERIT is not constrained for outbox_worker: with zero memberships it
--   grants nothing either way.)
-- Membership rule (both roles): ZERO rows in pg_auth_members in EITHER
-- direction (nobody is a member of the role; the role is a member of
-- nothing). This single rule closes every SET ROLE path — any principal
-- assuming outbox_executor, or outbox_worker assuming an owner/admin role —
-- without depending on version-specific membership-option semantics: on
-- PostgreSQL 16+ pg_auth_members carries inherit_option/set_option columns,
-- but with no membership row there is no grant to interpret, so the check is
-- deliberately option-agnostic. Any membership row aborts the migration.
-- Ownership rule (both roles): the role must own NO object in this database
-- (relations including sequences, functions, types, schemas, large objects). The executor's
-- ownership of the four lifecycle functions is granted LATER in this same
-- migration, so at this point any owned object is pre-existing and
-- unexpected. Any owned object aborts the migration.
-- Install identity (P1a): this migration MUST run as a SUPERUSER owner.
-- Establishing the executor boundary (ALTER ... OWNER TO a fresh
-- zero-membership role) requires either membership in the new role or
-- superuser — and the membership rule below forbids the former BY DESIGN
-- (a pre-granted membership would itself be refused), while role creation
-- needs CREATEROLE. All supported environments run migrations as a
-- superuser owner; anything else fails closed HERE with a clear message
-- instead of obscurely at ALTER/CREATE. SESSION_USER (not CURRENT_USER)
-- is checked: it is the authenticated identity, unaffected by SET ROLE.
-- Grant rule (both roles): no direct ACL entry naming the role on ANY
-- database object, in ANY schema — schemas (nspacl), relations including
-- sequences (relacl), columns (attacl: a column-only GRANT survives a
-- table-level audit and stays usable after the USAGE grant), functions
-- (proacl), types (typacl), and large objects (lomacl, readable via
-- lo_get(oid)), plus server parameters (pg_parameter_acl.paracl,
-- cluster-global like roles: GRANT SET / ALTER SYSTEM ON PARAMETER ...
-- is server-configuration power — e.g. ALTER SYSTEM ON PARAMETER
-- archive_command — living outside every object catalog). A reused worker
-- identity retaining e.g.
-- SELECT on billing.charges would keep that access after becoming the
-- worker, violating the EXECUTE-only boundary without touching `platform`.
-- Database-level CONNECT/TEMP mechanics (datacl) are out of scope: the
-- migration never grants them and assumes the PUBLIC defaults. The GRANTs
-- below are the ONLY privileges these roles may ever hold; anything found
-- earlier aborts the migration. (Indirect grants via membership are already
-- excluded by the membership rule; per-role login settings are not checked
-- because function calls run with the pinned proconfig search_path, and the
-- NOLOGIN executor never logs in.)
-- Install verification (end of this migration): even with clean
-- pre-existing roles, the environment could inject privileges AT CREATE
-- time — pre-existing ALTER DEFAULT PRIVILEGES (e.g. GRANT EXECUTE ON
-- FUNCTIONS IN SCHEMA platform TO somebody) or a concurrent GRANT. The
-- closing block therefore re-asserts the exact installed boundary
-- (function grantees, audit-table grantees, single policy per table) and
-- aborts — rolling everything back — on any deviation. PUBLIC is revoked
-- explicitly AND refused by that allow-list.
-- A compatible pre-existing role (created exactly as below) passes and the
-- migration proceeds with the same minimal grants. All refusal messages name
-- the offending posture only — never secret values (rolpassword is never
-- read).
DO $$
DECLARE
    v_worker_oid oid;
    v_executor_oid oid;
    v_login name;
    v_is_super boolean;
    v_rec record;
BEGIN
    SELECT session_user INTO v_login;
    SELECT r.rolsuper INTO v_is_super FROM pg_roles AS r WHERE r.rolname = v_login;
    IF NOT COALESCE(v_is_super, false) THEN
        RAISE EXCEPTION 'migration 050 refused: must run as a superuser owner (executor ownership transfer and role creation cannot succeed otherwise, and pre-granted memberships are refused by design)';
    END IF;

    SELECT r.oid INTO v_worker_oid FROM pg_roles AS r WHERE r.rolname = 'outbox_worker';
    IF v_worker_oid IS NULL THEN
        CREATE ROLE outbox_worker LOGIN NOBYPASSRLS;
    ELSE
        SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreatedb,
               r.rolcreaterole, r.rolreplication
          INTO v_rec
          FROM pg_roles AS r WHERE r.oid = v_worker_oid;
        IF NOT v_rec.rolcanlogin THEN
            RAISE EXCEPTION 'migration 050 refused: pre-existing role "outbox_worker" is NOLOGIN (expected LOGIN worker identity)';
        END IF;
        IF v_rec.rolsuper THEN
            RAISE EXCEPTION 'migration 050 refused: pre-existing role "outbox_worker" is SUPERUSER';
        END IF;
        IF v_rec.rolbypassrls THEN
            RAISE EXCEPTION 'migration 050 refused: pre-existing role "outbox_worker" has BYPASSRLS';
        END IF;
        IF v_rec.rolcreatedb OR v_rec.rolcreaterole OR v_rec.rolreplication THEN
            RAISE EXCEPTION 'migration 050 refused: pre-existing role "outbox_worker" holds CREATEDB/CREATEROLE/REPLICATION';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_auth_members AS m
                    WHERE m.roleid = v_worker_oid OR m.member = v_worker_oid) THEN
            RAISE EXCEPTION 'migration 050 refused: pre-existing role "outbox_worker" has unexpected role memberships (refusing to trust a shared identity)';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_class AS c WHERE c.relowner = v_worker_oid)
           OR EXISTS (SELECT 1 FROM pg_proc AS p WHERE p.proowner = v_worker_oid)
           OR EXISTS (SELECT 1 FROM pg_type AS t WHERE t.typowner = v_worker_oid)
           OR EXISTS (SELECT 1 FROM pg_namespace AS n WHERE n.nspowner = v_worker_oid)
           OR EXISTS (SELECT 1 FROM pg_largeobject_metadata AS l WHERE l.lomowner = v_worker_oid) THEN
            RAISE EXCEPTION 'migration 050 refused: pre-existing role "outbox_worker" owns database objects';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_namespace AS n, aclexplode(n.nspacl) AS a
                    WHERE a.grantee = v_worker_oid)
           OR EXISTS (SELECT 1 FROM pg_class AS c, aclexplode(c.relacl) AS a
                      WHERE a.grantee = v_worker_oid)
           OR EXISTS (SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS a
                      WHERE a.grantee = v_worker_oid)
           OR EXISTS (SELECT 1 FROM pg_attribute AS at, aclexplode(at.attacl) AS a
                      WHERE a.grantee = v_worker_oid)
           OR EXISTS (SELECT 1 FROM pg_type AS t, aclexplode(t.typacl) AS a
                      WHERE a.grantee = v_worker_oid)
           -- Large objects have their own catalog (lomowner/lomacl): a reused
           -- identity retaining LO access could read via lo_get(oid).
           OR EXISTS (SELECT 1 FROM pg_largeobject_metadata AS l
                      WHERE l.lomowner = v_worker_oid)
           OR EXISTS (SELECT 1 FROM pg_largeobject_metadata AS l,
                      aclexplode(l.lomacl) AS a
                      WHERE a.grantee = v_worker_oid) THEN
            RAISE EXCEPTION 'migration 050 refused: pre-existing role "outbox_worker" already holds direct privileges on database objects (any schema)';
        END IF;
        -- Parameter ACLs live outside every object catalog
        -- (pg_parameter_acl, cluster-global): a reused identity retaining
        -- e.g. ALTER SYSTEM ON PARAMETER archive_command would keep
        -- server-configuration power after becoming the worker.
        IF EXISTS (SELECT 1 FROM pg_parameter_acl AS p,
                   aclexplode(p.paracl) AS a
                   WHERE a.grantee = v_worker_oid) THEN
            RAISE EXCEPTION 'migration 050 refused: pre-existing role "outbox_worker" already holds parameter privileges (GRANT SET / ALTER SYSTEM ON PARAMETER ... is server-configuration power outside the EXECUTE-only boundary)';
        END IF;
    END IF;

    SELECT r.oid INTO v_executor_oid FROM pg_roles AS r WHERE r.rolname = 'outbox_executor';
    IF v_executor_oid IS NULL THEN
        CREATE ROLE outbox_executor NOLOGIN NOINHERIT NOBYPASSRLS;
    ELSE
        SELECT r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolbypassrls,
               r.rolcreatedb, r.rolcreaterole, r.rolreplication
          INTO v_rec
          FROM pg_roles AS r WHERE r.oid = v_executor_oid;
        IF v_rec.rolcanlogin THEN
            RAISE EXCEPTION 'migration 050 refused: pre-existing role "outbox_executor" has LOGIN (expected NOLOGIN function owner)';
        END IF;
        IF v_rec.rolinherit THEN
            RAISE EXCEPTION 'migration 050 refused: pre-existing role "outbox_executor" has INHERIT (contract requires NOINHERIT)';
        END IF;
        IF v_rec.rolsuper THEN
            RAISE EXCEPTION 'migration 050 refused: pre-existing role "outbox_executor" is SUPERUSER';
        END IF;
        IF v_rec.rolbypassrls THEN
            RAISE EXCEPTION 'migration 050 refused: pre-existing role "outbox_executor" has BYPASSRLS';
        END IF;
        IF v_rec.rolcreatedb OR v_rec.rolcreaterole OR v_rec.rolreplication THEN
            RAISE EXCEPTION 'migration 050 refused: pre-existing role "outbox_executor" holds CREATEDB/CREATEROLE/REPLICATION';
        END IF;
        -- A role already granted to (or granted from) any other principal
        -- would let that principal exercise the privileges installed below,
        -- including the SECURITY DEFINER functions: refuse, never normalize.
        IF EXISTS (SELECT 1 FROM pg_auth_members AS m
                    WHERE m.roleid = v_executor_oid OR m.member = v_executor_oid) THEN
            RAISE EXCEPTION 'migration 050 refused: pre-existing role "outbox_executor" has unexpected role memberships (refusing to trust a shared identity)';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_class AS c WHERE c.relowner = v_executor_oid)
           OR EXISTS (SELECT 1 FROM pg_proc AS p WHERE p.proowner = v_executor_oid)
           OR EXISTS (SELECT 1 FROM pg_type AS t WHERE t.typowner = v_executor_oid)
           OR EXISTS (SELECT 1 FROM pg_namespace AS n WHERE n.nspowner = v_executor_oid)
           OR EXISTS (SELECT 1 FROM pg_largeobject_metadata AS l WHERE l.lomowner = v_executor_oid) THEN
            RAISE EXCEPTION 'migration 050 refused: pre-existing role "outbox_executor" owns database objects';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_namespace AS n, aclexplode(n.nspacl) AS a
                    WHERE a.grantee = v_executor_oid)
           OR EXISTS (SELECT 1 FROM pg_class AS c, aclexplode(c.relacl) AS a
                      WHERE a.grantee = v_executor_oid)
           OR EXISTS (SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS a
                      WHERE a.grantee = v_executor_oid)
           OR EXISTS (SELECT 1 FROM pg_attribute AS at, aclexplode(at.attacl) AS a
                      WHERE a.grantee = v_executor_oid)
           OR EXISTS (SELECT 1 FROM pg_type AS t, aclexplode(t.typacl) AS a
                      WHERE a.grantee = v_executor_oid)
           -- Large objects have their own catalog (lomowner/lomacl).
           OR EXISTS (SELECT 1 FROM pg_largeobject_metadata AS l
                      WHERE l.lomowner = v_executor_oid)
           OR EXISTS (SELECT 1 FROM pg_largeobject_metadata AS l,
                      aclexplode(l.lomacl) AS a
                      WHERE a.grantee = v_executor_oid) THEN
            RAISE EXCEPTION 'migration 050 refused: pre-existing role "outbox_executor" already holds direct privileges on database objects (any schema)';
        END IF;
        -- Parameter ACLs live outside every object catalog
        -- (pg_parameter_acl, cluster-global): same server-configuration
        -- power, refused here with a distinct message.
        IF EXISTS (SELECT 1 FROM pg_parameter_acl AS p,
                   aclexplode(p.paracl) AS a
                   WHERE a.grantee = v_executor_oid) THEN
            RAISE EXCEPTION 'migration 050 refused: pre-existing role "outbox_executor" already holds parameter privileges (GRANT SET / ALTER SYSTEM ON PARAMETER ... is server-configuration power outside the EXECUTE-only boundary)';
        END IF;
    END IF;
END $$;

-- Lease columns: NULL-safe, existing rows keep NULL (unclaimed), pure
-- roll-forward ALTER set in the style of migration 045 (no IF NOT EXISTS).
ALTER TABLE platform.outbox_messages
    ADD COLUMN claim_token uuid;

ALTER TABLE platform.outbox_messages
    ADD COLUMN claimed_by text;

ALTER TABLE platform.outbox_messages
    ADD COLUMN lease_expires_at timestamptz;

-- Append-only transition audit: every claim/renew/complete/fail lands here.
CREATE TABLE platform.outbox_transitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    outbox_id uuid NOT NULL REFERENCES platform.outbox_messages(id),
    tenant_id uuid NOT NULL,
    from_state text,
    to_state text NOT NULL,
    worker text NOT NULL,
    claim_token uuid,
    recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER outbox_transitions_append_only
BEFORE UPDATE OR DELETE ON platform.outbox_transitions
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

-- Claim: bounded batch, global oldest-first, SKIP LOCKED disjointness,
-- expired-lease reclaim. Invalid input fails closed (RAISE, never clamp).
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

-- Renew (heartbeat): extends ONLY a live lease whose token matches.
CREATE OR REPLACE FUNCTION platform.outbox_renew(
    p_id uuid,
    p_token uuid,
    p_lease_seconds integer DEFAULT 300
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, pg_temp
AS $$
DECLARE
    v_updated integer := 0;
BEGIN
    IF p_id IS NULL OR p_token IS NULL THEN
        RAISE EXCEPTION 'outbox_renew: p_id and p_token are required';
    END IF;
    IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN
        RAISE EXCEPTION 'outbox_renew: p_lease_seconds must be between 1 and 3600, got %', p_lease_seconds;
    END IF;

    UPDATE platform.outbox_messages AS m
    SET lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    WHERE m.id = p_id
      AND m.claim_token = p_token
      AND m.state = 'PUBLISHING'
      AND m.lease_expires_at IS NOT NULL
      AND m.lease_expires_at > clock_timestamp();
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated > 0 THEN
        INSERT INTO platform.outbox_transitions
            (outbox_id, tenant_id, from_state, to_state, worker, claim_token)
        SELECT m.id, m.tenant_id, 'PUBLISHING', 'PUBLISHING', m.claimed_by, m.claim_token
        FROM platform.outbox_messages AS m
        WHERE m.id = p_id;
    END IF;

    RETURN v_updated;
END;
$$;

-- Complete: terminal PUBLISHED, token-matched only. Stale tokens write 0 rows.
CREATE OR REPLACE FUNCTION platform.outbox_complete(
    p_id uuid,
    p_token uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, pg_temp
AS $$
DECLARE
    v_updated integer := 0;
    v_worker text;
BEGIN
    IF p_id IS NULL OR p_token IS NULL THEN
        RAISE EXCEPTION 'outbox_complete: p_id and p_token are required';
    END IF;

    SELECT m.claimed_by INTO v_worker
    FROM platform.outbox_messages AS m
    WHERE m.id = p_id
      AND m.claim_token = p_token
      AND m.state = 'PUBLISHING';

    UPDATE platform.outbox_messages AS m
    SET state = 'PUBLISHED',
        published_at = now(),
        claim_token = NULL,
        claimed_by = NULL,
        lease_expires_at = NULL
    WHERE m.id = p_id
      AND m.claim_token = p_token
      AND m.state = 'PUBLISHING';
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated > 0 THEN
        INSERT INTO platform.outbox_transitions
            (outbox_id, tenant_id, from_state, to_state, worker, claim_token)
        SELECT p_id, m.tenant_id, 'PUBLISHING', 'PUBLISHED', v_worker, p_token
        FROM platform.outbox_messages AS m
        WHERE m.id = p_id;
    END IF;

    RETURN v_updated;
END;
$$;

-- Fail: back to FAILED with a retry instant, token-matched only.
CREATE OR REPLACE FUNCTION platform.outbox_fail(
    p_id uuid,
    p_token uuid,
    p_code text,
    p_retry_at timestamptz DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, pg_temp
AS $$
DECLARE
    v_updated integer := 0;
    v_retry timestamptz;
    v_worker text;
    v_now timestamptz := clock_timestamp();
BEGIN
    IF p_id IS NULL OR p_token IS NULL THEN
        RAISE EXCEPTION 'outbox_fail: p_id and p_token are required';
    END IF;
    IF p_code IS NULL OR btrim(p_code) = '' THEN
        RAISE EXCEPTION 'outbox_fail: p_code must be a non-blank error code';
    END IF;

    -- Backoff contract: the retry instant is CLAMPED to [now+60s, now+7d].
    -- A past or too-soon request is raised to the 60s floor (never a hot
    -- retry); beyond 7 days is refused, not clamped (operator error).
    v_retry := COALESCE(p_retry_at, v_now + make_interval(secs => 60));
    IF v_retry < v_now + make_interval(secs => 60) THEN
        v_retry := v_now + make_interval(secs => 60);
    END IF;
    IF v_retry > v_now + make_interval(days => 7) THEN
        RAISE EXCEPTION 'outbox_fail: p_retry_at must be within 7 days';
    END IF;

    SELECT m.claimed_by INTO v_worker
    FROM platform.outbox_messages AS m
    WHERE m.id = p_id
      AND m.claim_token = p_token
      AND m.state = 'PUBLISHING';

    UPDATE platform.outbox_messages AS m
    SET state = 'FAILED',
        last_error_code = p_code,
        next_attempt_at = v_retry,
        claim_token = NULL,
        claimed_by = NULL,
        lease_expires_at = NULL
    WHERE m.id = p_id
      AND m.claim_token = p_token
      AND m.state = 'PUBLISHING';
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated > 0 THEN
        INSERT INTO platform.outbox_transitions
            (outbox_id, tenant_id, from_state, to_state, worker, claim_token)
        SELECT p_id, m.tenant_id, 'PUBLISHING', 'FAILED', v_worker, p_token
        FROM platform.outbox_messages AS m
        WHERE m.id = p_id;
    END IF;

    RETURN v_updated;
END;
$$;

-- Fixed owner: the NOLOGIN executor role owns the definer functions, so every
-- call runs as the executor and nothing else (hybrid-C boundary). Direct
-- ALTER (not the 043 table-owner idiom) because the owner here is the fresh
-- executor role by design, never the table owner.
ALTER FUNCTION platform.outbox_claim(integer, text, integer) OWNER TO outbox_executor;
ALTER FUNCTION platform.outbox_renew(uuid, uuid, integer) OWNER TO outbox_executor;
ALTER FUNCTION platform.outbox_complete(uuid, uuid) OWNER TO outbox_executor;
ALTER FUNCTION platform.outbox_fail(uuid, uuid, text, timestamptz) OWNER TO outbox_executor;

-- Least privilege: schema USAGE for call path only; executor gets the exact
-- DML the functions need; the worker gets NOTHING on tables or sequences.
GRANT USAGE ON SCHEMA platform TO outbox_worker;
GRANT USAGE ON SCHEMA platform TO outbox_executor;
GRANT SELECT, UPDATE ON platform.outbox_messages TO outbox_executor;
GRANT INSERT, SELECT ON platform.outbox_transitions TO outbox_executor;

REVOKE ALL ON FUNCTION platform.outbox_claim(integer, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.outbox_claim(integer, text, integer) TO outbox_worker;

REVOKE ALL ON FUNCTION platform.outbox_renew(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.outbox_renew(uuid, uuid, integer) TO outbox_worker;

REVOKE ALL ON FUNCTION platform.outbox_complete(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.outbox_complete(uuid, uuid) TO outbox_worker;

REVOKE ALL ON FUNCTION platform.outbox_fail(uuid, uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.outbox_fail(uuid, uuid, text, timestamptz) TO outbox_worker;

-- RLS: executor-only policies, scope exactly these two tables. The executor
-- is NOBYPASSRLS, so the policy is load-bearing (not decorative). No policy
-- for `iptv_app`: the API process must not reach outbox rows at all.
ALTER TABLE platform.outbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.outbox_transitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbox_executor_isolation ON platform.outbox_messages;
CREATE POLICY outbox_executor_isolation ON platform.outbox_messages
    FOR ALL TO outbox_executor
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS outbox_executor_isolation ON platform.outbox_transitions;
CREATE POLICY outbox_executor_isolation ON platform.outbox_transitions
    FOR ALL TO outbox_executor
    USING (true)
    WITH CHECK (true);

-- Lease-recovery index (045 precedent): partial on in-flight PUBLISHING
-- leases so reclaim scans stay bounded. `outbox_claim` pins one
-- `clock_timestamp()` per call, so the `lease_expires_at <= v_now` predicate
-- is a range comparison this index can serve. Shape is provisional pending
-- real-volume measurement (runbook); additive and harmless on rollback.
-- `outbox_pending_idx` (001) stays UNCHANGED.
CREATE INDEX outbox_lease_recovery_idx
    ON platform.outbox_messages (lease_expires_at)
    WHERE state = 'PUBLISHING';

-- Install verification (same transaction: any failure rolls EVERYTHING back).
-- The pre-existing-role gate above cannot see privileges injected AT CREATE
-- time (pre-existing ALTER DEFAULT PRIVILEGES, concurrent GRANT), so assert
-- the exact installed boundary here:
--   * the four functions carry ONLY worker=EXECUTE without grant option
--     (plus tolerated owner entries: PostgreSQL materializes an explicit
--     EXECUTE entry for the owner on OWNER TO, and this lineage carries
--     explicit owner entries — both benign, the owner holds all rights
--     implicitly); PUBLIC — revoked above — is refused too. Grantee
--     identity alone is NOT enough: a default privilege granting ALL or
--     WITH GRANT OPTION would otherwise COMMIT;
--   * the new audit table carries ONLY executor=INSERT,SELECT without grant
--     option (plus tolerated owner entries, same rationale);
--   * exactly one policy per table (a surviving permissive policy for any
--     other role would OR with the executor-only policy and break isolation).
DO $$
DECLARE
    v_fn text;
BEGIN
    FOR v_fn IN
        SELECT unnest(ARRAY[
            'platform.outbox_claim(integer, text, integer)',
            'platform.outbox_renew(uuid, uuid, integer)',
            'platform.outbox_complete(uuid, uuid)',
            'platform.outbox_fail(uuid, uuid, text, timestamptz)'
        ])
    LOOP
        -- Exact privilege (not just grantee identity): ONLY worker=EXECUTE
        -- without grant option, plus tolerated owner entries. A default
        -- privilege granting e.g. ALL or WITH GRANT OPTION would otherwise
        -- survive a grantee-only check and COMMIT.
        IF EXISTS (
            SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS a
            WHERE p.oid = v_fn::regprocedure
              AND NOT ((a.grantee = p.proowner)
                    OR (a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'outbox_worker')
                        AND a.privilege_type = 'EXECUTE'
                        AND NOT a.is_grantable))
        ) THEN
            RAISE EXCEPTION 'migration 050 refused: installed function % carries an unexpected grant (only worker=EXECUTE without grant option is allowed)', v_fn;
        END IF;
        IF (SELECT p.proacl::text FROM pg_proc AS p WHERE p.oid = v_fn::regprocedure) ~ '([,{])=X/' THEN
            RAISE EXCEPTION 'migration 050 refused: installed function % is still executable by PUBLIC', v_fn;
        END IF;
    END LOOP;
    -- Exact DML (not just grantee identity): ONLY executor INSERT+SELECT
    -- without grant option, plus tolerated owner entries. A default
    -- privilege granting e.g. ALL ON TABLES (UPDATE/DELETE/TRUNCATE) would
    -- otherwise survive a grantee-only check and COMMIT.
    IF EXISTS (
        SELECT 1 FROM pg_class AS c, aclexplode(c.relacl) AS a
        WHERE c.oid = 'platform.outbox_transitions'::regclass
          AND NOT ((a.grantee = c.relowner)
                OR (a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'outbox_executor')
                    AND a.privilege_type IN ('INSERT', 'SELECT')
                    AND NOT a.is_grantable))
    ) THEN
        RAISE EXCEPTION 'migration 050 refused: installed audit table carries an unexpected grant (only executor=INSERT,SELECT without grant option is allowed)';
    END IF;
    IF (SELECT c.relacl::text FROM pg_class AS c
        WHERE c.oid = 'platform.outbox_transitions'::regclass) ~ '([,{])=[arwdDxtm]+/' THEN
        RAISE EXCEPTION 'migration 050 refused: installed audit table is still granted to PUBLIC';
    END IF;
    -- Parameter privileges are cluster-global and installed by nothing here:
    -- any pg_parameter_acl entry naming either role — pre-existing or
    -- injected by a concurrent GRANT at install time — breaks the
    -- EXECUTE-only boundary. Zero entries are expected, so grant-option is
    -- implicitly covered too.
    IF EXISTS (
        SELECT 1 FROM pg_parameter_acl AS p, aclexplode(p.paracl) AS a
        JOIN pg_roles AS r ON r.oid = a.grantee
        WHERE r.rolname IN ('outbox_worker', 'outbox_executor')
    ) THEN
        RAISE EXCEPTION 'migration 050 refused: worker/executor roles hold unexpected parameter privileges (no GRANT ... ON PARAMETER ... may name these roles)';
    END IF;
    IF (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'platform' AND tablename = 'outbox_messages') <> 1
       OR (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'platform' AND tablename = 'outbox_transitions') <> 1 THEN
        RAISE EXCEPTION 'migration 050 refused: expected exactly one RLS policy per outbox table (executor-only singleton)';
    END IF;
END $$;

COMMIT;
