-- 067 WAHA per-tenant session binding (S3a, #87).
--
-- `communication.tenant_channels` (WHATSAPP row) gains the persistent
-- tenant<->WAHA-session binding that `apps/api/src/communications/
-- waha-sessions.ts` keeps only in a process-local Map today (with an
-- env-shared `WAHA_SESSION=default` fallback). Columns:
--   * `waha_session_name` — the exclusive WAHA session provisioned for
--     this tenant (`tenant-<12hex>`); NULL until S3a provisions it.
--   * `waha_status` — last observed WAHA session status, verbatim
--     (`STOPPED`/`STARTING`/`SCAN_QR_CODE`/`WORKING`/`FAILED`/…), refreshed
--     on status reads and lifecycle commands. Free-form on purpose: pinning
--     an enum here would require a migration on every WAHA version bump;
--     sanitization (length cap, no secrets) happens app-side.
--
-- A partial UNIQUE index on `waha_session_name` (non-NULL only) makes a
-- double-binding fail loudly instead of silently sharing one session
-- between two tenants. NULLs (unprovisioned tenants) never collide.
--
-- Plus ONE narrow SECURITY DEFINER lookup, mirroring migration 043:
-- `communication.resolve_waha_session_owner(p_session_name)` returns the
-- tenant bound to a WAHA session (or NULL). The inbound guards
-- (`waha-session-store.ts`) need it because the cross-tenant check must see
-- past the caller's RLS context: under tenant B's `app.tenant_id`, a direct
-- SELECT for "who owns session X" only ever sees B's own rows and could
-- never detect that X belongs to A. The function touches NO other table,
-- returns only the owning tenant id, and is EXECUTE-restricted to
-- `iptv_app` like the 043 resolver.
--
-- Roll-forward CREATE-only; existing migrations untouched.
BEGIN;

ALTER TABLE communication.tenant_channels
    ADD COLUMN waha_session_name text,
    ADD COLUMN waha_status text;

ALTER TABLE communication.tenant_channels
    ADD CONSTRAINT tenant_channels_waha_session_name_not_blank CHECK (
        waha_session_name IS NULL OR btrim(waha_session_name) <> ''
    ),
    ADD CONSTRAINT tenant_channels_waha_status_not_blank CHECK (
        waha_status IS NULL OR btrim(waha_status) <> ''
    );

CREATE UNIQUE INDEX tenant_channels_waha_session_unique_idx
    ON communication.tenant_channels (waha_session_name)
    WHERE waha_session_name IS NOT NULL;

CREATE OR REPLACE FUNCTION communication.resolve_waha_session_owner(p_session_name text)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = communication, pg_temp
AS $$
    SELECT c.tenant_id
    FROM communication.tenant_channels AS c
    WHERE c.channel = 'WHATSAPP'
      AND c.status = 'ACTIVE'
      AND c.waha_session_name = p_session_name
    LIMIT 1;
$$;

-- Fixed owner: the migration (owner) role must own the definer function,
-- otherwise the RLS bypass runs with the wrong identity. The runner
-- connects as the owner, so this is a no-op in the normal path and a hard
-- guarantee after privileged restores.
DO $$
DECLARE
    v_owner name;
BEGIN
    SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'communication' AND c.relname = 'tenant_channels';
    IF v_owner IS NOT NULL THEN
        EXECUTE format(
            'ALTER FUNCTION communication.resolve_waha_session_owner(text) OWNER TO %I',
            v_owner
        );
    END IF;
END $$;

REVOKE ALL ON FUNCTION communication.resolve_waha_session_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION communication.resolve_waha_session_owner(text) TO iptv_app;

COMMIT;
