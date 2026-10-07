-- 052 RLS rollout per domain: billing.* + finance.* (tenant-scoped tables).
-- Template from 042: ENABLE ROW LEVEL SECURITY + tenant_isolation policy
-- (USING/WITH CHECK on app.tenant_id, fail-closed when unset) + DML grants
-- to iptv_app. Migrations keep running as the owner role on a direct
-- connection; the app connects as iptv_app (see runbook
-- docs/10-operations/runbooks/rls-role-split-cutover.md).
--
-- Scope inventory (real, from db/migrations 005 + 018):
--   billing (8): charges, charge_provider_bindings, charge_attempts,
--     payments, refund_requests, refunds, tenant_channels, exceptions.
--   finance (4): financial_accounts, financial_transactions,
--     financial_ledger_entries, cost_allocations.
-- Every table above carries tenant_id uuid NOT NULL, so each gets the tenant
-- template. No allow-list exception policy is needed in this migration
-- (allow-list is EMPTY — asserted in db/tests/017).
--
-- Pre-context escape hatch (043 pattern): `billing.tenant_channels` is
-- RLS-enrolled here with a fail-closed `tenant_isolation` policy, so a
-- direct SELECT under `iptv_app` with no `app.tenant_id` set yet returns
-- 0 rows — the Asaas webhook ingress (`AsaasWebhookService.resolveChannel`)
-- runs exactly in that pre-context state and would 404 every delivery after
-- cutover. This migration adds ONE narrow hatch in the SAME file (atomic
-- pair, 049 precedent: enroll without the call-site swap breaks ingress):
-- `billing.resolve_tenant_channel(p_tenant_key text)`, owned by the
-- migration (owner) role, SECURITY DEFINER, fixed `search_path`, revoked
-- from PUBLIC, EXECUTE granted to `iptv_app` only. It returns the ACTIVE
-- channel row for the given routing key (tenant_id, channel,
-- webhook_secret_hash, status) and touches NO other table. The resolved
-- tenant_id feeds the tenant context for all subsequent work.
-- The app call-site swap lands in the same commit (atomic pair).
--
-- Deliberately NOT in this migration:
--   * No BYPASSRLS anywhere.
--   * No grants to outbox roles (`outbox_worker`/`outbox_executor` keep
--     their 050 EXECUTE-only boundary on platform.* and hold NOTHING here).
--   * No GRANT to PUBLIC.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iptv_app') THEN
        CREATE ROLE iptv_app LOGIN NOBYPASSRLS;
    END IF;
END $$;

GRANT USAGE ON SCHEMA billing TO iptv_app;
GRANT USAGE ON SCHEMA finance TO iptv_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON finance.financial_accounts TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance.financial_transactions TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance.financial_ledger_entries TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance.cost_allocations TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.charges TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.charge_provider_bindings TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.charge_attempts TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.payments TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.refund_requests TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.refunds TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.tenant_channels TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.exceptions TO iptv_app;

ALTER TABLE finance.financial_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.financial_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.financial_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.cost_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.charge_provider_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.charge_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.refund_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.tenant_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.exceptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON finance.financial_accounts;
CREATE POLICY tenant_isolation ON finance.financial_accounts
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON finance.financial_transactions;
CREATE POLICY tenant_isolation ON finance.financial_transactions
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON finance.financial_ledger_entries;
CREATE POLICY tenant_isolation ON finance.financial_ledger_entries
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON finance.cost_allocations;
CREATE POLICY tenant_isolation ON finance.cost_allocations
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON billing.charges;
CREATE POLICY tenant_isolation ON billing.charges
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON billing.charge_provider_bindings;
CREATE POLICY tenant_isolation ON billing.charge_provider_bindings
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON billing.charge_attempts;
CREATE POLICY tenant_isolation ON billing.charge_attempts
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON billing.payments;
CREATE POLICY tenant_isolation ON billing.payments
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON billing.refund_requests;
CREATE POLICY tenant_isolation ON billing.refund_requests
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON billing.refunds;
CREATE POLICY tenant_isolation ON billing.refunds
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON billing.tenant_channels;
CREATE POLICY tenant_isolation ON billing.tenant_channels
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON billing.exceptions;
CREATE POLICY tenant_isolation ON billing.exceptions
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Pre-context resolver (043-shaped, billing scope). See header.
CREATE OR REPLACE FUNCTION billing.resolve_tenant_channel(p_tenant_key text)
RETURNS TABLE (
    tenant_id uuid,
    channel text,
    webhook_secret_hash text,
    status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = billing, pg_temp
AS $$
    SELECT c.tenant_id, c.channel, c.webhook_secret_hash, c.status
    FROM billing.tenant_channels AS c
    WHERE c.tenant_key = p_tenant_key
      AND c.status = 'ACTIVE';
$$;

-- Fixed owner: the migration (owner) role must own the definer function,
-- otherwise the RLS bypass runs with the wrong identity. The runner
-- connects as the owner, so this is a no-op in the normal path and a
-- hard guarantee after privileged restores (043 pattern).
DO $$
DECLARE
    v_owner name;
BEGIN
    SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'billing' AND c.relname = 'tenant_channels';
    IF v_owner IS NOT NULL THEN
        EXECUTE format(
            'ALTER FUNCTION billing.resolve_tenant_channel(text) OWNER TO %I',
            v_owner
        );
    END IF;
END $$;

REVOKE ALL ON FUNCTION billing.resolve_tenant_channel(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.resolve_tenant_channel(text) TO iptv_app;

COMMIT;
