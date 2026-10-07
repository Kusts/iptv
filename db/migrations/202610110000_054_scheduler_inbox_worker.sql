-- 054 Scheduler + inbox-worker + WAHA collapse (append-only; never edit 001-053).
--
-- SCOPE (P1.2 slice 054; dispatcher stays for P1.4):
--   * `claimed_by` audit column on `platform.inbox_messages` (no lease columns
--     by design: dedupe stays insert-once, no reclaim -- see below) + a partial
--     claim index `(provider, received_at, id) WHERE state = 'RECEIVED'`.
--   * `platform.inbox_claim(p_limit, p_provider, p_claimed_by)` -- the narrow
--     worker claim (043/049 precedent: owned by the migration owner via the
--     fixer block, SECURITY DEFINER, pinned `search_path`, REVOKE PUBLIC,
--     EXECUTE to `iptv_app` ONLY -- never the 050/051 outbox lifecycle roles,
--     which own the worker protocol only). ONE call atomically moves up to
--     `p_limit` RECEIVED rows of ONE provider to PROCESSING (ordered by
--     `received_at, id`, `FOR UPDATE SKIP LOCKED`), stamps `claimed_by`, and
--     returns (inbox id, tenant id, payload) so the caller never SELECTs back.
--     No lease, no reclaim: a crashed claim leaves PROCESSING rows orphaned
--     rather than double-processed (double delivery still dedupes to the same
--     id via `platform.inbox_accept`; orphaned rows are recovered ONLY through
--     the explicit operator-owned `platform.inbox_requeue` below -- never
--     silent re-processing here).
--   * `platform.inbox_claim_by_id(p_inbox_id, p_claimed_by)` -- the SAME
--     protocol for the inline HTTP path: one atomic
--     `UPDATE ... WHERE id = $1 AND state = 'RECEIVED'` (RECEIVED ->
--     PROCESSING, `claimed_by` stamped), returning (inbox id, tenant id,
--     payload). Zero rows means the row is ALREADY claimed -- the scheduler
--     drain won the race -- so the inline caller MUST skip `processRow` and
--     ack idempotently (never double-process). Same owner/definer/grants as
--     `inbox_claim`; the drain and the inline path share one protocol.
--   * `platform.inbox_stuck_list(p_older_than)` -- READ-ONLY detection for the
--     orphaned-PROCESSING case: lists PROCESSING rows older than the threshold
--     (default 15 minutes), oldest first. Pure SELECT, never mutates state --
--     calling it cannot reclaim, requeue, or otherwise move any row.
--   * `platform.inbox_requeue(p_inbox_id)` -- the ONLY recovery path for a
--     stuck PROCESSING row: explicit, one row at a time, PROCESSING ->
--     RECEIVED with `claimed_by` cleared, raising (never silently skipping)
--     when the row is not PROCESSING. OPERATOR-ONLY by design (mirrors
--     `platform.outbox_runtime_set` from 051): owned by the migration owner,
--     SECURITY DEFINER, pinned `search_path`, REVOKE PUBLIC, and NO EXECUTE
--     grant to ANY role -- the operator runs it on a direct owner connection.
--     There is deliberately NO automatic reclaim anywhere: a requeued row
--     becomes claimable again and its normalize stage re-runs, so the operator
--     reconciles the domain effect first (runbook `rls-role-split-cutover.md`,
--     inbox section).
--   * `communication.accept_waha_delivery` -- the WAHA TOCTOU collapse, an
--     exact mirror of `billing.accept_asaas_delivery` (053) over
--     `communication.tenant_channels`: lock the routing row (`FOR UPDATE`),
--     revalidate ACTIVE, enforce the caller-supplied EXPECTED tenant under the
--     same lock, then insert via `platform.inbox_accept` in the SAME
--     transaction. Unknown/DISABLED keys and A->B remaps are refused BEFORE any
--     insert with zero inbox rows. Secrets stay app-side (`verifySecret`).
--   * `control.list_scheduler_tenants()` -- the ONLY tenant-enumeration path
--     the scheduler may use: reads NOTHING but the platform-owned
--     `control.tenants` registry (id ordered by `created_at`), no business
--     table, no cross-tenant scan. The per-tenant due-commands stay
--     tenant-scoped (`bus.execute` -> `withTransaction` ->
--     `withTenantTransaction`); enumeration never leaks business rows.
--
-- IDENTITY (declared, 054):
--   * `platform.inbox_claim` / `platform.inbox_claim_by_id` /
--     `platform.inbox_stuck_list` / `communication.accept_waha_delivery` /
--     `control.list_scheduler_tenants` grant EXECUTE to `iptv_app`. The
--     scheduler and both `drainPending` entry points run TODAY as the pool
--     owner role (the `DATABASE_URL` runtime identity, which bypasses RLS);
--     at cutover they run as `iptv_app` (NOBYPASSRLS), where the global claim
--     SELECT would fail-closed to 0 rows without the definer, and the tenant
--     enumeration would still work through the narrow function either way.
--     The definer functions behave identically under both identities (owner
--     bypasses RLS inside; callers only need EXECUTE).
--
-- Deliberately NOT in this migration:
--   * No BYPASSRLS anywhere; no grants to `outbox_worker`/`outbox_executor`
--     (their 050/051 EXECUTE-only boundary is asserted, not widened).
--   * No GRANT to PUBLIC; no lease/reclaim state on the inbox; no AUTO-reclaim
--     path of any kind (`inbox_requeue` is operator-only and manual).
--   * No change to `platform.outbox_messages` / `platform.outbox_transitions`
--     grants, policies, triggers, or the 050/051 function bodies (051 gate
--     intact: `outbox_claim` still raises outside WORKER mode).
--   * No dispatcher/provider changes (P1.4); no billing-controller changes.
-- Migrations keep running as the owner role on a direct connection.
BEGIN;

