-- 055 RLS rollout per domain: subscription.* + commerce.* + catalog.* +
-- inventory.* + trial.* + entitlement.* + provider.* + renewal.*
-- (tenant-scoped transactional tables).
-- Template from 042/052: ENABLE ROW LEVEL SECURITY + tenant_isolation policy
-- (USING/WITH CHECK on app.tenant_id, fail-closed when unset) + DML grants
-- to iptv_app. Migrations keep running as the owner role on a direct
-- connection; the app connects as iptv_app (see runbook
-- docs/10-operations/runbooks/rls-role-split-cutover.md).
--
-- Scope inventory (real, from db/migrations 003/004/006/007/008/020/022/024/025/026):
--   subscription (5): subscriptions, subscription_cycles, subscription_addons,
--     subscription_addon_cycle_charges, trust_renewal_grants (020).
--   commerce (3): orders, order_items, price_snapshots.
--   catalog (8): products, plans, addons, prices, offers, offer_items,
--     coupons, coupon_redemptions.
--   inventory (12): suppliers, supplier_offers, provider_credit_batches,
--     provider_credit_entries, supplier_app_snapshots + supplier_app_items
--     (022), app_trials (024), supplier_balance_snapshots +
--     credit_reservations + procurement_orders (025), license_assets +
--     reconciliation_findings (026).
--   trial (7): trial_eligibility_decisions, trials, trial_attempts,
--     trial_technical_results, device_profiles, network_observations,
--     compatibility_observations.
--   entitlement (2): entitlements, entitlement_grants.
--   provider (6): provider_accounts, provider_bindings, provider_operations,
--     provider_operation_attempts, provider_evidence, provider_health_snapshots.
--   renewal (1): recovery_tasks (020).
-- Every table above carries tenant_id uuid NOT NULL, so each gets the tenant
-- template. Total: 44 tables.
--
-- Deliberately NOT in this migration (documented allow-list, slice 056):
--   * provider.providers — GLOBAL table (no tenant_id column at all).
--   * trial.app_profiles — hybrid (tenant_id NULLABLE); needs its own
--     global+own policy shape, not the pure tenant template.
--   * No dispatcher/scheduler/admin tables, no controller call-site swaps.
-- Asserted in db/tests/022: the only scope tables without the enrolled
-- tenant template are exactly those two.
--
-- Deliberately NOT in this migration:
--   * No BYPASSRLS anywhere.
--   * No grants to outbox roles (`outbox_worker`/`outbox_executor` keep
--     their 050 EXECUTE-only boundary on platform.* and hold NOTHING here).
--   * No GRANT to PUBLIC.
--   * No pre-context resolver: no ingress in this slice runs pre-context
--     (call-site swaps, if any, land in 056 with their hatch, 052 precedent).
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iptv_app') THEN
        CREATE ROLE iptv_app LOGIN NOBYPASSRLS;
    END IF;
END $$;

GRANT USAGE ON SCHEMA subscription TO iptv_app;
GRANT USAGE ON SCHEMA commerce TO iptv_app;
GRANT USAGE ON SCHEMA catalog TO iptv_app;
GRANT USAGE ON SCHEMA inventory TO iptv_app;
GRANT USAGE ON SCHEMA trial TO iptv_app;
GRANT USAGE ON SCHEMA entitlement TO iptv_app;
GRANT USAGE ON SCHEMA provider TO iptv_app;
GRANT USAGE ON SCHEMA renewal TO iptv_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON subscription.subscriptions TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON subscription.subscription_cycles TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON subscription.subscription_addons TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON subscription.subscription_addon_cycle_charges TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON subscription.trust_renewal_grants TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON commerce.orders TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON commerce.order_items TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON commerce.price_snapshots TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.products TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.plans TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.addons TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.prices TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.offers TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.offer_items TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.coupons TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.coupon_redemptions TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.suppliers TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.supplier_offers TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.provider_credit_batches TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.provider_credit_entries TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.supplier_app_snapshots TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.supplier_app_items TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.app_trials TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.supplier_balance_snapshots TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.credit_reservations TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.procurement_orders TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.license_assets TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.reconciliation_findings TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON trial.trial_eligibility_decisions TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON trial.trials TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON trial.trial_attempts TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON trial.trial_technical_results TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON trial.device_profiles TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON trial.network_observations TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON trial.compatibility_observations TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON entitlement.entitlements TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON entitlement.entitlement_grants TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON provider.provider_accounts TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON provider.provider_bindings TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON provider.provider_operations TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON provider.provider_operation_attempts TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON provider.provider_evidence TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON provider.provider_health_snapshots TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON renewal.recovery_tasks TO iptv_app;

