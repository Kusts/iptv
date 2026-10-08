-- 053 Platform spine rollout: RLS enrollment + producer functions + Asaas TOCTOU accept.
-- (append-only; never edit 001/014/043/049-052).
--
-- SCOPE (P1.2 slice 053; scheduler/dispatcher/inbox-worker stay for 054):
--   * RLS-enroll the four platform ingress/bus tables with the plain 042/052
--     `tenant_isolation` template (USING + WITH CHECK on `app.tenant_id`,
--     fail-closed when unset): `platform.inbox_messages`,
--     `platform.idempotency_keys`, `platform.domain_events`,
--     `platform.audit_log`. DML grants to `iptv_app` (house style, 052).
--   * `platform.policy_documents`: 048-split, NULL-tolerant. The catalog mixes
--     GLOBAL rows (`tenant_id IS NULL`, PLATFORM scope, published through the
--     app `policy.publish` command by platform admins) with TENANT/PARTNER
--     rows (`tenant_id NOT NULL`). A plain tenant template would blind
--     platform resolution (global defaults invisible) or block platform
--     publishing (NULL fails WITH CHECK) -- so NO blind enrollment:
--       SELECT: global defaults OR own-tenant rows (resolution keeps working);
--       INSERT: WITH CHECK global-or-own (platform publishing flows through
--         the app command path, unlike 048 flags which are owner-only);
--       UPDATE: USING own-tenant-only (global rows are invisible to UPDATE,
--         so they can never be modified or re-tenant-claimed -- the 048
--         steal defect stays closed) WITH CHECK global-or-own;
--       DELETE: USING own-tenant-only (global defaults not deletable).
--   * `platform.capabilities` / `platform.capability_events`: DOCUMENTED
--     GLOBAL EXCEPTION, no RLS -- by 014 design the capability catalog is
--     platform-owned with no `tenant_id`; scoping lives in RESOLUTION, never
--     in the row. DML grants to `iptv_app` (no RLS, same as pre-053 owner
--     behavior, now explicit for the app role).
--   * FIVE narrow producer functions (043/049 precedent: owned by the
--     migration owner via the fixer block, SECURITY DEFINER, pinned
--     `search_path`, REVOKE PUBLIC, EXECUTE to `iptv_app` ONLY -- never the
--     050/051 outbox lifecycle roles, which own the worker protocol only):
--       platform.inbox_accept -- pre-context insert-once
--         (tenant, provider, external id), returns (inbox id, inserted flag;
--         on conflict the EXISTING id, so callers never SELECT back);
--       platform.idempotency_claim / platform.idempotency_finish -- the exact
--         claim/replay/conflict/in_progress/reclaim state machine the command
--         bus runs at pool level today (no tenant context there);
--       platform.append_bus_rows -- ONE call inserts the bus triple
--         (domain event + PENDING outbox + audit, audit nullable so the first
--         of N triples carries the command audit and the rest pass NULL);
--       platform.audit_write -- standalone (non-command) audit rows, used by
--         `AuditService` and by command audits with zero emitted events.
--     Every producer hardcodes its initial state (RECEIVED / IN_PROGRESS /
--     PENDING -- never lifecycle states), validates its tenant argument, and
--     refuses when an ambient `app.tenant_id` disagrees with the argument
--     (confused-deputy guard: pre-context callers have no setting, in-context
--     callers must agree). Definer bodies carry explicit `tenant_id`
--     predicates on every internal query (the owner bypasses RLS).
--   * `billing.accept_asaas_delivery` -- the Asaas TOCTOU collapse: one
--     definer call locks the channel row (`SELECT ... FOR UPDATE`), revalidates
--     ACTIVE, checks the caller-supplied EXPECTED tenant under the same lock,
--     then inserts via `platform.inbox_accept` in the SAME transaction.
--     A channel DISABLED between the app-side `resolve_tenant_channel` secret
--     check and the accept finds no ACTIVE row under lock and is refused with
--     zero inbox rows (fail-closed). A routing key RE-POINTED to another
--     tenant between resolve and accept (resolve said A, the locked row now
--     says B) is refused the same way -- the expected-tenant comparison runs
--     BEFORE any insert, so no payload of A ever lands in B. Secret
--     comparison stays app-side and timing-safe (`verifySecret`); the function
--     never sees secrets. The returned tenant is re-checked by the service
--     against the resolved one (defense in depth).
--     WAHA keeps its current path (054 owns the WAHA collapse + inbox worker).
--
-- ATOMIC-PAIR INVARIANT (049 precedent): this migration MUST land in the same
-- commit as the app call-site swaps (command bus triple -> append_bus_rows,
-- claim/finish -> producers, audit writer -> audit_write, inbox store ->
-- inbox_accept, policy repository -> tenant context, Asaas acceptRaw ->
-- billing.accept_asaas_delivery). Enrolling without the swaps breaks ingress
-- and command execution under `iptv_app`.
--
-- Deliberately NOT in this migration:
--   * No BYPASSRLS anywhere; no grants to `outbox_worker`/`outbox_executor`
--     (their 050/051 EXECUTE-only boundary is asserted, not widened).
--   * No GRANT to PUBLIC; no lifecycle/lease state (054 owns inbox-worker).
--   * No change to `platform.outbox_messages` / `platform.outbox_transitions`
--     grants, policies, triggers, or the 050/051 function bodies (051 gate
--     intact: `outbox_claim` still raises outside WORKER mode).
--   * No WAHA, scheduler, or dispatcher changes (054).
-- Migrations keep running as the owner role on a direct connection.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iptv_app') THEN
        CREATE ROLE iptv_app LOGIN NOBYPASSRLS;
    END IF;
