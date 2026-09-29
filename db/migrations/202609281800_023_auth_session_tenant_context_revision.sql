-- IPTV Platform
-- Migration 023: per-session monotonic tenant-context revision
--
-- Design notes:
-- - `control.auth_sessions.tenant_context_revision` is a per-session
--   monotonic counter (BIGINT, DEFAULT 0, >= 0) that increments atomically
--   on every successful tenant switch (compare-and-swap on the revision).
-- - Purpose: close stale-request and serialized/ABA switch races. A request
--   that started from revision N fails after any successful intervening
--   switch, including A -> B -> A (the revision moved N -> N+1 -> N+2 even
--   though the active tenant is A again).
-- - Represented as a canonical decimal string end-to-end (TS/API) so JS
--   number precision is never involved; node-pg returns BIGINT as text.

BEGIN;

ALTER TABLE control.auth_sessions
    ADD COLUMN tenant_context_revision bigint NOT NULL DEFAULT 0;

ALTER TABLE control.auth_sessions
    ADD CONSTRAINT auth_sessions_tenant_context_revision_check
    CHECK (tenant_context_revision >= 0);

COMMIT;
