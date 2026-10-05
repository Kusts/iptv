-- 048 RLS policy split for control.feature_flags (append-only; supersedes the
-- single all-command `tenant_isolation` policy created by 047 — never edit
-- 047).
--
-- DEFECT FIXED (adversarial review 2026-10-05): one policy for ALL commands
-- let the app role STEAL or DESTROY global flag rows:
--   * UPDATE of a global row to `tenant_id = <own tenant>` satisfied the
--     single-policy WITH CHECK (which validates only the NEW row) — the
--     shared default disappeared for every other tenant;
--   * DELETE matched global rows through the USING side (which admitted
--     `tenant_id IS NULL`), and DELETE has no WITH CHECK at all.
--
-- Split semantics (fail-closed, unchanged for legitimate paths):
--   SELECT  — global defaults (tenant_id IS NULL) OR own-tenant overrides
--             (unchanged read behavior: tenant rows first, global fallback).
--   INSERT  — new rows must claim the CALLER'S tenant only: the app role can
--             never create global defaults (owner/operator concern).
--   UPDATE  — USING restricts to own-tenant rows (global rows are invisible
--             to UPDATE, so they can never be modified or re-tenant-claimed)
--             and WITH CHECK requires the resulting row to stay own-tenant.
--   DELETE  — USING restricts to own-tenant rows: global defaults are not
--             deletable through the app role.
-- The table owner (migrations/operator tooling) keeps bypassing RLS exactly
-- as before; only `iptv_app` is constrained.
BEGIN;

DROP POLICY IF EXISTS tenant_isolation ON control.feature_flags;

CREATE POLICY feature_flags_select ON control.feature_flags
    FOR SELECT
    USING (
        tenant_id IS NULL
        OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE POLICY feature_flags_insert ON control.feature_flags
    FOR INSERT
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY feature_flags_update ON control.feature_flags
    FOR UPDATE
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY feature_flags_delete ON control.feature_flags
    FOR DELETE
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
