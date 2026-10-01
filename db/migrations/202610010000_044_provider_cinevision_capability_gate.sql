-- AI Revenue & Operations Platform
-- Migration 044: Fail-closed `provider.cinevision` capability gate (W0).
--
-- Design notes:
-- - The runtime capability gate (`applyCapabilityGate` in
--   `apps/api/src/provider/provider-port.ts`) forces MANUAL whenever the
--   `provider.cinevision` row exists with UNAVAILABLE availability, so every
--   provider write parks in HUMAN_REQUIRED until the integration is
--   certified and available.
-- - No earlier seed or migration created this row (the pilot seed only
--   registers the `cinevision` provider plus a placeholder account), leaving
--   new environments without a known gate state. This migration registers
--   the row fail-closed: UNAVAILABLE + UNCERTIFIED, HIGH risk, W0 phase.
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
    ('provider.cinevision', 'provider', 'UNAVAILABLE', 'UNCERTIFIED', 'HIGH', 'W0',
     'Provider operator fulfills the operation manually (HITL) via provider.resolve_operation',
     'provider-integration',
     'Forced MANUAL: every operation parks in HUMAN_REQUIRED until durable post-commit dispatch with certified readback')
ON CONFLICT (key) DO NOTHING;

INSERT INTO platform.capability_events
    (capability_key, from_availability, to_availability, reason)
SELECT 'provider.cinevision', NULL, 'UNAVAILABLE',
    'W0 fail-closed gate fixture: CINEVISION integration uncertified; real writes blocked until durable post-commit dispatch + certified readback (SPEC cinevision-runtime-hardening)'
WHERE NOT EXISTS (
    SELECT 1 FROM platform.capability_events
    WHERE capability_key = 'provider.cinevision'
      AND to_availability = 'UNAVAILABLE'
);

COMMIT;