END $$;

GRANT USAGE ON SCHEMA platform TO iptv_app;
GRANT USAGE ON SCHEMA billing TO iptv_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON platform.inbox_messages TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.idempotency_keys TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.domain_events TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.audit_log TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.policy_documents TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.capabilities TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.capability_events TO iptv_app;

ALTER TABLE platform.inbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.policy_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON platform.inbox_messages;
CREATE POLICY tenant_isolation ON platform.inbox_messages
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON platform.idempotency_keys;
CREATE POLICY tenant_isolation ON platform.idempotency_keys
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON platform.domain_events;
CREATE POLICY tenant_isolation ON platform.domain_events
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON platform.audit_log;
CREATE POLICY tenant_isolation ON platform.audit_log
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- policy_documents split (048 shape, NULL-tolerant -- see header).
DROP POLICY IF EXISTS tenant_isolation ON platform.policy_documents;
DROP POLICY IF EXISTS policy_documents_select ON platform.policy_documents;
CREATE POLICY policy_documents_select ON platform.policy_documents
    FOR SELECT
    USING (
        tenant_id IS NULL
        OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    );

DROP POLICY IF EXISTS policy_documents_insert ON platform.policy_documents;
CREATE POLICY policy_documents_insert ON platform.policy_documents
    FOR INSERT
    WITH CHECK (
        tenant_id IS NULL
        OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    );

DROP POLICY IF EXISTS policy_documents_update ON platform.policy_documents;
CREATE POLICY policy_documents_update ON platform.policy_documents
    FOR UPDATE
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (
        tenant_id IS NULL
        OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    );

DROP POLICY IF EXISTS policy_documents_delete ON platform.policy_documents;
CREATE POLICY policy_documents_delete ON platform.policy_documents
    FOR DELETE
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- NOTE: platform.capabilities + platform.capability_events intentionally carry
-- NO RLS (documented global exception, 014 design). No POLICY here by design.

