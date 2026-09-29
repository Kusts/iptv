-- AI Revenue & Operations Platform
-- Migration 030: Growth authoritative unit cost (Wave 11 fixes)
--
-- - Adds `growth.campaign_versions.unit_cost_minor` (exact bigint minor
--   units, nullable for pre-fix rows): the ONLY authority for per-contact
--   budget accounting at schedule time. Caller-supplied estimates are
--   accepted by the API for compatibility but never drive the cap; a
--   version without a unit cost blocks scheduling (fail-closed) instead
--   of letting a "0" estimate bypass the budget gate.

BEGIN;

ALTER TABLE growth.campaign_versions
    ADD COLUMN unit_cost_minor bigint;

ALTER TABLE growth.campaign_versions
    ADD CONSTRAINT campaign_versions_unit_cost_nonnegative
    CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0);

COMMIT;
