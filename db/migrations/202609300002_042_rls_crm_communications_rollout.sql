-- 042 RLS rollout per domain: crm.* + communication.* (tenant-scoped tables).
-- Template from 007/041: ENABLE ROW LEVEL SECURITY + tenant_isolation policy
-- (USING/WITH CHECK on app.tenant_id, fail-closed when unset) + DML grants
-- to iptv_app. Migrations keep running as the owner role on a direct
-- connection; the app connects as iptv_app (see runbook
-- docs/10-operations/runbooks/rls-role-split-cutover.md).
--
-- Scope inventory (real, from db/migrations):
--   crm: leads, customer_health_snapshots (customers already done in 041).
--   communication: conversations, messages, message_deliveries,
--     communication_preferences, communication_suppressions,
--     conversation_control_events, tenant_channels, exceptions,
--     message_intents, scheduled_contacts.
-- Global tables without tenant_id in crm/communication scope: NONE — every
-- table above carries tenant_id uuid NOT NULL, so each gets the tenant
-- template. No allow-list exception policy is needed in this migration.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iptv_app') THEN
        CREATE ROLE iptv_app LOGIN NOBYPASSRLS;
    END IF;
END $$;

GRANT USAGE ON SCHEMA crm TO iptv_app;
GRANT USAGE ON SCHEMA communication TO iptv_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON crm.leads TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm.customer_health_snapshots TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON communication.conversations TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON communication.messages TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON communication.message_deliveries TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON communication.communication_preferences TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON communication.communication_suppressions TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON communication.conversation_control_events TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON communication.tenant_channels TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON communication.exceptions TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON communication.message_intents TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON communication.scheduled_contacts TO iptv_app;

ALTER TABLE crm.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.customer_health_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication.message_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication.communication_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication.communication_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication.conversation_control_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication.tenant_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication.exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication.message_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication.scheduled_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON crm.leads;
CREATE POLICY tenant_isolation ON crm.leads
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON crm.customer_health_snapshots;
CREATE POLICY tenant_isolation ON crm.customer_health_snapshots
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON communication.conversations;
CREATE POLICY tenant_isolation ON communication.conversations
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON communication.messages;
CREATE POLICY tenant_isolation ON communication.messages
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON communication.message_deliveries;
CREATE POLICY tenant_isolation ON communication.message_deliveries
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON communication.communication_preferences;
CREATE POLICY tenant_isolation ON communication.communication_preferences
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON communication.communication_suppressions;
CREATE POLICY tenant_isolation ON communication.communication_suppressions
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON communication.conversation_control_events;
CREATE POLICY tenant_isolation ON communication.conversation_control_events
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON communication.tenant_channels;
CREATE POLICY tenant_isolation ON communication.tenant_channels
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON communication.exceptions;
CREATE POLICY tenant_isolation ON communication.exceptions
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON communication.message_intents;
CREATE POLICY tenant_isolation ON communication.message_intents
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON communication.scheduled_contacts;
CREATE POLICY tenant_isolation ON communication.scheduled_contacts
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
