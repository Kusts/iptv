-- 059 RLS rollout per domain: analytics.* + experiments.* +
-- security.risk_assessments (tenant-scoped analytical tables).
-- Template from 042/052/055/057/058: ENABLE ROW LEVEL SECURITY +
-- tenant_isolation policy (USING/WITH CHECK on app.tenant_id, fail-closed
-- when unset) + DML grants to iptv_app. Migrations keep running as the
-- owner role on a direct connection; the app connects as iptv_app (see
-- runbook docs/10-operations/runbooks/rls-role-split-cutover.md).
--
-- Scope inventory (real, from db/migrations 001/036/039):
--   analytics (2): metric_definitions, metric_snapshots (036).
--   experiments (3): experiments, experiment_assignments,
--     experiment_exposures (039).
--   security (1): risk_assessments (001).
-- Every table above carries tenant_id uuid NOT NULL, so each gets the
-- tenant template. Total: 6 tables. No exception: each of the three
-- schemas holds exactly these tenant_id tables and no tenant_id-less
-- GLOBAL table (asserted in db/tests/026).
--
-- Call-site note: analytics readers already run inside
-- `withTenantTransaction` (P1.5-058 wraps in
-- apps/api/src/analytics/analytics.controller.ts, including the recompute
-- write path); experiments command writes already run inside the
-- command-bus tenant transaction (KyselyCommandDb.withTransaction).
-- The experiments controller direct reads (list/get/aggregate/flag
-- evaluation) are wrapped in the same commit (052/055/057/058 precedent
-- for the atomic pair). security.risk_assessments has no app reader
-- (inventory: zero qualified mentions) — enrolled with no call-site swap.
--
-- Deliberately NOT in this migration:
--   * No BYPASSRLS anywhere.
--   * No grants to outbox roles (`outbox_worker`/`outbox_executor` keep
--     their 050 EXECUTE-only boundary on platform.* and hold NOTHING here).
--   * No GRANT to PUBLIC.
--   * No pre-context resolver: no ingress in this slice runs pre-context.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iptv_app') THEN
        CREATE ROLE iptv_app LOGIN NOBYPASSRLS;
    END IF;
END $$;

GRANT USAGE ON SCHEMA analytics TO iptv_app;
GRANT USAGE ON SCHEMA experiments TO iptv_app;
GRANT USAGE ON SCHEMA security TO iptv_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.metric_definitions TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.metric_snapshots TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON experiments.experiments TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON experiments.experiment_assignments TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON experiments.experiment_exposures TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON security.risk_assessments TO iptv_app;

ALTER TABLE analytics.metric_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.metric_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiments.experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiments.experiment_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiments.experiment_exposures ENABLE ROW LEVEL SECURITY;
ALTER TABLE security.risk_assessments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON analytics.metric_definitions;
CREATE POLICY tenant_isolation ON analytics.metric_definitions
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON analytics.metric_snapshots;
CREATE POLICY tenant_isolation ON analytics.metric_snapshots
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON experiments.experiments;
CREATE POLICY tenant_isolation ON experiments.experiments
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON experiments.experiment_assignments;
CREATE POLICY tenant_isolation ON experiments.experiment_assignments
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON experiments.experiment_exposures;
CREATE POLICY tenant_isolation ON experiments.experiment_exposures
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON security.risk_assessments;
CREATE POLICY tenant_isolation ON security.risk_assessments
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
