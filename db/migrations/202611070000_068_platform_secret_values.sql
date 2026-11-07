-- 068 replaces the Infisical runtime vault with AES-256-GCM ciphertext stored
-- in PostgreSQL. Ciphertext only, never plaintext; one row per
-- (tenant, secret_ref). Refs retain the domain `secret_ref` value, so legacy
-- `infisical://` and new `pgsecret://` rows both resolve by exact ref.

BEGIN;

CREATE TABLE IF NOT EXISTS platform.secret_values (
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    secret_ref text NOT NULL,
    ciphertext text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT secret_values_pkey PRIMARY KEY (tenant_id, secret_ref),
    CONSTRAINT secret_values_ref_not_blank CHECK (btrim(secret_ref) <> ''),
    CONSTRAINT secret_values_ciphertext_shape CHECK (ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
);

ALTER TABLE platform.secret_values ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON platform.secret_values;
CREATE POLICY tenant_isolation ON platform.secret_values
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON platform.secret_values TO iptv_app;

COMMENT ON TABLE platform.secret_values IS
    'Tenant-scoped AES-256-GCM encrypted secret values; ciphertext only, never plaintext.';
COMMENT ON COLUMN platform.secret_values.ciphertext IS
    'AES-256-GCM format v1.<iv>.<tag>.<ciphertext>, base64url; AAD binds tenant+ref; NEVER plaintext.';

COMMIT;
