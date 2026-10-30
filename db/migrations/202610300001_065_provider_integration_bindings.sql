-- 065 S1 provider integration bindings (SPEC S1 §4; decision S1-DESIGN-R2).
--
-- Extends `provider.provider_accounts` in place for tenant self-service
-- integrations (Asaas / WhatsApp-WAHA / CINEVISION). NO new generic table
-- in the MVP: `provider_accounts` is already tenant-scoped, RLS-enrolled
-- (055), and referenced by bindings/operations, so a parallel
-- `platform.tenant_integrations` table would duplicate authority.
--
-- New columns:
--   environment        SANDBOX | PRODUCTION, NOT NULL DEFAULT 'SANDBOX'.
--                      SANDBOX-by-default is fail-closed for money: a row
--                      whose environment was never stated is treated as
--                      non-production until an operator explicitly promotes
--                      it during revalidation.
--   connection_status  NOT_CONFIGURED | DRAFT | TESTING |
--                      CONNECTED_READ_ONLY | REAUTH_REQUIRED | DEGRADED |
--                      DISABLED, NOT NULL DEFAULT 'NOT_CONFIGURED'.
--                      The connection state NEVER grants capability: reads
--                      vs. writes stay gated by `platform.capabilities`
--                      (SPEC S1 §2, S1 §8).
--   last_checked_at    timestamptz NULL (last read-only health probe).
--   last_error_code    text NULL, sanitized machine code only
--                      (INVALID_CREDENTIALS, PROVIDER_UNAVAILABLE, ...).
--                      NEVER secret material, tokens, or raw provider
--                      payloads; the CHECK below only rejects blank codes.
--   version            integer NOT NULL DEFAULT 1, CHECK >= 1: optimistic
--                      locking token for the configure/test/rotate API
--                      (SPEC S1 §4: expected-version writes).
--
-- DECISION secret_ref (stays NOT NULL — chosen option, with rationale):
-- the row is created ONLY at configure time with the vault secret already
-- provisioned server-side (Infisical writer, S2 scope). DRAFT lives as
-- `connection_status` on a real row, never as a secretless placeholder:
-- allowing NULL/blank refs would let the dispatcher resolve bindings with
-- no resolvable credential and would silently widen every
-- `secret_ref IS NOT NULL` consumer assumption (provider-secret-gate,
-- dispatcher). A future pre-provisioned-row flow needs its own migration
-- with an explicit backfill, not a quiet nullability relax here.
--
-- Backfill (fail-closed): pre-065 rows keep environment='SANDBOX' (column
-- default; an operator promotes verified production accounts to
-- PRODUCTION during revalidation) and are promoted to
-- connection_status='REAUTH_REQUIRED' by the UPDATE below. Rationale: no
-- proof exists that a legacy row would pass the S1 read-only validation,
-- so claiming CONNECTED_READ_ONLY without a test would be dishonest; the
-- UPDATE only touches rows still on the NOT_CONFIGURED default, so it is
-- rerun-safe and never downgrades an explicitly set status.
--
-- Uniqueness: one LIVE binding per (tenant_id, provider_id, environment).
-- Partial (WHERE connection_status <> 'DISABLED'): DISABLED rows are
-- history (disable pauses new effects, never deletes evidence — SPEC S1
-- §3), so a fresh configure after disable must not collide with them.
-- Multi-account per provider stays post-MVP; the contract does not block
-- it (a later migration can scope the key down, e.g. + account ref).
-- Preflight aborts (fail-closed, 064 precedent) when existing live rows
-- already share a key: the operator reconciles (disable/supersede
-- duplicates) and re-runs; nothing is repaired or deleted here.
--
-- RLS/grants: re-asserts the 055 tenant template verbatim
-- (ENABLE RLS + DROP/CREATE tenant_isolation + full DML to iptv_app).
-- Deliberately NOT in this migration:
--   * No BYPASSRLS, no GRANT to PUBLIC, no outbox-role grants (050
--     EXECUTE-only boundary preserved).
--   * No change to 001–064 (append-only), no data repair/deletion.
--   * No pre-context resolver, no capability rows, no API changes.
--
-- Rerun-safe: IF NOT EXISTS / DROP IF EXISTS + default-guarded backfill.

BEGIN;

-- 0) Columns (rerun-safe).
ALTER TABLE provider.provider_accounts
    ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'SANDBOX',
    ADD COLUMN IF NOT EXISTS connection_status text NOT NULL DEFAULT 'NOT_CONFIGURED',
    ADD COLUMN IF NOT EXISTS last_checked_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_error_code text,
    ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- 1) State-machine CHECKs (rerun-safe: drop-then-add is idempotent and
-- keeps the definition identical on re-apply).
ALTER TABLE provider.provider_accounts
    DROP CONSTRAINT IF EXISTS provider_accounts_environment_check;
