-- 058 RLS rollout per domain: referral.* + loyalty.* + growth.* +
-- partners.* (tenant-scoped operational tables) + GLOBAL catalog grants.
-- Template from 042/052/055/057: ENABLE ROW LEVEL SECURITY +
-- tenant_isolation policy (USING/WITH CHECK on app.tenant_id, fail-closed
-- when unset) + DML grants to iptv_app. Migrations keep running as the
-- owner role on a direct connection; the app connects as iptv_app (see
-- runbook docs/10-operations/runbooks/rls-role-split-cutover.md).
--
-- Scope inventory (real, from db/migrations 011/028/029/032/033/034/035):
--   referral (4): referral_programs, referrals, referral_qualifications,
--     referral_reward_links (011).
--   loyalty (4): reward_definitions, rewards, reward_ledger_entries,
--     gift_passes (011).
--   growth (7): campaigns, campaign_versions, audience_definitions,
--     audience_members, creatives (028), attribution_touches,
--     conversion_events (029).
--   partners (9): partner_accounts, partner_relationships,
--     partner_capabilities (032), reseller_credit_entries,
--     reseller_credit_reservations, reseller_price_books,
--     reseller_orders (033), learning_progress (034, tenant-scoped
--     academy progress), partner_memberships (035).
-- Every table above carries tenant_id uuid NOT NULL, so each gets the
-- tenant template. Total: 24 tables.
--
-- Deliberately NOT tenant-enrolled in this migration (documented
-- allow-list, asserted in db/tests/025):
--   * communication.message_intents + communication.scheduled_contacts —
--     already RLS-enrolled with the tenant template in 042 (growth
--     scheduling tables live in the communication schema; re-enrolling
--     here would touch 042 scope).
--   * agent.agent_releases — GLOBAL release catalog (no tenant_id column
--     at all): GRANT SELECT ONLY, no RLS. The runtime read is PRE-CONTEXT
--     by construction — `KyselyAgentReleaseStore.getPublished`
--     (apps/api/src/agent/release-store.ts) pool-reads the PUBLISHED row
--     before any tenant transaction exists (pipeline harness path,
--     apps/api/src/agent/pipeline.ts), so an RLS policy could only
--     fail-closed every evaluation. No runtime path writes releases
--     (seeds arrive via migrations), so INSERT/UPDATE/DELETE stay
--     owner-only (056 providers precedent: documented minimum surface).
--   * partners.learning_content / partners.learning_content_versions —
--     GLOBAL academy catalog (no tenant_id column at all): GRANT SELECT
--     ONLY, no RLS. Same pre-context shape: controller
--     `listAcademyContent` and store `listAcademyContent` /
--     `getContentByTopicKey` read the curated catalog with no tenant
--     predicate (the same curriculum serves every tenant; progress stays
--     tenant-scoped in learning_progress above). Catalog writes arrive
--     via migrations only.
--   * USAGE ON SCHEMA agent is NOT repeated here (granted in 057);
--     referral/loyalty/growth/partners USAGE is granted below.
--
-- Deliberately NOT in this migration:
--   * No BYPASSRLS anywhere.
--   * No grants to outbox roles (`outbox_worker`/`outbox_executor` keep
--     their 050 EXECUTE-only boundary on platform.* and hold NOTHING here).
--   * No GRANT to PUBLIC.
--   * No pre-context resolver: no ingress in this slice runs pre-context
--     (call-site swaps are plain withTenantTransaction reader wraps, same
--     commit — 052/055/057 precedent for the atomic pair). The two GLOBAL
--     readers above are the reason no resolver exists: they never enter a
--     tenant transaction at all.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iptv_app') THEN
        CREATE ROLE iptv_app LOGIN NOBYPASSRLS;
    END IF;
END $$;

