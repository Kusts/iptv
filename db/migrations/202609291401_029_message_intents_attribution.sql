-- AI Revenue & Operations Platform
-- Migration 029: MessageIntent scheduling + attribution (Wave 11)
--
-- - `communication.message_intents` + `communication.scheduled_contacts`:
--   campaign outreach is scheduled BEHIND the manual messaging gateway —
--   never a direct send. Per-contact status carries the policy outcome:
--   SCHEDULED (ready for the gateway), DEFERRED (inside quiet hours),
--   BLOCKED (suppressed / opted out / budget exceeded).
-- - `growth.attribution_touches`: first-touch wins per (person, campaign);
--   REFERRAL_ASSIST touches are recorded separately and never overwrite the
--   first touch. Touches and conversion events are append-only history.
-- - `growth.conversion_events`: a conversion resolves the campaign version
--   (offer/policy snapshot) of the first touch, so historical attribution
--   stays reproducible after later versions are published.
-- - Money is exact bigint minor units (never floats).

BEGIN;

CREATE TABLE communication.message_intents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    campaign_id uuid NOT NULL,
    campaign_version_id uuid NOT NULL,
    audience_id uuid,
    channel text NOT NULL,
    purpose_key text NOT NULL DEFAULT 'MARKETING',
    template_ref text,
    idempotency_key text NOT NULL,
    scheduled_for timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL DEFAULT 'SCHEDULED',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT message_intents_campaign_fk FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES growth.campaigns (tenant_id, id),
    CONSTRAINT message_intents_version_fk FOREIGN KEY (tenant_id, campaign_version_id)
        REFERENCES growth.campaign_versions (tenant_id, id),
    CONSTRAINT message_intents_audience_fk FOREIGN KEY (tenant_id, audience_id)
        REFERENCES growth.audience_definitions (tenant_id, id),
    CONSTRAINT message_intents_status_check CHECK (status IN ('SCHEDULED','BLOCKED','CANCELLED')),
    CONSTRAINT message_intents_idempotency_unique UNIQUE (tenant_id, idempotency_key),
    CONSTRAINT message_intents_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE communication.scheduled_contacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    intent_id uuid NOT NULL,
    person_id uuid NOT NULL,
    channel text NOT NULL,
    scheduled_for timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'SCHEDULED',
    block_reason text,
    estimated_cost_minor bigint NOT NULL DEFAULT 0,
    sent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT scheduled_contacts_intent_fk FOREIGN KEY (tenant_id, intent_id)
        REFERENCES communication.message_intents (tenant_id, id),
    CONSTRAINT scheduled_contacts_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT scheduled_contacts_status_check CHECK (status IN ('SCHEDULED','DEFERRED','BLOCKED','SENT','CANCELLED')),
    CONSTRAINT scheduled_contacts_cost_nonnegative CHECK (estimated_cost_minor >= 0),
    CONSTRAINT scheduled_contacts_block_shape_check CHECK (
        (status = 'BLOCKED' AND block_reason IS NOT NULL) OR
        (status <> 'BLOCKED')
    ),
    CONSTRAINT scheduled_contacts_intent_person_unique UNIQUE (tenant_id, intent_id, person_id),
    CONSTRAINT scheduled_contacts_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX scheduled_contacts_intent_idx
    ON communication.scheduled_contacts (tenant_id, intent_id, status);

CREATE TABLE growth.attribution_touches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    person_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    campaign_version_id uuid NOT NULL,
    touch_type text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT attribution_touches_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT attribution_touches_campaign_fk FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES growth.campaigns (tenant_id, id),
    CONSTRAINT attribution_touches_version_fk FOREIGN KEY (tenant_id, campaign_version_id)
        REFERENCES growth.campaign_versions (tenant_id, id),
    CONSTRAINT attribution_touches_type_check CHECK (touch_type IN ('CLICK','VIEW','SCAN','REFERRAL_ASSIST','MANUAL')),
    CONSTRAINT attribution_touches_tenant_id_id_unique UNIQUE (tenant_id, id)
);

-- First-touch wins: at most one non-assist touch per (tenant, person,
-- campaign). Writers pre-check + take an advisory lock instead of catching
-- PG 23505 (a caught violation would abort the surrounding transaction).
CREATE UNIQUE INDEX attribution_touches_first_touch_unique
    ON growth.attribution_touches (tenant_id, person_id, campaign_id)
    WHERE touch_type <> 'REFERRAL_ASSIST';

CREATE INDEX attribution_touches_person_idx
    ON growth.attribution_touches (tenant_id, person_id, occurred_at);

CREATE TABLE growth.conversion_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    person_id uuid NOT NULL,
    campaign_id uuid,
    campaign_version_id uuid,
    conversion_type text NOT NULL,
    order_id uuid,
    amount_minor bigint,
    currency text,
    idempotency_key text,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT conversion_events_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT conversion_events_campaign_fk FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES growth.campaigns (tenant_id, id),
    CONSTRAINT conversion_events_version_fk FOREIGN KEY (tenant_id, campaign_version_id)
        REFERENCES growth.campaign_versions (tenant_id, id),
    CONSTRAINT conversion_events_resolution_shape_check CHECK (
        (campaign_id IS NULL AND campaign_version_id IS NULL) OR
        (campaign_id IS NOT NULL AND campaign_version_id IS NOT NULL)
    ),
    CONSTRAINT conversion_events_amount_nonnegative CHECK (amount_minor IS NULL OR amount_minor >= 0),
    CONSTRAINT conversion_events_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX conversion_events_idempotency_unique
    ON growth.conversion_events (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX conversion_events_person_idx
    ON growth.conversion_events (tenant_id, person_id, occurred_at);

CREATE TRIGGER attribution_touches_append_only
BEFORE UPDATE OR DELETE ON growth.attribution_touches
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

CREATE TRIGGER conversion_events_append_only
BEFORE UPDATE OR DELETE ON growth.conversion_events
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

COMMIT;
