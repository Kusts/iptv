-- 057 RLS rollout per domain: support.* + knowledge.* + agent.*
-- (tenant-scoped operational tables).
-- Template from 042/052/055: ENABLE ROW LEVEL SECURITY + tenant_isolation policy
-- (USING/WITH CHECK on app.tenant_id, fail-closed when unset) + DML grants
-- to iptv_app. Migrations keep running as the owner role on a direct
-- connection; the app connects as iptv_app (see runbook
-- docs/10-operations/runbooks/rls-role-split-cutover.md).
--
-- Scope inventory (real, from db/migrations 010/016/037/038/040):
--   support (7): incidents, problems, support_tickets,
--     ticket_incident_links, ticket_problem_links, solution_attempts (010),
--     technical_access_grants (040).
--   knowledge (9): knowledge_sources, knowledge_items, knowledge_versions,
--     knowledge_source_links, solutions, solution_outcomes (010),
--     knowledge_corrections, knowledge_gaps, knowledge_research_candidates
--     (038).
--   agent (5): human_review_requests, human_review_actions (010),
--     agent_runs, agent_tasks (016), copilot_review_consumptions (037).
-- Every table above carries tenant_id uuid NOT NULL, so each gets the tenant
-- template. Total: 21 tables.
--
-- Deliberately NOT in this migration (documented allow-list, slice 058):
--   * agent.agent_releases — GLOBAL catalog (no tenant_id column at all).
--   * partners.learning_content / partners.learning_content_versions —
--     GLOBAL academy catalog (no tenant_id column at all).
--   * referral/loyalty/growth/partners tenant tables (learning_progress and
--     the referral/loyalty/growth/partners scope) — slice 058.
-- Asserted in db/tests/024: the only scope tables without the enrolled
-- tenant template are exactly the documented globals above.
--
-- Deliberately NOT in this migration:
--   * No BYPASSRLS anywhere.
--   * No grants to outbox roles (`outbox_worker`/`outbox_executor` keep
--     their 050 EXECUTE-only boundary on platform.* and hold NOTHING here).
--   * No GRANT to PUBLIC.
--   * No pre-context resolver: no ingress in this slice runs pre-context
--     (call-site swaps are plain withTenantTransaction reader wraps, same
--     commit — 052/055 precedent for the atomic pair).
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iptv_app') THEN
        CREATE ROLE iptv_app LOGIN NOBYPASSRLS;
    END IF;
END $$;

GRANT USAGE ON SCHEMA support TO iptv_app;
GRANT USAGE ON SCHEMA knowledge TO iptv_app;
GRANT USAGE ON SCHEMA agent TO iptv_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON support.incidents TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON support.problems TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON support.support_tickets TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON support.ticket_incident_links TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON support.ticket_problem_links TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON support.solution_attempts TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON support.technical_access_grants TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge.knowledge_sources TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge.knowledge_items TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge.knowledge_versions TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge.knowledge_source_links TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge.solutions TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge.solution_outcomes TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge.knowledge_corrections TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge.knowledge_gaps TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge.knowledge_research_candidates TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent.human_review_requests TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent.human_review_actions TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent.agent_runs TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent.agent_tasks TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent.copilot_review_consumptions TO iptv_app;

ALTER TABLE support.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE support.problems ENABLE ROW LEVEL SECURITY;
ALTER TABLE support.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support.ticket_incident_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE support.ticket_problem_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE support.solution_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE support.technical_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.knowledge_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.knowledge_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.knowledge_source_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.solutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.solution_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.knowledge_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.knowledge_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.knowledge_research_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.human_review_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.human_review_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.copilot_review_consumptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON support.incidents;
CREATE POLICY tenant_isolation ON support.incidents
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON support.problems;
CREATE POLICY tenant_isolation ON support.problems
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON support.support_tickets;
CREATE POLICY tenant_isolation ON support.support_tickets
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON support.ticket_incident_links;
CREATE POLICY tenant_isolation ON support.ticket_incident_links
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON support.ticket_problem_links;
CREATE POLICY tenant_isolation ON support.ticket_problem_links
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON support.solution_attempts;
CREATE POLICY tenant_isolation ON support.solution_attempts
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON support.technical_access_grants;
CREATE POLICY tenant_isolation ON support.technical_access_grants
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON knowledge.knowledge_sources;
CREATE POLICY tenant_isolation ON knowledge.knowledge_sources
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON knowledge.knowledge_items;
CREATE POLICY tenant_isolation ON knowledge.knowledge_items
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON knowledge.knowledge_versions;
CREATE POLICY tenant_isolation ON knowledge.knowledge_versions
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON knowledge.knowledge_source_links;
CREATE POLICY tenant_isolation ON knowledge.knowledge_source_links
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON knowledge.solutions;
CREATE POLICY tenant_isolation ON knowledge.solutions
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON knowledge.solution_outcomes;
CREATE POLICY tenant_isolation ON knowledge.solution_outcomes
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON knowledge.knowledge_corrections;
CREATE POLICY tenant_isolation ON knowledge.knowledge_corrections
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON knowledge.knowledge_gaps;
CREATE POLICY tenant_isolation ON knowledge.knowledge_gaps
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON knowledge.knowledge_research_candidates;
CREATE POLICY tenant_isolation ON knowledge.knowledge_research_candidates
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON agent.human_review_requests;
CREATE POLICY tenant_isolation ON agent.human_review_requests
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON agent.human_review_actions;
CREATE POLICY tenant_isolation ON agent.human_review_actions
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON agent.agent_runs;
CREATE POLICY tenant_isolation ON agent.agent_runs
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON agent.agent_tasks;
CREATE POLICY tenant_isolation ON agent.agent_tasks
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON agent.copilot_review_consumptions;
CREATE POLICY tenant_isolation ON agent.copilot_review_consumptions
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
