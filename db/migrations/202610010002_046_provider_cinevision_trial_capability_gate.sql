-- AI Revenue & Operations Platform
-- Migration 046: Fail-closed per-action `provider.cinevision.trial` capability gate (FASE5 S5).
--
-- Design notes:
-- - The per-action trial gate (`decideTrialDispatchGate` in
--   `apps/api/src/provider/provider-secret-gate.ts`) forces HUMAN_REQUIRED /
--   `precondition_failed` for every REAL (secret-required) `trial.provision`
--   dispatch unless the `provider.cinevision.trial` row exists with AVAILABLE
--   availability — strictly AVAILABLE, not merely "not UNAVAILABLE" — on top
--   of the GLOBAL `provider.cinevision` row (migration 044), plus the
--   designated disposable account (`PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID`,
--   S4). Flipping the GLOBAL row alone can therefore never release trial
--   writes: the controlled CREATE_TRIAL environment needs this row AVAILABLE
--   too. Synthetic echo/manual flows never consult this row.
-- - `platform.capabilities` is a GLOBAL catalog (platform-owned, like
--   `control.roles`): no tenant_id. Tenant scoping lives in the RESOLUTION
--   (actor + tenant policy), never in the capability row itself.
-- - Roll-forward INSERT-only; existing migrations untouched. The capability
--   row uses ON CONFLICT DO NOTHING and the capability_events row is
--   guarded by WHERE NOT EXISTS, so re-applying this migration is a no-op
--   (the events table is append-only with no uniqueness to conflict on).
-- - No Postgres ENUM types: all constrained text uses CHECK constraints
--   (declared in migration 014). No secrets, credentials, or customer data.

BEGIN;

INSERT INTO platform.capabilities
    (key, owner_context, availability, certification_status, risk_level, mvp_phase, manual_equivalent, policy_family, degradation)
VALUES
    ('provider.cinevision.trial', 'provider', 'UNAVAILABLE', 'UNCERTIFIED', 'HIGH', 'W0',
     'Provider operator fulfills the operation manually (HITL) via provider.resolve_operation',
     'provider-integration',
     'Forced MANUAL: every real trial.provision parks in HUMAN_REQUIRED until the disposable-account trial environment is certified AVAILABLE (SPEC cinevision-runtime-hardening)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO platform.capability_events
    (capability_key, from_availability, to_availability, reason)
SELECT 'provider.cinevision.trial', NULL, 'UNAVAILABLE',
    'FASE5-S4S5 fail-closed gate fixture: per-action CINEVISION trial writes uncertified; real trial.provision blocked until disposable-account certification (SPEC cinevision-runtime-hardening)'
WHERE NOT EXISTS (
    SELECT 1 FROM platform.capability_events
    WHERE capability_key = 'provider.cinevision.trial'
      AND to_availability = 'UNAVAILABLE'
);

COMMIT;