GRANT USAGE ON SCHEMA referral TO iptv_app;
GRANT USAGE ON SCHEMA loyalty TO iptv_app;
GRANT USAGE ON SCHEMA growth TO iptv_app;
GRANT USAGE ON SCHEMA partners TO iptv_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON referral.referral_programs TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON referral.referrals TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON referral.referral_qualifications TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON referral.referral_reward_links TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON loyalty.reward_definitions TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON loyalty.rewards TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON loyalty.reward_ledger_entries TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON loyalty.gift_passes TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON growth.campaigns TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON growth.campaign_versions TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON growth.audience_definitions TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON growth.audience_members TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON growth.creatives TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON growth.attribution_touches TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON growth.conversion_events TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON partners.partner_accounts TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON partners.partner_relationships TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON partners.partner_capabilities TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON partners.reseller_credit_entries TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON partners.reseller_credit_reservations TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON partners.reseller_price_books TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON partners.reseller_orders TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON partners.learning_progress TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON partners.partner_memberships TO iptv_app;

-- GLOBAL catalogs: read-only grants, never the tenant template (no
-- tenant_id column exists to isolate on; readers run pre-context).
GRANT SELECT ON agent.agent_releases TO iptv_app;
GRANT SELECT ON partners.learning_content TO iptv_app;
GRANT SELECT ON partners.learning_content_versions TO iptv_app;

ALTER TABLE referral.referral_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral.referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral.referral_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral.referral_reward_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty.reward_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty.rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty.reward_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty.gift_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth.campaign_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth.audience_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth.audience_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth.creatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth.attribution_touches ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth.conversion_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.partner_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.partner_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.partner_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.reseller_credit_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.reseller_credit_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.reseller_price_books ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.reseller_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.learning_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.partner_memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON referral.referral_programs;
CREATE POLICY tenant_isolation ON referral.referral_programs
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON referral.referrals;
CREATE POLICY tenant_isolation ON referral.referrals
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON referral.referral_qualifications;
CREATE POLICY tenant_isolation ON referral.referral_qualifications
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON referral.referral_reward_links;
CREATE POLICY tenant_isolation ON referral.referral_reward_links
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON loyalty.reward_definitions;
CREATE POLICY tenant_isolation ON loyalty.reward_definitions
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON loyalty.rewards;
CREATE POLICY tenant_isolation ON loyalty.rewards
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON loyalty.reward_ledger_entries;
CREATE POLICY tenant_isolation ON loyalty.reward_ledger_entries
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON loyalty.gift_passes;
CREATE POLICY tenant_isolation ON loyalty.gift_passes
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON growth.campaigns;
CREATE POLICY tenant_isolation ON growth.campaigns
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON growth.campaign_versions;
CREATE POLICY tenant_isolation ON growth.campaign_versions
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON growth.audience_definitions;
CREATE POLICY tenant_isolation ON growth.audience_definitions
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON growth.audience_members;
CREATE POLICY tenant_isolation ON growth.audience_members
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON growth.creatives;
CREATE POLICY tenant_isolation ON growth.creatives
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON growth.attribution_touches;
CREATE POLICY tenant_isolation ON growth.attribution_touches
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON growth.conversion_events;
CREATE POLICY tenant_isolation ON growth.conversion_events
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON partners.partner_accounts;
CREATE POLICY tenant_isolation ON partners.partner_accounts
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON partners.partner_relationships;
CREATE POLICY tenant_isolation ON partners.partner_relationships
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON partners.partner_capabilities;
CREATE POLICY tenant_isolation ON partners.partner_capabilities
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON partners.reseller_credit_entries;
CREATE POLICY tenant_isolation ON partners.reseller_credit_entries
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON partners.reseller_credit_reservations;
CREATE POLICY tenant_isolation ON partners.reseller_credit_reservations
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON partners.reseller_price_books;
CREATE POLICY tenant_isolation ON partners.reseller_price_books
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON partners.reseller_orders;
CREATE POLICY tenant_isolation ON partners.reseller_orders
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON partners.learning_progress;
CREATE POLICY tenant_isolation ON partners.learning_progress
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON partners.partner_memberships;
CREATE POLICY tenant_isolation ON partners.partner_memberships
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
