-- AI Revenue & Operations Platform
-- Migration 018: Wave 5 Commerce/Billing webhook ingress + exception queue
--
-- - `billing.tenant_channels`: maps the public Asaas webhook routing key
--   (`POST /v1/webhooks/asaas/:tenantKey`) to a tenant. Tenant context comes
--   from this mapping, NEVER from payload content. A dedicated billing table
--   (not `communication.tenant_channels`) because webhook credentials are
--   per-integration secrets with distinct rotation/audit; sharing one table
--   would couple the WAHA and Asaas credential lifecycles.
-- - `billing.exceptions`: human-resolution queue for billing intake that
--   cannot become a domain fact (amount/currency tamper, unknown external
--   charge id, UNKNOWN provider effect on refunds, chargebacks for review).
-- - Permission catalog extension for the Wave 5 command surface.
-- Roll-forward CREATE/INSERT-only; existing migrations untouched.

BEGIN;

CREATE TABLE billing.tenant_channels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants (id),
    channel text NOT NULL DEFAULT 'ASAAS',
    tenant_key text NOT NULL,
    webhook_secret_hash text,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT billing_tenant_channels_channel_not_blank CHECK (btrim(channel) <> ''),
    CONSTRAINT billing_tenant_channels_key_not_blank CHECK (btrim(tenant_key) <> ''),
    CONSTRAINT billing_tenant_channels_status_check CHECK (status IN ('ACTIVE','DISABLED')),
    CONSTRAINT billing_tenant_channels_key_unique UNIQUE (tenant_key),
    CONSTRAINT billing_tenant_channels_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX billing_tenant_channels_tenant_idx
    ON billing.tenant_channels (tenant_id, channel, status);

CREATE TABLE billing.exceptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants (id),
    kind text NOT NULL,
    status text NOT NULL DEFAULT 'OPEN',
    charge_id uuid,
    payment_id uuid,
    refund_id uuid,
    reason text,
    payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    CONSTRAINT billing_exceptions_charge_fk FOREIGN KEY (tenant_id, charge_id)
        REFERENCES billing.charges (tenant_id, id),
    CONSTRAINT billing_exceptions_payment_fk FOREIGN KEY (tenant_id, payment_id)
        REFERENCES billing.payments (tenant_id, id),
    CONSTRAINT billing_exceptions_refund_fk FOREIGN KEY (tenant_id, refund_id)
        REFERENCES billing.refunds (tenant_id, id),
    CONSTRAINT billing_exceptions_kind_check CHECK (kind IN (
        'AMOUNT_MISMATCH','UNKNOWN_CHARGE','PROVIDER_UNKNOWN_EFFECT',
        'REFUND_UNKNOWN_EFFECT','CHARGEBACK','PROVIDER_ERROR'
    )),
    CONSTRAINT billing_exceptions_status_check CHECK (status IN ('OPEN','RESOLVED','DISCARDED')),
    CONSTRAINT billing_exceptions_resolution_shape_check CHECK (
        (status = 'OPEN' AND resolved_at IS NULL) OR
        (status IN ('RESOLVED','DISCARDED') AND resolved_at IS NOT NULL)
    ),
    CONSTRAINT billing_exceptions_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX billing_exceptions_open_idx
    ON billing.exceptions (tenant_id, status, created_at DESC)
    WHERE status = 'OPEN';

INSERT INTO control.permissions (key, description) VALUES
    ('commerce.order.write', 'Create/submit/cancel/expire commerce orders'),
    ('billing.charge.write', 'Create/reconcile/cancel billing charges'),
    ('billing.refund.request', 'Request a refund (creates a tenant-scoped RefundRequest, never executes)'),
    ('billing.refund.execute', 'Execute an approved refund after revalidation under per-payment serialization'),
    ('billing.exception.resolve', 'Resolve or discard a billing exception')
ON CONFLICT (key) DO NOTHING;

INSERT INTO control.role_permissions (role_key, permission_key) VALUES
    ('platform_admin', 'commerce.order.write'),
    ('platform_admin', 'billing.charge.write'),
    ('platform_admin', 'billing.refund.request'),
    ('platform_admin', 'billing.refund.execute'),
    ('platform_admin', 'billing.exception.resolve'),
    ('tenant_owner', 'commerce.order.write'),
    ('tenant_owner', 'billing.charge.write'),
    ('tenant_owner', 'billing.refund.request'),
    ('tenant_owner', 'billing.refund.execute'),
    ('tenant_owner', 'billing.exception.resolve'),
    ('tenant_admin', 'commerce.order.write'),
    ('tenant_admin', 'billing.charge.write'),
    ('tenant_admin', 'billing.refund.request'),
    ('tenant_admin', 'billing.refund.execute'),
    ('tenant_admin', 'billing.exception.resolve'),
    ('tenant_operator', 'commerce.order.write'),
    ('tenant_operator', 'billing.charge.write'),
    ('tenant_operator', 'billing.refund.request')
ON CONFLICT DO NOTHING;

COMMIT;
