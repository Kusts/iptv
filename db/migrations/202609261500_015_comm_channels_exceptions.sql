-- AI Revenue & Operations Platform
-- Migration 015: Wave 2 CRM/Communications ingress support
--
-- - `communication.tenant_channels`: maps the public webhook routing key
--   (`POST /v1/webhooks/waha/:tenantKey`) to a tenant. Tenant context comes
--   from this mapping, NEVER from payload content.
-- - `communication.exceptions`: minimal manual-resolution queue for inbound
--   messages that cannot be matched to a known person/conversation.
-- Roll-forward CREATE-only; existing migrations untouched.

BEGIN;

CREATE TABLE communication.tenant_channels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants (id),
    channel text NOT NULL,
    tenant_key text NOT NULL,
    webhook_secret_hash text,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tenant_channels_channel_not_blank CHECK (btrim(channel) <> ''),
    CONSTRAINT tenant_channels_key_not_blank CHECK (btrim(tenant_key) <> ''),
    CONSTRAINT tenant_channels_status_check CHECK (status IN ('ACTIVE','DISABLED')),
    CONSTRAINT tenant_channels_key_unique UNIQUE (tenant_key),
    CONSTRAINT tenant_channels_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX tenant_channels_tenant_idx
    ON communication.tenant_channels (tenant_id, channel, status);

CREATE TABLE communication.exceptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants (id),
    kind text NOT NULL,
    status text NOT NULL DEFAULT 'OPEN',
    channel text,
    external_message_id text,
    from_address text,
    conversation_id uuid,
    person_id uuid,
    reason text,
    payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    CONSTRAINT communication_exceptions_kind_check CHECK (kind IN ('UNMATCHED_INBOUND')),
    CONSTRAINT communication_exceptions_status_check CHECK (status IN ('OPEN','RESOLVED','DISCARDED')),
    CONSTRAINT communication_exceptions_resolution_shape_check CHECK (
        (status = 'OPEN' AND resolved_at IS NULL) OR
        (status IN ('RESOLVED','DISCARDED') AND resolved_at IS NOT NULL)
    ),
    CONSTRAINT communication_exceptions_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX communication_exceptions_open_idx
    ON communication.exceptions (tenant_id, status, created_at DESC)
    WHERE status = 'OPEN';

COMMIT;