ALTER TABLE subscription.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription.subscription_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription.subscription_addons ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription.subscription_addon_cycle_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription.trust_renewal_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.price_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.addons ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.offer_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.coupon_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.supplier_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.provider_credit_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.provider_credit_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.supplier_app_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.supplier_app_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.app_trials ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.supplier_balance_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.credit_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.procurement_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.license_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.reconciliation_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE trial.trial_eligibility_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE trial.trials ENABLE ROW LEVEL SECURITY;
ALTER TABLE trial.trial_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE trial.trial_technical_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE trial.device_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE trial.network_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE trial.compatibility_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement.entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement.entitlement_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider.provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider.provider_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider.provider_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider.provider_operation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider.provider_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider.provider_health_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE renewal.recovery_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON subscription.subscriptions;
CREATE POLICY tenant_isolation ON subscription.subscriptions
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON subscription.subscription_cycles;
CREATE POLICY tenant_isolation ON subscription.subscription_cycles
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON subscription.subscription_addons;
CREATE POLICY tenant_isolation ON subscription.subscription_addons
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON subscription.subscription_addon_cycle_charges;
CREATE POLICY tenant_isolation ON subscription.subscription_addon_cycle_charges
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON subscription.trust_renewal_grants;
CREATE POLICY tenant_isolation ON subscription.trust_renewal_grants
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON commerce.orders;
CREATE POLICY tenant_isolation ON commerce.orders
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON commerce.order_items;
CREATE POLICY tenant_isolation ON commerce.order_items
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON commerce.price_snapshots;
CREATE POLICY tenant_isolation ON commerce.price_snapshots
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON catalog.products;
CREATE POLICY tenant_isolation ON catalog.products
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON catalog.plans;
CREATE POLICY tenant_isolation ON catalog.plans
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON catalog.addons;
CREATE POLICY tenant_isolation ON catalog.addons
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON catalog.prices;
CREATE POLICY tenant_isolation ON catalog.prices
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON catalog.offers;
CREATE POLICY tenant_isolation ON catalog.offers
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON catalog.offer_items;
CREATE POLICY tenant_isolation ON catalog.offer_items
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON catalog.coupons;
CREATE POLICY tenant_isolation ON catalog.coupons
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON catalog.coupon_redemptions;
CREATE POLICY tenant_isolation ON catalog.coupon_redemptions
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON inventory.suppliers;
CREATE POLICY tenant_isolation ON inventory.suppliers
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON inventory.supplier_offers;
CREATE POLICY tenant_isolation ON inventory.supplier_offers
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON inventory.provider_credit_batches;
CREATE POLICY tenant_isolation ON inventory.provider_credit_batches
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON inventory.provider_credit_entries;
CREATE POLICY tenant_isolation ON inventory.provider_credit_entries
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON inventory.supplier_app_snapshots;
CREATE POLICY tenant_isolation ON inventory.supplier_app_snapshots
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON inventory.supplier_app_items;
CREATE POLICY tenant_isolation ON inventory.supplier_app_items
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON inventory.app_trials;
CREATE POLICY tenant_isolation ON inventory.app_trials
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON inventory.supplier_balance_snapshots;
CREATE POLICY tenant_isolation ON inventory.supplier_balance_snapshots
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON inventory.credit_reservations;
CREATE POLICY tenant_isolation ON inventory.credit_reservations
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON inventory.procurement_orders;
CREATE POLICY tenant_isolation ON inventory.procurement_orders
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON inventory.license_assets;
CREATE POLICY tenant_isolation ON inventory.license_assets
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON inventory.reconciliation_findings;
CREATE POLICY tenant_isolation ON inventory.reconciliation_findings
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON trial.trial_eligibility_decisions;
CREATE POLICY tenant_isolation ON trial.trial_eligibility_decisions
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON trial.trials;
CREATE POLICY tenant_isolation ON trial.trials
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON trial.trial_attempts;
CREATE POLICY tenant_isolation ON trial.trial_attempts
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON trial.trial_technical_results;
CREATE POLICY tenant_isolation ON trial.trial_technical_results
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON trial.device_profiles;
CREATE POLICY tenant_isolation ON trial.device_profiles
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON trial.network_observations;
CREATE POLICY tenant_isolation ON trial.network_observations
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON trial.compatibility_observations;
CREATE POLICY tenant_isolation ON trial.compatibility_observations
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON entitlement.entitlements;
CREATE POLICY tenant_isolation ON entitlement.entitlements
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON entitlement.entitlement_grants;
CREATE POLICY tenant_isolation ON entitlement.entitlement_grants
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON provider.provider_accounts;
CREATE POLICY tenant_isolation ON provider.provider_accounts
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON provider.provider_bindings;
CREATE POLICY tenant_isolation ON provider.provider_bindings
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON provider.provider_operations;
CREATE POLICY tenant_isolation ON provider.provider_operations
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON provider.provider_operation_attempts;
CREATE POLICY tenant_isolation ON provider.provider_operation_attempts
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON provider.provider_evidence;
CREATE POLICY tenant_isolation ON provider.provider_evidence
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON provider.provider_health_snapshots;
CREATE POLICY tenant_isolation ON provider.provider_health_snapshots
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON renewal.recovery_tasks;
CREATE POLICY tenant_isolation ON renewal.recovery_tasks
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
