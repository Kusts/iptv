-- 041 RLS role split (pilot): application role + first enforced table.
-- Connection strategy: migrations keep running as the owner/superuser role
-- (direct connection, never the pooled app connection). The application opens
-- its own pool as iptv_app and sets app.tenant_id per transaction; see
-- docs/10-operations/runbooks/rls-role-split-cutover.md for the cutover path.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iptv_app') THEN
        CREATE ROLE iptv_app LOGIN NOBYPASSRLS;
    END IF;
END $$;

GRANT USAGE ON SCHEMA crm TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm.customers TO iptv_app;

ALTER TABLE crm.customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON crm.customers;
CREATE POLICY tenant_isolation ON crm.customers
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