-- Claim audit only (who moved RECEIVED -> PROCESSING). No lease columns: the
-- worker protocol is claim-once by design (see header).
ALTER TABLE platform.inbox_messages ADD COLUMN claimed_by text;

CREATE INDEX inbox_claim_pending_idx
    ON platform.inbox_messages (provider, received_at, id)
    WHERE state = 'RECEIVED';

-- Narrow worker claim: exactly one provider per call, so the WAHA and Asaas
-- drains can never claim each other's rows (a cross-provider claim would
-- strand rows in PROCESSING with no reclaim path -- see header).
CREATE OR REPLACE FUNCTION platform.inbox_claim(
    p_limit integer,
    p_provider text,
    p_claimed_by text
)
RETURNS TABLE (o_inbox_id uuid, o_tenant_id uuid, o_payload_json jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, pg_temp
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
        RAISE EXCEPTION 'inbox_claim: p_limit must be between 1 and 1000';
    END IF;
    IF p_provider IS NULL OR btrim(p_provider) = '' THEN
        RAISE EXCEPTION 'inbox_claim: p_provider must be non-blank';
    END IF;
    IF p_claimed_by IS NULL OR btrim(p_claimed_by) = '' THEN
        RAISE EXCEPTION 'inbox_claim: p_claimed_by must be non-blank';
    END IF;

    -- The CTE lock is the concurrency fix: concurrent drains serialize on the
    -- same RECEIVED rows and SKIP LOCKED hands each drain a disjoint set, so
    -- two drains never process the same row. The outer UPDATE is the
    -- RECEIVED -> PROCESSING transition; terminal states stay with
    -- `markState` (tenant-scoped UPDATE, unchanged).
    RETURN QUERY
    WITH c AS (
        SELECT q.id
        FROM platform.inbox_messages AS q
        WHERE q.state = 'RECEIVED'
          AND q.provider = p_provider
        ORDER BY q.received_at ASC, q.id ASC
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    UPDATE platform.inbox_messages AS m
    SET state = 'PROCESSING',
        claimed_by = p_claimed_by
    FROM c
    WHERE m.id = c.id
    RETURNING m.id, m.tenant_id, m.payload_json;
END;
$$;

-- Inline claim-by-id: the SAME claim protocol for the HTTP inline path
-- (HIGH: the controller used to call `processRow` on a RECEIVED row the
-- scheduler could claim concurrently -- double-processing). ONE atomic
-- UPDATE moves exactly this row RECEIVED -> PROCESSING when (and only when)
-- it is still RECEIVED; zero returned rows means the drain already owns it,
-- so the inline caller skips `processRow` and acks idempotently. The UPDATE
-- serializes concurrent claimants on the row lock: the loser observes 0
-- rows (never a second PROCESSING transition). Provider needs no check: the
-- id is the globally unique PK and the tenant/payload come back from the row.
CREATE OR REPLACE FUNCTION platform.inbox_claim_by_id(
    p_inbox_id uuid,
    p_claimed_by text
)
RETURNS TABLE (o_inbox_id uuid, o_tenant_id uuid, o_payload_json jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, pg_temp
AS $$
BEGIN
    IF p_inbox_id IS NULL THEN
        RAISE EXCEPTION 'inbox_claim_by_id: p_inbox_id is required';
    END IF;
    IF p_claimed_by IS NULL OR btrim(p_claimed_by) = '' THEN
        RAISE EXCEPTION 'inbox_claim_by_id: p_claimed_by must be non-blank';
    END IF;

    RETURN QUERY
    UPDATE platform.inbox_messages AS m
    SET state = 'PROCESSING',
        claimed_by = p_claimed_by
    WHERE m.id = p_inbox_id
      AND m.state = 'RECEIVED'
    RETURNING m.id, m.tenant_id, m.payload_json;
END;
$$;

-- Stuck-row detection (HIGH: a crash between claim and `markState` -- or a
-- `markState` failure aborting the batch -- strands PROCESSING rows with no
-- reclaim path). READ-ONLY by construction: a pure SELECT that lists
-- PROCESSING rows older than the threshold, oldest first. Calling it NEVER
-- moves, requeues, or otherwise mutates any row -- recovery stays an
-- explicit operator act (`inbox_requeue` below). `received_at` is the age
-- proxy (the inbox carries no claimed-at column by design).
CREATE OR REPLACE FUNCTION platform.inbox_stuck_list(
    p_older_than interval DEFAULT interval '15 minutes'
)
RETURNS TABLE (
    o_inbox_id uuid,
    o_tenant_id uuid,
    o_provider text,
    o_claimed_by text,
    o_received_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = platform, pg_temp
AS $$
BEGIN
    IF p_older_than IS NULL OR p_older_than <= interval '0' THEN
        RAISE EXCEPTION 'inbox_stuck_list: p_older_than must be a positive interval';
    END IF;

    RETURN QUERY
    SELECT m.id, m.tenant_id, m.provider, m.claimed_by, m.received_at
    FROM platform.inbox_messages AS m
    WHERE m.state = 'PROCESSING'
      AND m.received_at < now() - p_older_than
    ORDER BY m.received_at ASC, m.id ASC;
END;
$$;

-- Explicit operator-only requeue (HIGH: the orphaned-PROCESSING recovery).
-- Moves ONE row PROCESSING -> RECEIVED with `claimed_by` cleared so the next
-- drain can claim it again. Raises -- never silently skips -- when the row
-- does not exist or is not PROCESSING (bulk "fix everything" updates stay
-- refused: pass one id at a time so each requeue is reconciled). NO EXECUTE
-- grant to ANY role by design (mirrors `platform.outbox_runtime_set`, 051):
-- the operator runs it on a direct owner connection; `iptv_app`,
-- `outbox_worker`, `outbox_executor` and PUBLIC must all fail it. There is
-- deliberately NO automatic reclaim: a requeued row's normalize stage
-- RE-RUNS on the next drain, so the operator reconciles the domain effect
-- first (see the inbox section of `rls-role-split-cutover.md`).
CREATE OR REPLACE FUNCTION platform.inbox_requeue(
    p_inbox_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, pg_temp
AS $$
DECLARE
    v_updated integer;
BEGIN
    IF p_inbox_id IS NULL THEN
        RAISE EXCEPTION 'inbox_requeue: p_inbox_id is required';
    END IF;

    UPDATE platform.inbox_messages AS m
    SET state = 'RECEIVED',
        claimed_by = NULL
    WHERE m.id = p_inbox_id
      AND m.state = 'PROCESSING';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
        RAISE EXCEPTION 'inbox_requeue: row % is not PROCESSING (refusing silent repair)', p_inbox_id;
    END IF;
    RETURN true;
END;
$$;

-- WAHA TOCTOU accept (communication scope): lock the routing row, revalidate
-- ACTIVE, enforce the caller-supplied expected tenant, and insert-once the
-- inbox row in ONE transaction. A routing key that is unknown -- or DISABLED
-- after the app-side secret check -- yields accepted=false with ZERO inbox
-- rows. A key re-pointed to another tenant after the app-side resolve (the
-- locked row names B while the caller still expects A) is refused BEFORE any
-- insert the same way, so a remapped delivery never persists A's payload in
-- B. Secrets never enter this function. Byte-mirror of
-- `billing.accept_asaas_delivery` (053); the WAHA service keeps hashing the
-- raw body and wrapping `{channel, body}` as the payload, so dedupe semantics
-- are unchanged from the `tryInsert` path it replaces on ingress.
CREATE OR REPLACE FUNCTION communication.accept_waha_delivery(
    p_tenant_key text,
    p_external_event_id text,
    p_event_type text,
    p_payload_hash text,
    p_payload_json jsonb,
    p_expected_tenant_id uuid
)
RETURNS TABLE (o_accepted boolean, o_tenant_id uuid, o_inbox_id uuid, o_inserted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communication, pg_temp
AS $$
DECLARE
    v_tenant_id uuid;
    v_status text;
    r record;
BEGIN
    IF p_tenant_key IS NULL OR btrim(p_tenant_key) = '' THEN
        RAISE EXCEPTION 'accept_waha_delivery: p_tenant_key must be non-blank';
    END IF;
    IF p_external_event_id IS NULL OR btrim(p_external_event_id) = '' THEN
        RAISE EXCEPTION 'accept_waha_delivery: p_external_event_id must be non-blank';
    END IF;
    IF p_payload_hash IS NULL OR btrim(p_payload_hash) = '' THEN
        RAISE EXCEPTION 'accept_waha_delivery: p_payload_hash must be non-blank';
    END IF;
    IF p_expected_tenant_id IS NULL THEN
        RAISE EXCEPTION 'accept_waha_delivery: p_expected_tenant_id is required';
    END IF;

    -- The lock is the TOCTOU fix: concurrent deliveries for one routing key
    -- serialize here, and a DISABLE racing the app-side resolve is observed
    -- before any insert happens (the lock is held to transaction end).
    SELECT c.tenant_id, c.status INTO v_tenant_id, v_status
    FROM communication.tenant_channels AS c
    WHERE c.tenant_key = p_tenant_key
    FOR UPDATE;

    IF NOT FOUND OR v_status IS DISTINCT FROM 'ACTIVE' THEN
        RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, false;
        RETURN;
    END IF;

    -- Remap guard (HIGH, 053 precedent): the expected tenant (app-side resolve
    -- result) is compared UNDER the lock, BEFORE the insert. A key re-pointed
    -- A -> B mid-flight is refused with zero inbox rows -- the post-insert
    -- service-side comparison alone would persist A's payload in B first.
    IF v_tenant_id IS DISTINCT FROM p_expected_tenant_id THEN
        RETURN QUERY SELECT false, v_tenant_id, NULL::uuid, false;
        RETURN;
    END IF;

    SELECT i.o_inbox_id, i.o_inserted INTO r
    FROM platform.inbox_accept(
        v_tenant_id, 'waha', p_external_event_id, p_event_type,
        p_payload_hash, p_payload_json
    ) AS i;

    RETURN QUERY SELECT true, v_tenant_id, r.o_inbox_id, r.o_inserted;
END;
$$;

-- Scheduler tenant enumeration: the ONLY registry the scheduler loop may
-- enumerate. Reads NOTHING but `control.tenants` (platform-owned, no RLS by
-- 047 design -- the tenant_isolation template has no column to match there),
-- returns ids in creation order, and touches NO business table -- so the
-- scheduler tick performs zero global reads on tenant business data. Due-work
-- candidacy stays inside the per-tenant commands (which no-op when nothing is
-- due); this function only avoids invoking tenants that do not exist.
CREATE OR REPLACE FUNCTION control.list_scheduler_tenants()
RETURNS TABLE (o_tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = control, pg_temp
AS $$
    SELECT t.id
    FROM control.tenants AS t
    ORDER BY t.created_at ASC, t.id ASC;
$$;

-- Fixed owner (043/049/053 pattern): the migration (owner) role must own the
-- definer functions, otherwise the bypass runs with the wrong identity. The
-- runner connects as the owner, so this is a no-op in the normal path and a
-- hard guarantee after privileged restores. Each function derives from its
-- table owner.
DO $$
DECLARE
    v_platform_owner name;
    v_communication_owner name;
    v_control_owner name;
BEGIN
    SELECT pg_get_userbyid(c.relowner) INTO v_platform_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'platform' AND c.relname = 'domain_events';
    IF v_platform_owner IS NOT NULL THEN
        EXECUTE format(
            'ALTER FUNCTION platform.inbox_claim(integer, text, text) OWNER TO %I',
            v_platform_owner
        );
        EXECUTE format(
            'ALTER FUNCTION platform.inbox_claim_by_id(uuid, text) OWNER TO %I',
            v_platform_owner
        );
        EXECUTE format(
            'ALTER FUNCTION platform.inbox_stuck_list(interval) OWNER TO %I',
            v_platform_owner
        );
        EXECUTE format(
            'ALTER FUNCTION platform.inbox_requeue(uuid) OWNER TO %I',
            v_platform_owner
        );
    END IF;
    SELECT pg_get_userbyid(c.relowner) INTO v_communication_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'communication' AND c.relname = 'tenant_channels';
    IF v_communication_owner IS NOT NULL THEN
        EXECUTE format(
            'ALTER FUNCTION communication.accept_waha_delivery(text, text, text, text, jsonb, uuid) OWNER TO %I',
            v_communication_owner
        );
    END IF;
    SELECT pg_get_userbyid(c.relowner) INTO v_control_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'control' AND c.relname = 'tenants';
    IF v_control_owner IS NOT NULL THEN
        EXECUTE format(
            'ALTER FUNCTION control.list_scheduler_tenants() OWNER TO %I',
            v_control_owner
        );
    END IF;
END $$;

REVOKE ALL ON FUNCTION platform.inbox_claim(integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.inbox_claim(integer, text, text) TO iptv_app;

REVOKE ALL ON FUNCTION platform.inbox_claim_by_id(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.inbox_claim_by_id(uuid, text) TO iptv_app;

REVOKE ALL ON FUNCTION platform.inbox_stuck_list(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.inbox_stuck_list(interval) TO iptv_app;

-- inbox_requeue is operator-only (051 runtime_set mirror): REVOKE from PUBLIC
-- and GRANT to nobody -- the operator runs it as the owner. Any GRANT added
-- here later must fail the install verification below.
REVOKE ALL ON FUNCTION platform.inbox_requeue(uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION communication.accept_waha_delivery(text, text, text, text, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION communication.accept_waha_delivery(text, text, text, text, jsonb, uuid) TO iptv_app;

REVOKE ALL ON FUNCTION control.list_scheduler_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.list_scheduler_tenants() TO iptv_app;

-- Install verification (same transaction: any failure rolls EVERYTHING back).
-- Asserts the exact installed boundary: column + index, definer shape,
-- PUBLIC revoked, outbox roles excluded, append-only triggers intact, no
-- BYPASSRLS on the app role, and the 051 WORKER-mode gate untouched.
DO $$
DECLARE
    v_fn text;
    v_owner name;
BEGIN
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'iptv_app') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'migration 054 refused: app role iptv_app must exist with NOBYPASSRLS';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'platform' AND table_name = 'inbox_messages'
          AND column_name = 'claimed_by'
    ) THEN
        RAISE EXCEPTION 'migration 054 refused: platform.inbox_messages.claimed_by is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_class WHERE relname = 'inbox_claim_pending_idx'
    ) THEN
        RAISE EXCEPTION 'migration 054 refused: inbox_claim_pending_idx is missing';
    END IF;

    -- Producers: SECURITY DEFINER, pinned search_path, owner-held,
    -- EXECUTE iptv_app-only (plus tolerated owner entries), never PUBLIC,
    -- never the outbox lifecycle roles. inbox_requeue is checked separately
    -- below: operator-only (no EXECUTE to any role).
    FOR v_fn IN
        SELECT unnest(ARRAY[
            'platform.inbox_claim(integer, text, text)',
            'platform.inbox_claim_by_id(uuid, text)',
            'platform.inbox_stuck_list(interval)',
            'communication.accept_waha_delivery(text, text, text, text, jsonb, uuid)',
            'control.list_scheduler_tenants()'
        ])
    LOOP
        IF EXISTS (
            SELECT 1 FROM pg_proc AS p
            WHERE p.oid = v_fn::regprocedure
              AND (p.prosecdef IS DISTINCT FROM true
                    OR p.proconfig IS DISTINCT FROM ARRAY[
                        CASE
                            WHEN p.pronamespace = 'platform'::regnamespace
                                THEN 'search_path=platform, pg_temp'
                            WHEN p.pronamespace = 'communication'::regnamespace
                                THEN 'search_path=communication, pg_temp'
                            ELSE 'search_path=control, pg_temp' END])
        ) THEN
            RAISE EXCEPTION 'migration 054 refused: % must stay SECURITY DEFINER with pinned search_path', v_fn;
        END IF;
    END LOOP;

    SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class AS c WHERE c.oid = 'platform.domain_events'::regclass;
    IF EXISTS (
        SELECT 1 FROM pg_proc AS p
        WHERE p.oid = 'platform.inbox_claim(integer, text, text)'::regprocedure
          AND pg_get_userbyid(p.proowner) IS DISTINCT FROM v_owner
    ) THEN
        RAISE EXCEPTION 'migration 054 refused: platform.inbox_claim must be owned by the migration owner (not a lifecycle role)';
    END IF;
    FOR v_fn IN
        SELECT unnest(ARRAY[
            'platform.inbox_claim_by_id(uuid, text)',
            'platform.inbox_stuck_list(interval)',
            'platform.inbox_requeue(uuid)'
        ])
    LOOP
        IF EXISTS (
            SELECT 1 FROM pg_proc AS p
            WHERE p.oid = v_fn::regprocedure
              AND pg_get_userbyid(p.proowner) IS DISTINCT FROM v_owner
        ) THEN
            RAISE EXCEPTION 'migration 054 refused: % must be owned by the migration owner (not a lifecycle role)', v_fn;
        END IF;
    END LOOP;
    SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class AS c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'communication' AND c.relname = 'tenant_channels';
    IF EXISTS (
        SELECT 1 FROM pg_proc AS p
        WHERE p.oid = 'communication.accept_waha_delivery(text, text, text, text, jsonb, uuid)'::regprocedure
          AND pg_get_userbyid(p.proowner) IS DISTINCT FROM v_owner
    ) THEN
        RAISE EXCEPTION 'migration 054 refused: communication.accept_waha_delivery must be owned by the migration owner (not a lifecycle role)';
    END IF;
    SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class AS c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'control' AND c.relname = 'tenants';
    IF EXISTS (
        SELECT 1 FROM pg_proc AS p
        WHERE p.oid = 'control.list_scheduler_tenants()'::regprocedure
          AND pg_get_userbyid(p.proowner) IS DISTINCT FROM v_owner
    ) THEN
        RAISE EXCEPTION 'migration 054 refused: control.list_scheduler_tenants must be owned by the migration owner (not a lifecycle role)';
    END IF;

    FOR v_fn IN
        SELECT unnest(ARRAY[
            'platform.inbox_claim(integer, text, text)',
            'platform.inbox_claim_by_id(uuid, text)',
            'platform.inbox_stuck_list(interval)',
            'communication.accept_waha_delivery(text, text, text, text, jsonb, uuid)',
            'control.list_scheduler_tenants()'
        ])
    LOOP
        IF EXISTS (
            SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS a
            WHERE p.oid = v_fn::regprocedure
              AND NOT ((a.grantee = p.proowner)
                    OR (a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'iptv_app')
                        AND a.privilege_type = 'EXECUTE'
                        AND NOT a.is_grantable))
        ) THEN
            RAISE EXCEPTION 'migration 054 refused: % carries an unexpected grant (only iptv_app=EXECUTE without grant option is allowed)', v_fn;
        END IF;
        IF (SELECT p.proacl::text FROM pg_proc AS p WHERE p.oid = v_fn::regprocedure) ~ '([,{])=X/' THEN
            RAISE EXCEPTION 'migration 054 refused: % is still executable by PUBLIC', v_fn;
        END IF;
        IF has_function_privilege('outbox_worker', v_fn, 'EXECUTE') IS DISTINCT FROM false THEN
            RAISE EXCEPTION 'migration 054 refused: outbox_worker must NOT have EXECUTE on % (050 EXECUTE-only boundary)', v_fn;
        END IF;
        IF has_function_privilege('outbox_executor', v_fn, 'EXECUTE') IS DISTINCT FROM false THEN
            RAISE EXCEPTION 'migration 054 refused: outbox_executor must NOT have EXECUTE on % (050 EXECUTE-only boundary)', v_fn;
        END IF;
    END LOOP;

    -- inbox_requeue is operator-only (051 runtime_set mirror): no EXECUTE to
    -- ANY role -- not iptv_app, not the outbox lifecycle roles, not PUBLIC.
    -- The operator runs it as the function owner on a direct connection.
    IF has_function_privilege('iptv_app', 'platform.inbox_requeue(uuid)', 'EXECUTE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'migration 054 refused: iptv_app must NOT have EXECUTE on platform.inbox_requeue(uuid) (operator-only recovery)';
    END IF;
    IF has_function_privilege('outbox_worker', 'platform.inbox_requeue(uuid)', 'EXECUTE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'migration 054 refused: outbox_worker must NOT have EXECUTE on platform.inbox_requeue(uuid) (operator-only recovery)';
    END IF;
    IF has_function_privilege('outbox_executor', 'platform.inbox_requeue(uuid)', 'EXECUTE') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'migration 054 refused: outbox_executor must NOT have EXECUTE on platform.inbox_requeue(uuid) (operator-only recovery)';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS a
        WHERE p.oid = 'platform.inbox_requeue(uuid)'::regprocedure
          AND a.grantee <> p.proowner
    ) THEN
        RAISE EXCEPTION 'migration 054 refused: platform.inbox_requeue(uuid) carries a non-owner grant (operator-only recovery)';
    END IF;
    IF (SELECT p.proacl::text FROM pg_proc AS p WHERE p.oid = 'platform.inbox_requeue(uuid)'::regprocedure) ~ '([,{])=X/' THEN
        RAISE EXCEPTION 'migration 054 refused: platform.inbox_requeue(uuid) is still executable by PUBLIC';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_proc AS p
        WHERE p.oid = 'platform.inbox_requeue(uuid)'::regprocedure
          AND (p.prosecdef IS DISTINCT FROM true
                OR p.proconfig IS DISTINCT FROM ARRAY['search_path=platform, pg_temp'])
    ) THEN
        RAISE EXCEPTION 'migration 054 refused: platform.inbox_requeue(uuid) must stay SECURITY DEFINER with pinned search_path';
    END IF;

    -- Append-only triggers from 001/014/050/051 survive untouched.
    FOR v_fn IN
        SELECT unnest(ARRAY[
            'audit_log_append_only',
            'domain_events_append_only',
            'capability_events_append_only',
            'outbox_transitions_append_only',
            'outbox_runtime_transitions_append_only'
        ])
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = v_fn) THEN
            RAISE EXCEPTION 'migration 054 refused: append-only trigger % is missing', v_fn;
        END IF;
    END LOOP;

    -- The 051 claim gate survives (this migration never replaces it).
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc AS p
        WHERE p.oid = 'platform.outbox_claim(integer, text, integer)'::regprocedure
          AND p.prosrc LIKE '%runtime mode is not WORKER%'
    ) THEN
        RAISE EXCEPTION 'migration 054 refused: outbox_claim lost the 051 WORKER-mode gate';
    END IF;
END $$;

COMMIT;
