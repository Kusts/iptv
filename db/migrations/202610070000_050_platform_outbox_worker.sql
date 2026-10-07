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
--     (next slice): quiesce the legacy drain (`API_SCHEDULER_ENABLED=0` /
--     remove the `outbox.drain` call), let in-flight leases expire, then
--     start the worker. Rollback of THIS migration = a new append-only
--     migration dropping functions/policies/grants; new columns/index stay
--     in place. Rollback of the WORKER (once active) is forward-fix: a
--     legacy `PUBLISHING` row with a NULL lease left by the OLD drain is a
--     pre-existing condition this migration does not silently repair.
--
-- At-least-once (explicitly NOT exactly-once): a lease expiry lets a second
-- worker reclaim and re-publish a row while the first sender is paused; what
-- the database fences is the RECORDED outcome (stale tokens write 0 rows).
-- Transport-side idempotency stays out of scope here.
-- Migrations keep running as the owner role on a direct connection.
BEGIN;

-- Roles: worker identity (login, least privilege) + function owner (no login).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outbox_worker') THEN
        CREATE ROLE outbox_worker LOGIN NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outbox_executor') THEN
        CREATE ROLE outbox_executor NOLOGIN NOINHERIT NOBYPASSRLS;
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

COMMIT;
