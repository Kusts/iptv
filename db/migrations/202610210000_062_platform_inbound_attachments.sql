-- 062 Platform inbound attachment blobs (EXEC-WAHA-MEDIA-FETCH-20261020).
--
-- Persistent tenant-scoped backing for the WAHA inbound media registry
-- (`apps/api/src/communications/waha-inbound-attachments.ts`). Until this
-- migration a verified inbound download could not be durably persisted: the
-- webhook recorded it on the manual-resolution exception queue with
-- `ingestPending: true` and no message row. This table stores the REAL
-- fetched bytes behind an opaque tenant-scoped `ref`, so `message.ingest`
-- carries the real content type + ref instead of `media_unavailable`.
--
-- Why NOT reuse `platform.outbound_attachments` (061): that table records
-- operator/customer-authorized uploads for SENDING — its AUDIO lane requires
-- `customerAuthorized: true`, a consent gate that governs sending and is
-- meaningless for RECEIVED provider bytes. Reusing it would either block all
-- inbound audio or force a bypass of the outbound consent gate, and would
-- conflate the two directions in audit. 062 therefore mirrors the 061 shape
-- (immutable blobs, tenant-scoped opaque ref, same caps ceiling) under a
-- direction-explicit name.
--
-- Shape: one row per fetched inbound blob. `ref` is opaque (`in-` + 32 hex,
-- see `INBOUND_REF_PATTERN`) and unique per tenant; `kind` mirrors the
-- `WahaMediaContentType` vocabulary (IMAGE/DOCUMENT/AUDIO/VIDEO); `content`
-- is the authoritative bytea; `size_bytes`/`sha256` are recorded at insert
-- for cheap rechecks. Rows are immutable by convention (no UPDATE path in
-- the app; only SELECT + INSERT grants below).
--
-- RLS enrollment (052 template): `tenant_isolation` USING/WITH CHECK on
-- `app.tenant_id`, fail-closed when unset. DML grants to `iptv_app` only.
--
-- Deliberately NOT in this migration:
--   * No BYPASSRLS anywhere.
--   * No grants to outbox roles (`outbox_worker`/`outbox_executor` keep
--     their 050 EXECUTE-only boundary on platform.* and hold NOTHING here).
--   * No GRANT to PUBLIC (explicitly revoked).
--   * No change to 001-061 (append-only).
-- Migrations keep running as the owner role on a direct connection.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iptv_app') THEN
        CREATE ROLE iptv_app LOGIN NOBYPASSRLS;
    END IF;
END $$;

CREATE TABLE platform.inbound_attachments (
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
    CONSTRAINT inbound_attachments_ref_not_blank CHECK (btrim(ref) <> ''),
    CONSTRAINT inbound_attachments_kind_check CHECK (kind IN ('IMAGE', 'DOCUMENT', 'AUDIO', 'VIDEO')),
    CONSTRAINT inbound_attachments_mime_not_blank CHECK (btrim(mime_type) <> ''),
    CONSTRAINT inbound_attachments_size_check CHECK (size_bytes > 0 AND size_bytes <= 33554432),
    CONSTRAINT inbound_attachments_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT inbound_attachments_tenant_ref_unique UNIQUE (tenant_id, ref)
);

CREATE INDEX inbound_attachments_tenant_ref_idx
    ON platform.inbound_attachments (tenant_id, ref);

-- Least privilege for an immutable blob store: the app reads rows to
-- resolve inbound refs and inserts rows on verified ingest. No UPDATE/DELETE
-- grants, and no UPDATE/DELETE path exists in the application.
GRANT USAGE ON SCHEMA platform TO iptv_app;
GRANT SELECT, INSERT ON platform.inbound_attachments TO iptv_app;
REVOKE ALL ON TABLE platform.inbound_attachments FROM PUBLIC;

ALTER TABLE platform.inbound_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON platform.inbound_attachments;
CREATE POLICY tenant_isolation ON platform.inbound_attachments
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
