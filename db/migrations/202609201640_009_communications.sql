-- AI Revenue & Operations Platform
-- Migration 009: Communications, conversation control, preferences & delivery history

BEGIN;

CREATE SCHEMA IF NOT EXISTS communication;

CREATE TABLE communication.conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    person_id uuid NOT NULL,
    channel text NOT NULL,
    external_thread_id text,
    status text NOT NULL DEFAULT 'OPEN',
    control_mode text NOT NULL DEFAULT 'AI_CONTROL',
    last_message_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    CONSTRAINT conversations_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT conversations_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT conversations_status_check CHECK (status IN ('OPEN','CLOSED','ARCHIVED')),
    CONSTRAINT conversations_control_mode_check CHECK (control_mode IN ('AI_CONTROL','HUMAN_CONTROL','PAUSED')),
    CONSTRAINT conversations_close_shape_check CHECK ((status = 'OPEN' AND closed_at IS NULL) OR (status IN ('CLOSED','ARCHIVED') AND closed_at IS NOT NULL)),
    CONSTRAINT conversations_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX conversations_external_thread_unique
    ON communication.conversations (tenant_id, channel, external_thread_id)
    WHERE external_thread_id IS NOT NULL;
CREATE INDEX conversations_person_idx
    ON communication.conversations (tenant_id, person_id, last_message_at DESC NULLS LAST);
CREATE INDEX conversations_open_idx
    ON communication.conversations (tenant_id, channel, last_message_at DESC NULLS LAST)
    WHERE status = 'OPEN';

CREATE TABLE communication.messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    person_id uuid NOT NULL,
    direction text NOT NULL,
    channel text NOT NULL,
    sender_type text NOT NULL,
    external_message_id text,
    idempotency_key text,
    content_type text NOT NULL DEFAULT 'TEXT',
    body_text text,
    attachment_ref text,
    metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL,
    received_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT messages_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
        REFERENCES communication.conversations (tenant_id, id),
    CONSTRAINT messages_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT messages_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT messages_direction_check CHECK (direction IN ('INBOUND','OUTBOUND','INTERNAL')),
    CONSTRAINT messages_sender_type_check CHECK (sender_type IN ('PERSON','AGENT','HUMAN','SYSTEM','EXTERNAL')),
    CONSTRAINT messages_content_type_check CHECK (content_type IN ('TEXT','IMAGE','VIDEO','AUDIO','DOCUMENT','LOCATION','TEMPLATE','SYSTEM_EVENT','OTHER')),
    CONSTRAINT messages_content_present_check CHECK (body_text IS NOT NULL OR attachment_ref IS NOT NULL OR content_type = 'SYSTEM_EVENT'),
    CONSTRAINT messages_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX messages_external_id_unique
    ON communication.messages (tenant_id, channel, external_message_id)
    WHERE external_message_id IS NOT NULL;
CREATE UNIQUE INDEX messages_idempotency_unique
    ON communication.messages (tenant_id, channel, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX messages_conversation_time_idx
    ON communication.messages (tenant_id, conversation_id, occurred_at, id);

CREATE TABLE communication.message_deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    message_id uuid NOT NULL,
    provider text NOT NULL,
    status text NOT NULL,
    attempt_no integer NOT NULL,
    external_delivery_id text,
    error_code text,
    error_detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT message_deliveries_message_fk FOREIGN KEY (tenant_id, message_id)
        REFERENCES communication.messages (tenant_id, id),
    CONSTRAINT message_deliveries_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT message_deliveries_status_check CHECK (status IN ('QUEUED','SENT','DELIVERED','READ','FAILED','CANCELLED')),
    CONSTRAINT message_deliveries_attempt_positive CHECK (attempt_no > 0),
    CONSTRAINT message_deliveries_attempt_unique UNIQUE (tenant_id, message_id, attempt_no),
    CONSTRAINT message_deliveries_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX message_deliveries_message_idx
    ON communication.message_deliveries (tenant_id, message_id, occurred_at DESC);

CREATE TABLE communication.communication_preferences (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    person_id uuid NOT NULL,
    purpose_key text NOT NULL,
    channel text NOT NULL,
    status text NOT NULL,
    source text NOT NULL,
    evidence_ref text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT communication_preferences_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT communication_preferences_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT communication_preferences_status_check CHECK (status IN ('ALLOWED','DENIED','UNKNOWN')),
    CONSTRAINT communication_preferences_unique UNIQUE (tenant_id, person_id, purpose_key, channel),
    CONSTRAINT communication_preferences_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE communication.communication_suppressions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    person_id uuid,
    identity_id uuid,
    channel text,
    purpose_key text,
    reason text NOT NULL,
    starts_at timestamptz NOT NULL DEFAULT now(),
    ends_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT communication_suppressions_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT communication_suppressions_identity_fk FOREIGN KEY (tenant_id, identity_id)
        REFERENCES identity.identities (tenant_id, id),
    CONSTRAINT communication_suppressions_target_check CHECK (person_id IS NOT NULL OR identity_id IS NOT NULL),
    CONSTRAINT communication_suppressions_window_check CHECK (ends_at IS NULL OR ends_at > starts_at),
    CONSTRAINT communication_suppressions_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX communication_suppressions_lookup_idx
    ON communication.communication_suppressions (tenant_id, person_id, identity_id, channel, purpose_key, starts_at, ends_at);

CREATE TABLE communication.conversation_control_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    from_mode text,
    to_mode text NOT NULL,
    reason text,
    actor_type text NOT NULL,
    actor_id text,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT conversation_control_events_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
        REFERENCES communication.conversations (tenant_id, id),
    CONSTRAINT conversation_control_events_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT conversation_control_events_from_check CHECK (from_mode IS NULL OR from_mode IN ('AI_CONTROL','HUMAN_CONTROL','PAUSED')),
    CONSTRAINT conversation_control_events_to_check CHECK (to_mode IN ('AI_CONTROL','HUMAN_CONTROL','PAUSED')),
    CONSTRAINT conversation_control_events_actor_check CHECK (actor_type IN ('system','agent','human','external')),
    CONSTRAINT conversation_control_events_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX conversation_control_events_history_idx
    ON communication.conversation_control_events (tenant_id, conversation_id, occurred_at DESC);

CREATE TRIGGER messages_append_only
BEFORE UPDATE OR DELETE ON communication.messages
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

CREATE TRIGGER message_deliveries_append_only
BEFORE UPDATE OR DELETE ON communication.message_deliveries
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

CREATE TRIGGER conversation_control_events_append_only
BEFORE UPDATE OR DELETE ON communication.conversation_control_events
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

COMMIT;