ALTER TABLE provider.provider_accounts
    ADD CONSTRAINT provider_accounts_environment_check
    CHECK (environment IN ('SANDBOX', 'PRODUCTION'));

ALTER TABLE provider.provider_accounts
    DROP CONSTRAINT IF EXISTS provider_accounts_connection_status_check;
ALTER TABLE provider.provider_accounts
    ADD CONSTRAINT provider_accounts_connection_status_check
    CHECK (connection_status IN (
        'NOT_CONFIGURED', 'DRAFT', 'TESTING', 'CONNECTED_READ_ONLY',
        'REAUTH_REQUIRED', 'DEGRADED', 'DISABLED'
    ));

ALTER TABLE provider.provider_accounts
    DROP CONSTRAINT IF EXISTS provider_accounts_version_check;
ALTER TABLE provider.provider_accounts
    ADD CONSTRAINT provider_accounts_version_check
    CHECK (version >= 1);

ALTER TABLE provider.provider_accounts
    DROP CONSTRAINT IF EXISTS provider_accounts_last_error_code_check;
ALTER TABLE provider.provider_accounts
    ADD CONSTRAINT provider_accounts_last_error_code_check
    CHECK (last_error_code IS NULL OR btrim(last_error_code) <> '');

-- 2) Preflight (fail-closed): live rows must already key uniquely, else
-- abort with operator guidance instead of building a dishonest index.
DO $$
DECLARE
    v_dup integer;
    v_sample text;
BEGIN
    SELECT count(*), coalesce(max(sub.key_text), '')
      INTO v_dup, v_sample
    FROM (
        SELECT tenant_id::text || '/' || provider_id::text || '/' || environment AS key_text,
               count(*) AS n
        FROM provider.provider_accounts
        WHERE connection_status <> 'DISABLED'
        GROUP BY tenant_id, provider_id, environment
        HAVING count(*) > 1
    ) AS sub;
    IF v_dup > 0 THEN
        RAISE EXCEPTION 'migration 065 preflight: % live (tenant, provider, environment) key(s) are shared (e.g. %); reconcile by disabling/superseding duplicate bindings, then re-run; nothing was repaired or deleted',
            v_dup, v_sample;
    END IF;
END $$;

-- 3) Backfill (fail-closed, rerun-safe): only still-default rows move to
-- REAUTH_REQUIRED; environment stays on the SANDBOX default (see header).
UPDATE provider.provider_accounts
SET connection_status = 'REAUTH_REQUIRED'
WHERE connection_status = 'NOT_CONFIGURED';

-- 4) Partial unique: one live binding per (tenant, provider, environment).
CREATE UNIQUE INDEX IF NOT EXISTS provider_accounts_tenant_provider_env_uniq
    ON provider.provider_accounts (tenant_id, provider_id, environment)
    WHERE connection_status <> 'DISABLED';

-- 5) RLS + grants re-assertion (055 tenant template, verbatim).
ALTER TABLE provider.provider_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON provider.provider_accounts;
CREATE POLICY tenant_isolation ON provider.provider_accounts
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON provider.provider_accounts TO iptv_app;

-- 6) Decision record on the catalog (survives pg_dump, visible to reviewers).
COMMENT ON COLUMN provider.provider_accounts.environment IS
    'S1 (065): SANDBOX|PRODUCTION, default SANDBOX fail-closed. Pre-065 rows keep SANDBOX until an operator promotes them during revalidation.';
COMMENT ON COLUMN provider.provider_accounts.connection_status IS
    'S1 (065): NOT_CONFIGURED|DRAFT|TESTING|CONNECTED_READ_ONLY|REAUTH_REQUIRED|DEGRADED|DISABLED. Connection state grants no capability; pre-065 rows backfilled fail-closed to REAUTH_REQUIRED (never CONNECTED_* without a test).';
COMMENT ON COLUMN provider.provider_accounts.secret_ref IS
    'S1 (065, S1-DESIGN-R2): stays NOT NULL. Rows are created only at configure with the vault secret provisioned server-side; no secretless placeholders.';
COMMENT ON COLUMN provider.provider_accounts.last_error_code IS
    'S1 (065): sanitized machine code only (e.g. INVALID_CREDENTIALS). NEVER secret material, tokens, or raw provider payloads.';
COMMENT ON COLUMN provider.provider_accounts.version IS
    'S1 (065): optimistic locking token for configure/test/rotate writes, >= 1.';

COMMIT;
