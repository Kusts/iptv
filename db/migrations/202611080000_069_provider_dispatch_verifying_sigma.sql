-- 069 Sigma subscription reconcile candidates: broaden the VERIFYING list
-- beyond trial.provision so subscription.provision / subscription.renew
-- VERIFYING rows are visible to reconcileOnce under iptv_app. Append-only;
-- never edits 001-068. The definer contract is unchanged (SECURITY DEFINER,
-- pinned search_path, EXECUTE to iptv_app only, narrow body touching only
-- provider.provider_operations); only the candidate filter widens and two
-- shape columns are added (o_action, o_entity_type) so the caller can
-- branch without a second round trip. Trial rows keep matching exactly as
-- before.
BEGIN;

DROP FUNCTION IF EXISTS provider.dispatch_verifying_list(integer);
CREATE FUNCTION provider.dispatch_verifying_list(
    p_limit integer
)
RETURNS TABLE (
    o_operation_id uuid,
    o_tenant_id uuid,
    o_provider_account_id uuid,
    o_entity_id uuid,
    o_requested_payload jsonb,
    o_adapter_version text,
    o_result_summary jsonb,
    o_action text,
    o_entity_type text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = provider, pg_temp
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'dispatch_verifying_list: p_limit must be between 1 and 500';
    END IF;

    RETURN QUERY
    SELECT m.id, m.tenant_id, m.provider_account_id, m.entity_id,
        m.requested_payload_json, m.adapter_version, m.result_summary_json,
        m.action, m.entity_type
    FROM provider.provider_operations AS m
    WHERE m.status = 'VERIFYING'
      AND m.adapter_version = 'secret-required-v1'
      AND (
        (m.action = 'trial.provision' AND m.entity_type = 'trial')
        OR (m.action IN ('subscription.provision', 'subscription.renew') AND m.entity_type = 'subscription')
      )
    ORDER BY m.requested_at ASC, m.id ASC
    LIMIT p_limit;
END;
$$;

-- Keep the definer fixed-owner (same pattern as 056).
DO $$
DECLARE
    v_owner name;
BEGIN
    SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'provider' AND c.relname = 'provider_operations';
    IF v_owner IS NOT NULL THEN
        EXECUTE format(
            'ALTER FUNCTION provider.dispatch_verifying_list(integer) OWNER TO %I',
            v_owner
        );
    END IF;
END $$;

REVOKE ALL ON FUNCTION provider.dispatch_verifying_list(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provider.dispatch_verifying_list(integer) TO iptv_app;

COMMIT;
