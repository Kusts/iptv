-- AI Revenue & Operations Platform
-- Migration 019: Wave 6 subscription cycle guard + permission seeds
--
-- - One OPEN (PENDING/ACTIVE) cycle per subscription: migration 006 declared
--   `subscription_cycles_unique (tenant, subscription, cycle_no)` but nothing
--   prevents two concurrent open cycles. This partial unique index is the
--   storage truth; commands also pre-check for a 409 before hitting it.
-- - Seeds the Wave 6 command permissions (mirrors
--   `packages/auth/src/permissions.ts`).

BEGIN;

CREATE UNIQUE INDEX subscription_cycles_one_open_per_subscription
    ON subscription.subscription_cycles (tenant_id, subscription_id)
    WHERE status IN ('PENDING','ACTIVE');

INSERT INTO control.permissions (key, description) VALUES
    ('subscription.read', 'Read subscriptions, cycles and entitlements'),
    ('subscription.write', 'Mutate subscriptions, cycles and fulfillment requests')
ON CONFLICT (key) DO NOTHING;

INSERT INTO control.role_permissions (role_key, permission_key) VALUES
    ('platform_admin', 'subscription.read'),
    ('platform_admin', 'subscription.write'),
    ('tenant_owner', 'subscription.read'),
    ('tenant_owner', 'subscription.write'),
    ('tenant_admin', 'subscription.read'),
    ('tenant_admin', 'subscription.write'),
    ('tenant_operator', 'subscription.read')
ON CONFLICT DO NOTHING;

COMMIT;
