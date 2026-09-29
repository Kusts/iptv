-- 043 Pre-context webhook channel lookup (SECURITY DEFINER).
-- Context: `communication.tenant_channels` is RLS-enforced (migration 042)
-- with a fail-closed `tenant_isolation` policy, so a direct SELECT under
-- `iptv_app` with no `app.tenant_id` set yet returns 0 rows — the WAHA
-- webhook ingress (`WahaWebhookService.resolveChannel`) runs exactly in
-- that pre-context state and would 404 every delivery after cutover.
-- This migration adds ONE narrow escape hatch:
-- `communication.resolve_tenant_channel(p_tenant_key text)`, owned by the
-- migration (owner) role, SECURITY DEFINER, fixed `search_path`, revoked
-- from PUBLIC, EXECUTE granted to `iptv_app` only. It returns the ACTIVE
-- channel row for the given routing key (tenant_id, channel,
-- webhook_secret_hash, status) and touches NO other table. The resolved
-- tenant_id feeds `withTenantTransaction` for all subsequent work.
-- NOTE (billing): `billing.tenant_channels` is NOT RLS-enrolled yet (the
-- billing domain has no grants/policies — see runbook), so the Asaas path
-- keeps its direct SELECT for now. Apply this same SECURITY DEFINER
-- pattern there at billing-domain rollout time.
-- Migrations keep running as the owner role on a direct connection.
BEGIN;

CREATE OR REPLACE FUNCTION communication.resolve_tenant_channel(p_tenant_key text)
RETURNS TABLE (
    tenant_id uuid,
    channel text,
    webhook_secret_hash text,
    status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = communication, pg_temp
AS $$
    SELECT c.tenant_id, c.channel, c.webhook_secret_hash, c.status
    FROM communication.tenant_channels AS c
    WHERE c.tenant_key = p_tenant_key
      AND c.status = 'ACTIVE';
$$;

-- Fixed owner: the migration (owner) role must own the definer function,
-- otherwise the RLS bypass runs with the wrong identity. The runner
-- connects as the owner, so this is a no-op in the normal path and a
-- hard guarantee after privileged restores.
DO $$
DECLARE
    v_owner name;
BEGIN
    SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'communication' AND c.relname = 'tenant_channels';
    IF v_owner IS NOT NULL THEN
        EXECUTE format(
            'ALTER FUNCTION communication.resolve_tenant_channel(text) OWNER TO %I',
            v_owner
        );
    END IF;
END $$;

REVOKE ALL ON FUNCTION communication.resolve_tenant_channel(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION communication.resolve_tenant_channel(text) TO iptv_app;

COMMIT;
