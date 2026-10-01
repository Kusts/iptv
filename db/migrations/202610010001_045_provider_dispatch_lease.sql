-- AI Revenue & Operations Platform
-- Migration 045: Durable post-commit provider dispatch lease (CV-DSP-01).
--
-- Design notes:
-- - The secret-required `provider.request_operation` path can defer its
--   external port call past the request commit
--   (`PROVIDER_DISPATCH_MODE=durable`): the operation row stays REQUESTED
--   and the dispatcher claims it (`QUEUED` + lease), marks the send
--   frontier (`RUNNING` + `dispatch_started_at` on the operation AND its
--   `STARTED` attempt), then calls the port. A crash before the frontier
--   marker releases back to REQUESTED (safe re-execution); a crash after
--   it parks VERIFYING/UNKNOWN for readback (never blind retry).
-- - New columns are NULL-safe with no backfill: existing rows keep NULL
--   (unclaimed, never dispatched), so the migration is a pure roll-forward
--   ALTER TABLE set in the style of migration 017 (no IF NOT EXISTS).
-- - The recovery index is partial on the in-flight dispatch states and
--   carries no `now()` expression (immutable, planner-safe).
-- - No Postgres ENUM types: dispatch states reuse the existing CHECK text
--   domain from migration 007. No secrets, credentials, or customer data.

BEGIN;

ALTER TABLE provider.provider_operations
    ADD COLUMN claimed_by text;

ALTER TABLE provider.provider_operations
    ADD COLUMN claimed_at timestamptz;

ALTER TABLE provider.provider_operations
    ADD COLUMN lease_expires_at timestamptz;

ALTER TABLE provider.provider_operations
    ADD COLUMN dispatch_started_at timestamptz;

ALTER TABLE provider.provider_operation_attempts
    ADD COLUMN dispatch_started_at timestamptz;

CREATE INDEX provider_operations_dispatch_recovery_idx
    ON provider.provider_operations (lease_expires_at)
    WHERE status IN ('QUEUED','RUNNING');

COMMIT;
