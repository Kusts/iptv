-- AI Revenue & Operations Platform
-- Migration 013: command/query permission catalog extension (W1-06/W1-07a)
--
-- Extends the global permission catalog seeded in 012 with the HumanReview
-- command permissions. Roll-forward INSERT-only; existing migrations untouched.
-- Mirrors `packages/auth/src/permissions.ts` ROLE_PERMISSIONS.

BEGIN;

INSERT INTO control.permissions (key, description) VALUES
    ('agent.review.request', 'Request human review (creates a PENDING review, never executes)'),
    ('agent.review.decide', 'Decide a human review (approve/reject with stale-approval revalidation)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO control.role_permissions (role_key, permission_key) VALUES
    ('platform_admin', 'agent.review.request'),
    ('platform_admin', 'agent.review.decide'),
    ('tenant_owner', 'agent.review.request'),
    ('tenant_owner', 'agent.review.decide'),
    ('tenant_admin', 'agent.review.request'),
    ('tenant_admin', 'agent.review.decide'),
    ('tenant_operator', 'agent.review.request')
ON CONFLICT DO NOTHING;

COMMIT;
