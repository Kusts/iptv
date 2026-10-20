-- 061 Platform outbound attachment blobs (EXEC-WAHA-BACKING-20261020).
--
-- Persistent tenant-scoped backing for the WAHA outbound attachment registry
-- (`apps/api/src/communications/waha-outbound-attachments.ts`). Until this
-- migration the default store was an empty fail-closed registry: every
-- `message.send_media_manual` resolution refused because no attachment table
-- existed. This table stores the REAL bytes behind an opaque tenant-scoped
-- `ref`, so caps/MIME are validated against stored content (never
-- caller-declared fields) and free-URL refs never reach the gateway.
--
-- Shape: one row per uploaded blob. `ref` is opaque (letters/digits/`._-`,
-- see `OUTBOUND_REF_PATTERN`) and unique per tenant; `kind` mirrors the
-- `SendMediaKind` vocabulary (IMAGE/DOCUMENT/AUDIO/VIDEO); `content` is the
-- authoritative bytea; `size_bytes`/`sha256` are recorded at insert for
-- cheap rechecks. Rows are immutable by convention (no UPDATE path in the
-- app; only SELECT + INSERT grants below).
--
-- RLS enrollment (052 template): `tenant_isolation` USING/WITH CHECK on
-- `app.tenant_id`, fail-closed when unset. DML grants to `iptv_app` only.
--
-- Deliberately NOT in this migration:
--   * No BYPASSRLS anywhere.
--   * No grants to outbox roles (`outbox_worker`/`outbox_executor` keep
--     their 050 EXECUTE-only boundary on platform.* and hold NOTHING here).
--   * No GRANT to PUBLIC (explicitly revoked).
--   * No change to 001-060 (append-only).
-- Migrations keep running as the owner role on a direct connection.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iptv_app') THEN
        CREATE ROLE iptv_app LOGIN NOBYPASSRLS;
    END IF;
END $$;

CREATE TABLE platform.outbound_attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants (id),
    ref text NOT NULL,
    kind text NOT NULL,
    mime_type text NOT NULL,
    file_name text NULL,
    content bytea NOT NULL,
    size_bytes integer NOT NULL,
    sha256 text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT outbound_attachments_ref_not_blank CHECK (btrim(ref) <> ''),
    CONSTRAINT outbound_attachments_kind_check CHECK (kind IN ('IMAGE', 'DOCUMENT', 'AUDIO', 'VIDEO')),
    CONSTRAINT outbound_attachments_mime_not_blank CHECK (btrim(mime_type) <> ''),
    CONSTRAINT outbound_attachments_size_check CHECK (size_bytes > 0 AND size_bytes <= 33554432),
    CONSTRAINT outbound_attachments_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT outbound_attachments_tenant_ref_unique UNIQUE (tenant_id, ref)
);

CREATE INDEX outbound_attachments_tenant_ref_idx
    ON platform.outbound_attachments (tenant_id, ref);

-- Least privilege for an immutable blob store: the app reads rows to
-- resolve sends and inserts rows on upload. No UPDATE/DELETE grants, and
-- no UPDATE/DELETE path exists in the application.
GRANT USAGE ON SCHEMA platform TO iptv_app;
GRANT SELECT, INSERT ON platform.outbound_attachments TO iptv_app;
REVOKE ALL ON TABLE platform.outbound_attachments FROM PUBLIC;

ALTER TABLE platform.outbound_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON platform.outbound_attachments;
CREATE POLICY tenant_isolation ON platform.outbound_attachments
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
