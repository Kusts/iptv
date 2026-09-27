-- AI Revenue & Operations Platform
-- Migration 020: Wave 9 renewal + retention storage
--
-- Justification (no fitting table exists, so a migration is required):
-- - `renewal.recovery_tasks`: tenant-scoped human-worked winback queue
--   (subscription + reason + outcome). Support Tickets are the wrong owning
--   context and CRM NextActions are pipeline organization, not domain state —
--   a dedicated queue keeps the owning context (Subscriptions & Entitlements)
--   explicit without overloading another aggregate.
-- - `subscription.trust_renewal_grants`: once-per-cycle ledger of
--   policy-gated extensions without payment. The grant must survive the
--   review lifecycle (the HumanReview row resolves and can never be
--   re-queried as "open"), so the `UNIQUE (tenant_id, cycle_id)` constraint
--   is the storage truth for "single open trust grant per cycle".
--
-- Reused without new columns: the renewal order ↔ subscription link rides
-- on the existing `subscription_cycles.renewal_order_id` of the CURRENT
-- (prior) cycle, and renewal reminders ride on
-- `communication.messages.idempotency_key` (existing partial unique
-- index). No projection states are stored.

BEGIN;

CREATE SCHEMA IF NOT EXISTS renewal;

CREATE TABLE renewal.recovery_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    cycle_id uuid,
    renewal_order_id uuid,
    reason text NOT NULL,
    status text NOT NULL DEFAULT 'OPEN',
    outcome text,
    resolved_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    CONSTRAINT recovery_tasks_subscription_fk FOREIGN KEY (tenant_id, subscription_id)
        REFERENCES subscription.subscriptions (tenant_id, id),
    CONSTRAINT recovery_tasks_cycle_fk FOREIGN KEY (tenant_id, cycle_id)
        REFERENCES subscription.subscription_cycles (tenant_id, id),
    CONSTRAINT recovery_tasks_order_fk FOREIGN KEY (tenant_id, renewal_order_id)
        REFERENCES commerce.orders (tenant_id, id),
    CONSTRAINT recovery_tasks_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT recovery_tasks_reason_check CHECK (btrim(reason) <> ''),
    CONSTRAINT recovery_tasks_status_check CHECK (status IN ('OPEN','RESOLVED')),
    CONSTRAINT recovery_tasks_outcome_check CHECK (
        outcome IS NULL OR outcome IN ('WON_BACK','LOST','DISMISSED')
    ),
    CONSTRAINT recovery_tasks_resolved_shape_check CHECK (
        (status = 'OPEN' AND resolved_at IS NULL) OR
        (status = 'RESOLVED' AND outcome IS NOT NULL AND resolved_at IS NOT NULL)
    ),
    CONSTRAINT recovery_tasks_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX recovery_tasks_open_idx
    ON renewal.recovery_tasks (tenant_id, subscription_id, status, created_at DESC);

CREATE TABLE subscription.trust_renewal_grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    cycle_id uuid NOT NULL,
    extension_days integer NOT NULL,
    previous_ends_at timestamptz NOT NULL,
    new_ends_at timestamptz NOT NULL,
    -- Null only when the tenant's `subscription.trust_renewal` policy sets
    -- `require_review: false`. The default (`true`) always stores the
    -- approving review id.
    review_request_id uuid,
    granted_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT trust_renewal_grants_subscription_fk FOREIGN KEY (tenant_id, subscription_id)
        REFERENCES subscription.subscriptions (tenant_id, id),
    CONSTRAINT trust_renewal_grants_cycle_fk FOREIGN KEY (tenant_id, cycle_id)
        REFERENCES subscription.subscription_cycles (tenant_id, id),
    CONSTRAINT trust_renewal_grants_review_fk FOREIGN KEY (tenant_id, review_request_id)
        REFERENCES agent.human_review_requests (tenant_id, id),
    CONSTRAINT trust_renewal_grants_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT trust_renewal_grants_days_positive CHECK (extension_days > 0),
    CONSTRAINT trust_renewal_grants_window_check CHECK (new_ends_at > previous_ends_at),
    CONSTRAINT trust_renewal_grants_one_per_cycle UNIQUE (tenant_id, cycle_id),
    CONSTRAINT trust_renewal_grants_tenant_id_id_unique UNIQUE (tenant_id, id)
);

COMMIT;