-- Pre-context inbox insert-once. Returns the existing row id on conflict so
-- callers never need a compensating SELECT (which would fail closed
-- pre-context under RLS).
CREATE OR REPLACE FUNCTION platform.inbox_accept(
    p_tenant_id uuid,
    p_provider text,
    p_external_event_id text,
    p_event_type text,
    p_payload_hash text,
    p_payload_json jsonb
)
RETURNS TABLE (o_inbox_id uuid, o_inserted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, pg_temp
AS $$
DECLARE
    v_ctx text := nullif(current_setting('app.tenant_id', true), '');
    v_id uuid;
BEGIN
    IF p_tenant_id IS NULL THEN
        RAISE EXCEPTION 'inbox_accept: p_tenant_id is required';
    END IF;
    IF v_ctx IS NOT NULL AND v_ctx::uuid IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'inbox_accept: tenant context does not match the accepted row';
    END IF;
    IF p_provider IS NULL OR btrim(p_provider) = '' THEN
        RAISE EXCEPTION 'inbox_accept: p_provider must be non-blank';
    END IF;
    IF p_external_event_id IS NULL OR btrim(p_external_event_id) = '' THEN
        RAISE EXCEPTION 'inbox_accept: p_external_event_id must be non-blank';
    END IF;
    IF p_payload_hash IS NULL OR btrim(p_payload_hash) = '' THEN
        RAISE EXCEPTION 'inbox_accept: p_payload_hash must be non-blank';
    END IF;

    INSERT INTO platform.inbox_messages AS m
        (tenant_id, provider, external_event_id, event_type, payload_hash,
         payload_json, state, attempt_count)
    VALUES
        (p_tenant_id, p_provider, p_external_event_id, p_event_type,
         p_payload_hash, p_payload_json, 'RECEIVED', 0)
    ON CONFLICT (tenant_id, provider, external_event_id) DO NOTHING
    RETURNING m.id INTO v_id;

    IF v_id IS NOT NULL THEN
        RETURN QUERY SELECT v_id, true;
        RETURN;
    END IF;
    SELECT m.id INTO v_id
    FROM platform.inbox_messages AS m
    WHERE m.tenant_id = p_tenant_id
      AND m.provider = p_provider
      AND m.external_event_id = p_external_event_id;
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'inbox_accept: conflicting row disappeared mid-accept';
    END IF;
    RETURN QUERY SELECT v_id, false;
END;
$$;

-- Idempotency claim: byte-faithful port of the bus claim state machine
-- (claimed / replay / conflict / in_progress, FAILED+same-hash reclaims).
CREATE OR REPLACE FUNCTION platform.idempotency_claim(
    p_tenant_id uuid,
    p_scope text,
    p_key text,
    p_request_hash text
)
RETURNS TABLE (o_status text, o_response_status integer, o_response_json jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, pg_temp
AS $$
DECLARE
    v_ctx text := nullif(current_setting('app.tenant_id', true), '');
    v_n integer;
    r record;
BEGIN
    IF p_tenant_id IS NULL THEN
        RAISE EXCEPTION 'idempotency_claim: p_tenant_id is required';
    END IF;
    IF v_ctx IS NOT NULL AND v_ctx::uuid IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'idempotency_claim: tenant context does not match the claimed key';
    END IF;
    IF p_scope IS NULL OR btrim(p_scope) = '' THEN
        RAISE EXCEPTION 'idempotency_claim: p_scope must be non-blank';
    END IF;
    IF p_key IS NULL OR btrim(p_key) = '' THEN
        RAISE EXCEPTION 'idempotency_claim: p_key must be non-blank';
    END IF;
    IF p_request_hash IS NULL OR btrim(p_request_hash) = '' THEN
        RAISE EXCEPTION 'idempotency_claim: p_request_hash must be non-blank';
    END IF;

    INSERT INTO platform.idempotency_keys AS k
        (tenant_id, scope, idempotency_key, request_hash, state)
    VALUES
        (p_tenant_id, p_scope, p_key, p_request_hash, 'IN_PROGRESS')
    ON CONFLICT (tenant_id, scope, idempotency_key) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 1 THEN
        RETURN QUERY SELECT 'claimed'::text, NULL::integer, NULL::jsonb;
        RETURN;
    END IF;

    SELECT k.state, k.request_hash, k.response_status, k.response_json
      INTO r
    FROM platform.idempotency_keys AS k
    WHERE k.tenant_id = p_tenant_id
      AND k.scope = p_scope
      AND k.idempotency_key = p_key;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'idempotency_claim: conflicting key disappeared mid-claim';
    END IF;

    IF r.state = 'SUCCEEDED' THEN
        IF r.request_hash IS NOT DISTINCT FROM p_request_hash THEN
            RETURN QUERY SELECT 'replay'::text, r.response_status, r.response_json;
        ELSE
            RETURN QUERY SELECT 'conflict'::text, NULL::integer, NULL::jsonb;
        END IF;
        RETURN;
    END IF;
    IF r.state = 'FAILED' THEN
        IF r.request_hash IS NOT DISTINCT FROM p_request_hash THEN
            UPDATE platform.idempotency_keys AS k
            SET state = 'IN_PROGRESS',
                response_status = NULL,
                response_json = NULL,
                completed_at = NULL
            WHERE k.tenant_id = p_tenant_id
              AND k.scope = p_scope
              AND k.idempotency_key = p_key;
            RETURN QUERY SELECT 'claimed'::text, NULL::integer, NULL::jsonb;
        ELSE
            RETURN QUERY SELECT 'conflict'::text, NULL::integer, NULL::jsonb;
        END IF;
        RETURN;
    END IF;
    RETURN QUERY SELECT 'in_progress'::text, NULL::integer, NULL::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION platform.idempotency_finish(
    p_tenant_id uuid,
    p_scope text,
    p_key text,
    p_state text,
    p_response_status integer,
    p_response_json jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, pg_temp
AS $$
DECLARE
    v_ctx text := nullif(current_setting('app.tenant_id', true), '');
BEGIN
    IF p_tenant_id IS NULL THEN
        RAISE EXCEPTION 'idempotency_finish: p_tenant_id is required';
    END IF;
    IF v_ctx IS NOT NULL AND v_ctx::uuid IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'idempotency_finish: tenant context does not match the finished key';
    END IF;
    IF p_state IS DISTINCT FROM 'SUCCEEDED' AND p_state IS DISTINCT FROM 'FAILED' THEN
        RAISE EXCEPTION 'idempotency_finish: p_state must be SUCCEEDED or FAILED';
    END IF;
    IF p_scope IS NULL OR btrim(p_scope) = '' THEN
        RAISE EXCEPTION 'idempotency_finish: p_scope must be non-blank';
    END IF;
    IF p_key IS NULL OR btrim(p_key) = '' THEN
        RAISE EXCEPTION 'idempotency_finish: p_key must be non-blank';
    END IF;

    UPDATE platform.idempotency_keys AS k
    SET state = p_state,
        response_status = p_response_status,
        response_json = p_response_json,
        completed_at = now()
    WHERE k.tenant_id = p_tenant_id
      AND k.scope = p_scope
      AND k.idempotency_key = p_key;
END;
$$;

-- Bus triple in one call: domain event + PENDING outbox + audit (the audit
-- side is nullable -- the first of N triples in a command carries the command
-- audit, the rest pass NULL; see KyselyAppTx.writeAudit).
CREATE OR REPLACE FUNCTION platform.append_bus_rows(
    p_tenant_id uuid,
    p_event_id uuid,
    p_event_type text,
    p_aggregate_type text,
    p_aggregate_id uuid,
    p_aggregate_version bigint,
    p_occurred_at timestamptz,
    p_recorded_at timestamptz,
    p_correlation_id uuid,
    p_causation_id uuid,
    p_actor_type text,
    p_actor_id text,
    p_schema_version integer,
    p_data_json jsonb,
    p_outbox_id uuid,
    p_topic text,
    p_message_key text,
    p_payload_json jsonb,
    p_headers_json jsonb,
    p_audit_id uuid,
    p_audit_actor_type text,
    p_audit_actor_id text,
    p_audit_action_key text,
    p_audit_resource_type text,
    p_audit_resource_id uuid,
    p_audit_correlation_id uuid,
    p_audit_metadata_json jsonb,
    p_audit_occurred_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, pg_temp
AS $$
DECLARE
    v_ctx text := nullif(current_setting('app.tenant_id', true), '');
    v_domain_id uuid;
BEGIN
    IF p_tenant_id IS NULL THEN
        RAISE EXCEPTION 'append_bus_rows: p_tenant_id is required';
    END IF;
    IF v_ctx IS NOT NULL AND v_ctx::uuid IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'append_bus_rows: tenant context does not match the appended rows';
    END IF;
    IF p_topic IS NULL OR btrim(p_topic) = '' THEN
        RAISE EXCEPTION 'append_bus_rows: p_topic must be non-blank';
    END IF;
    IF p_event_id IS NULL OR p_outbox_id IS NULL THEN
        RAISE EXCEPTION 'append_bus_rows: p_event_id and p_outbox_id are required';
    END IF;

    INSERT INTO platform.domain_events AS e
        (id, event_id, tenant_id, event_type, aggregate_type, aggregate_id,
         aggregate_version, occurred_at, recorded_at, correlation_id,
         causation_id, actor_type, actor_id, schema_version, data_json)
    VALUES
        (gen_random_uuid(), p_event_id, p_tenant_id, p_event_type,
         p_aggregate_type, p_aggregate_id, p_aggregate_version, p_occurred_at,
         p_recorded_at, p_correlation_id, p_causation_id, p_actor_type,
         p_actor_id, p_schema_version, COALESCE(p_data_json, '{}'::jsonb))
    RETURNING e.id INTO v_domain_id;

    INSERT INTO platform.outbox_messages AS m
        (id, tenant_id, domain_event_id, topic, message_key, payload_json,
         headers_json, state, attempt_count, next_attempt_at)
    VALUES
        (p_outbox_id, p_tenant_id, v_domain_id, p_topic, p_message_key,
         p_payload_json, COALESCE(p_headers_json, '{}'::jsonb), 'PENDING', 0, now());

    IF p_audit_action_key IS NOT NULL THEN
        IF btrim(p_audit_action_key) = '' THEN
            RAISE EXCEPTION 'append_bus_rows: p_audit_action_key must be non-blank when audit is attached';
        END IF;
        INSERT INTO platform.audit_log AS a
            (id, tenant_id, actor_type, actor_id, action_key, resource_type,
             resource_id, correlation_id, metadata_json, occurred_at)
        VALUES
            (COALESCE(p_audit_id, gen_random_uuid()), p_tenant_id,
             p_audit_actor_type, p_audit_actor_id, p_audit_action_key,
             p_audit_resource_type, p_audit_resource_id, p_audit_correlation_id,
             COALESCE(p_audit_metadata_json, '{}'::jsonb),
             COALESCE(p_audit_occurred_at, now()));
    END IF;

    RETURN v_domain_id;
END;
$$;

-- Standalone audit writer (non-command paths: HTTP auth/tenant controllers;
-- command audits with zero emitted events).
CREATE OR REPLACE FUNCTION platform.audit_write(
    p_tenant_id uuid,
    p_actor_type text,
    p_actor_id text,
    p_action_key text,
    p_resource_type text,
    p_resource_id uuid,
    p_correlation_id uuid,
    p_metadata_json jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, pg_temp
AS $$
DECLARE
    v_ctx text := nullif(current_setting('app.tenant_id', true), '');
    v_id uuid;
BEGIN
    IF p_tenant_id IS NULL THEN
        RAISE EXCEPTION 'audit_write: p_tenant_id is required';
    END IF;
    IF v_ctx IS NOT NULL AND v_ctx::uuid IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'audit_write: tenant context does not match the audited row';
    END IF;
    IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
        RAISE EXCEPTION 'audit_write: p_action_key must be non-blank';
    END IF;
    IF p_resource_type IS NULL OR btrim(p_resource_type) = '' THEN
        RAISE EXCEPTION 'audit_write: p_resource_type must be non-blank';
    END IF;

    INSERT INTO platform.audit_log AS a
        (tenant_id, actor_type, actor_id, action_key, resource_type,
         resource_id, correlation_id, metadata_json, occurred_at)
    VALUES
        (p_tenant_id, p_actor_type, p_actor_id, p_action_key,
         p_resource_type, p_resource_id, p_correlation_id,
         COALESCE(p_metadata_json, '{}'::jsonb), now())
    RETURNING a.id INTO v_id;
    RETURN v_id;
END;
$$;

-- Asaas TOCTOU accept (billing scope): lock the routing row, revalidate
-- ACTIVE, enforce the caller-supplied expected tenant, and insert-once the
-- inbox row in ONE transaction. A routing key that is unknown -- or DISABLED
-- after the app-side secret check -- yields accepted=false with ZERO inbox
-- rows. A key re-pointed to another tenant after the app-side resolve (the
-- locked row names B while the caller still expects A) is refused BEFORE any
-- insert the same way, so a remapped delivery never persists A's payload in
-- B. Secrets never enter this function.
CREATE OR REPLACE FUNCTION billing.accept_asaas_delivery(
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
SET search_path = billing, pg_temp
AS $$
DECLARE
    v_tenant_id uuid;
    v_status text;
    r record;
BEGIN
    IF p_tenant_key IS NULL OR btrim(p_tenant_key) = '' THEN
        RAISE EXCEPTION 'accept_asaas_delivery: p_tenant_key must be non-blank';
    END IF;
    IF p_external_event_id IS NULL OR btrim(p_external_event_id) = '' THEN
        RAISE EXCEPTION 'accept_asaas_delivery: p_external_event_id must be non-blank';
    END IF;
    IF p_payload_hash IS NULL OR btrim(p_payload_hash) = '' THEN
        RAISE EXCEPTION 'accept_asaas_delivery: p_payload_hash must be non-blank';
    END IF;
    IF p_expected_tenant_id IS NULL THEN
        RAISE EXCEPTION 'accept_asaas_delivery: p_expected_tenant_id is required';
    END IF;

    -- The lock is the TOCTOU fix: concurrent deliveries for one routing key
    -- serialize here, and a DISABLE racing the app-side resolve is observed
    -- before any insert happens (the lock is held to transaction end).
    SELECT c.tenant_id, c.status INTO v_tenant_id, v_status
    FROM billing.tenant_channels AS c
    WHERE c.tenant_key = p_tenant_key
    FOR UPDATE;

    IF NOT FOUND OR v_status IS DISTINCT FROM 'ACTIVE' THEN
        RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, false;
        RETURN;
    END IF;

    -- Remap guard (HIGH): the expected tenant (app-side resolve result) is
    -- compared UNDER the lock, BEFORE the insert. A key re-pointed A -> B
    -- mid-flight is refused with zero inbox rows -- the post-insert
    -- service-side comparison alone would persist A's payload in B first.
    IF v_tenant_id IS DISTINCT FROM p_expected_tenant_id THEN
        RETURN QUERY SELECT false, v_tenant_id, NULL::uuid, false;
        RETURN;
    END IF;

    SELECT i.o_inbox_id, i.o_inserted INTO r
    FROM platform.inbox_accept(
        v_tenant_id, 'asaas', p_external_event_id, p_event_type,
        p_payload_hash, p_payload_json
    ) AS i;

    RETURN QUERY SELECT true, v_tenant_id, r.o_inbox_id, r.o_inserted;
END;
$$;

-- Fixed owner (043/049 pattern): the migration (owner) role must own the
-- definer functions, otherwise the bypass runs with the wrong identity. The
-- runner connects as the owner, so this is a no-op in the normal path and a
-- hard guarantee after privileged restores. platform.* functions derive from
-- the platform table owner; the billing function from the billing table owner.
DO $$
DECLARE
    v_platform_owner name;
    v_billing_owner name;
BEGIN
    SELECT pg_get_userbyid(c.relowner) INTO v_platform_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'platform' AND c.relname = 'domain_events';
    IF v_platform_owner IS NOT NULL THEN
        EXECUTE format(
            'ALTER FUNCTION platform.inbox_accept(uuid, text, text, text, text, jsonb) OWNER TO %I',
            v_platform_owner
        );
        EXECUTE format(
            'ALTER FUNCTION platform.idempotency_claim(uuid, text, text, text) OWNER TO %I',
            v_platform_owner
        );
        EXECUTE format(
            'ALTER FUNCTION platform.idempotency_finish(uuid, text, text, text, integer, jsonb) OWNER TO %I',
            v_platform_owner
        );
        EXECUTE format(
            'ALTER FUNCTION platform.append_bus_rows(uuid, uuid, text, text, uuid, bigint, timestamptz, timestamptz, uuid, uuid, text, text, integer, jsonb, uuid, text, text, jsonb, jsonb, uuid, text, text, text, text, uuid, uuid, jsonb, timestamptz) OWNER TO %I',
            v_platform_owner
        );
        EXECUTE format(
            'ALTER FUNCTION platform.audit_write(uuid, text, text, text, text, uuid, uuid, jsonb) OWNER TO %I',
            v_platform_owner
        );
    END IF;
    SELECT pg_get_userbyid(c.relowner) INTO v_billing_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'billing' AND c.relname = 'tenant_channels';
    IF v_billing_owner IS NOT NULL THEN
        EXECUTE format(
            'ALTER FUNCTION billing.accept_asaas_delivery(text, text, text, text, jsonb, uuid) OWNER TO %I',
            v_billing_owner
        );
    END IF;
END $$;

REVOKE ALL ON FUNCTION platform.inbox_accept(uuid, text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.inbox_accept(uuid, text, text, text, text, jsonb) TO iptv_app;

REVOKE ALL ON FUNCTION platform.idempotency_claim(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.idempotency_claim(uuid, text, text, text) TO iptv_app;

REVOKE ALL ON FUNCTION platform.idempotency_finish(uuid, text, text, text, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.idempotency_finish(uuid, text, text, text, integer, jsonb) TO iptv_app;

REVOKE ALL ON FUNCTION platform.append_bus_rows(uuid, uuid, text, text, uuid, bigint, timestamptz, timestamptz, uuid, uuid, text, text, integer, jsonb, uuid, text, text, jsonb, jsonb, uuid, text, text, text, text, uuid, uuid, jsonb, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.append_bus_rows(uuid, uuid, text, text, uuid, bigint, timestamptz, timestamptz, uuid, uuid, text, text, integer, jsonb, uuid, text, text, jsonb, jsonb, uuid, text, text, text, text, uuid, uuid, jsonb, timestamptz) TO iptv_app;

REVOKE ALL ON FUNCTION platform.audit_write(uuid, text, text, text, text, uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.audit_write(uuid, text, text, text, text, uuid, uuid, jsonb) TO iptv_app;

REVOKE ALL ON FUNCTION billing.accept_asaas_delivery(text, text, text, text, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.accept_asaas_delivery(text, text, text, text, jsonb, uuid) TO iptv_app;

-- Install verification (same transaction: any failure rolls EVERYTHING back).
-- Asserts the exact installed boundary: RLS + policies, grants, definer
-- shape, PUBLIC revoked, outbox roles excluded, append-only triggers intact,
-- no BYPASSRLS on the app role.
DO $$
DECLARE
    v_fn text;
    v_owner name;
BEGIN
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'iptv_app') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'migration 053 refused: app role iptv_app must exist with NOBYPASSRLS';
    END IF;

    FOR v_fn IN
        SELECT unnest(ARRAY[
            'platform.inbox_messages',
            'platform.idempotency_keys',
            'platform.domain_events',
            'platform.audit_log',
            'platform.policy_documents'
        ])
    LOOP
        IF (SELECT relrowsecurity FROM pg_class WHERE oid = v_fn::regclass) IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'migration 053 refused: RLS is not enabled on %', v_fn;
        END IF;
        IF has_table_privilege('iptv_app', v_fn, 'SELECT') IS DISTINCT FROM true
            OR has_table_privilege('iptv_app', v_fn, 'INSERT') IS DISTINCT FROM true
            OR has_table_privilege('iptv_app', v_fn, 'UPDATE') IS DISTINCT FROM true
            OR has_table_privilege('iptv_app', v_fn, 'DELETE') IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'migration 053 refused: app role lacks full DML grants on %', v_fn;
        END IF;
        IF has_table_privilege('outbox_worker', v_fn, 'SELECT') IS DISTINCT FROM false
            OR has_table_privilege('outbox_worker', v_fn, 'INSERT') IS DISTINCT FROM false
            OR has_table_privilege('outbox_worker', v_fn, 'UPDATE') IS DISTINCT FROM false
            OR has_table_privilege('outbox_worker', v_fn, 'DELETE') IS DISTINCT FROM false THEN
            RAISE EXCEPTION 'migration 053 refused: outbox_worker must hold no privilege on % (050 EXECUTE-only boundary)', v_fn;
        END IF;
        IF has_table_privilege('outbox_executor', v_fn, 'SELECT') IS DISTINCT FROM false
            OR has_table_privilege('outbox_executor', v_fn, 'INSERT') IS DISTINCT FROM false
            OR has_table_privilege('outbox_executor', v_fn, 'UPDATE') IS DISTINCT FROM false
            OR has_table_privilege('outbox_executor', v_fn, 'DELETE') IS DISTINCT FROM false THEN
            RAISE EXCEPTION 'migration 053 refused: outbox_executor must hold no privilege on % (050 EXECUTE-only boundary)', v_fn;
        END IF;
    END LOOP;

    -- Global exception stays global: no RLS on the capability catalog.
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'platform.capabilities'::regclass) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'migration 053 refused: platform.capabilities must stay without RLS (documented global catalog)';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'platform.capability_events'::regclass) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'migration 053 refused: platform.capability_events must stay without RLS (documented global catalog)';
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
            RAISE EXCEPTION 'migration 053 refused: append-only trigger % is missing', v_fn;
        END IF;
    END LOOP;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'policy_documents_published_immutable'
    ) THEN
        RAISE EXCEPTION 'migration 053 refused: policy immutability trigger is missing';
    END IF;

    -- Producers: SECURITY DEFINER, pinned search_path, owner-held,
    -- EXECUTE iptv_app-only (plus tolerated owner entries), never PUBLIC,
    -- never the outbox lifecycle roles.
    FOR v_fn IN
        SELECT unnest(ARRAY[
            'platform.inbox_accept(uuid, text, text, text, text, jsonb)',
            'platform.idempotency_claim(uuid, text, text, text)',
            'platform.idempotency_finish(uuid, text, text, text, integer, jsonb)',
            'platform.append_bus_rows(uuid, uuid, text, text, uuid, bigint, timestamptz, timestamptz, uuid, uuid, text, text, integer, jsonb, uuid, text, text, jsonb, jsonb, uuid, text, text, text, text, uuid, uuid, jsonb, timestamptz)',
            'platform.audit_write(uuid, text, text, text, text, uuid, uuid, jsonb)',
            'platform.outbox_claim(integer, text, integer)'
        ])
    LOOP
        IF EXISTS (
            SELECT 1 FROM pg_proc AS p
            WHERE p.oid = v_fn::regprocedure
              AND (p.prosecdef IS DISTINCT FROM true
                   OR p.proconfig IS DISTINCT FROM ARRAY[
                       CASE WHEN p.pronamespace = 'platform'::regnamespace
                            THEN 'search_path=platform, pg_temp'
                            ELSE 'search_path=billing, pg_temp' END])
        ) THEN
            RAISE EXCEPTION 'migration 053 refused: % must stay SECURITY DEFINER with pinned search_path', v_fn;
        END IF;
    END LOOP;
    -- The 051 claim gate survives (this migration never replaces it).
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc AS p
        WHERE p.oid = 'platform.outbox_claim(integer, text, integer)'::regprocedure
          AND p.prosrc LIKE '%runtime mode is not WORKER%'
    ) THEN
        RAISE EXCEPTION 'migration 053 refused: outbox_claim lost the 051 WORKER-mode gate';
    END IF;

    SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class AS c WHERE c.oid = 'platform.domain_events'::regclass;
    FOR v_fn IN
        SELECT unnest(ARRAY[
            'platform.inbox_accept(uuid, text, text, text, text, jsonb)',
            'platform.idempotency_claim(uuid, text, text, text)',
            'platform.idempotency_finish(uuid, text, text, text, integer, jsonb)',
            'platform.append_bus_rows(uuid, uuid, text, text, uuid, bigint, timestamptz, timestamptz, uuid, uuid, text, text, integer, jsonb, uuid, text, text, jsonb, jsonb, uuid, text, text, text, text, uuid, uuid, jsonb, timestamptz)',
            'platform.audit_write(uuid, text, text, text, text, uuid, uuid, jsonb)'
        ])
    LOOP
        IF EXISTS (
            SELECT 1 FROM pg_proc AS p
            WHERE p.oid = v_fn::regprocedure
              AND pg_get_userbyid(p.proowner) IS DISTINCT FROM v_owner
        ) THEN
            RAISE EXCEPTION 'migration 053 refused: % must be owned by the migration owner (not a lifecycle role)', v_fn;
        END IF;
        IF EXISTS (
            SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS a
            WHERE p.oid = v_fn::regprocedure
              AND NOT ((a.grantee = p.proowner)
                    OR (a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'iptv_app')
                        AND a.privilege_type = 'EXECUTE'
                        AND NOT a.is_grantable))
        ) THEN
            RAISE EXCEPTION 'migration 053 refused: % carries an unexpected grant (only iptv_app=EXECUTE without grant option is allowed)', v_fn;
        END IF;
        IF (SELECT p.proacl::text FROM pg_proc AS p WHERE p.oid = v_fn::regprocedure) ~ '([,{])=X/' THEN
            RAISE EXCEPTION 'migration 053 refused: % is still executable by PUBLIC', v_fn;
        END IF;
    END LOOP;

    SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class AS c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'billing' AND c.relname = 'tenant_channels';
    IF EXISTS (
        SELECT 1 FROM pg_proc AS p
        WHERE p.oid = 'billing.accept_asaas_delivery(text, text, text, text, jsonb, uuid)'::regprocedure
          AND (pg_get_userbyid(p.proowner) IS DISTINCT FROM v_owner
               OR p.prosecdef IS DISTINCT FROM true
               OR p.proconfig IS DISTINCT FROM ARRAY['search_path=billing, pg_temp'])
    ) THEN
        RAISE EXCEPTION 'migration 053 refused: billing.accept_asaas_delivery must be migration-owner-held, SECURITY DEFINER, search_path pinned';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS a
        WHERE p.oid = 'billing.accept_asaas_delivery(text, text, text, text, jsonb, uuid)'::regprocedure
          AND NOT ((a.grantee = p.proowner)
                OR (a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'iptv_app')
                    AND a.privilege_type = 'EXECUTE'
                    AND NOT a.is_grantable))
    ) THEN
        RAISE EXCEPTION 'migration 053 refused: billing.accept_asaas_delivery carries an unexpected grant (only iptv_app=EXECUTE without grant option is allowed)';
    END IF;
    IF (SELECT p.proacl::text FROM pg_proc AS p
        WHERE p.oid = 'billing.accept_asaas_delivery(text, text, text, text, jsonb, uuid)'::regprocedure) ~ '([,{])=X/' THEN
        RAISE EXCEPTION 'migration 053 refused: billing.accept_asaas_delivery is still executable by PUBLIC';
    END IF;
END $$;

COMMIT;
