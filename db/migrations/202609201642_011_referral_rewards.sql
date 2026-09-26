-- AI Revenue & Operations Platform
-- Migration 011: Referral core, rewards, wallet ledger and gift passes

BEGIN;

CREATE SCHEMA IF NOT EXISTS referral;
CREATE SCHEMA IF NOT EXISTS loyalty;

CREATE TABLE referral.referral_programs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    name text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    rules_version text NOT NULL,
    rules_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT referral_programs_status_check CHECK (status IN ('DRAFT','ACTIVE','PAUSED','ENDED','ARCHIVED')),
    CONSTRAINT referral_programs_window_check CHECK (ends_at IS NULL OR ends_at > starts_at),
    CONSTRAINT referral_programs_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE referral.referrals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    program_id uuid NOT NULL,
    advocate_customer_id uuid NOT NULL,
    referred_person_id uuid,
    referral_code text NOT NULL,
    status text NOT NULL DEFAULT 'CREATED',
    source_context text,
    created_at timestamptz NOT NULL DEFAULT now(),
    attributed_at timestamptz,
    confirmed_at timestamptz,
    expired_at timestamptz,
    reversed_at timestamptz,
    CONSTRAINT referrals_program_fk FOREIGN KEY (tenant_id, program_id)
        REFERENCES referral.referral_programs (tenant_id, id),
    CONSTRAINT referrals_advocate_fk FOREIGN KEY (tenant_id, advocate_customer_id)
        REFERENCES crm.customers (tenant_id, id),
    CONSTRAINT referrals_referred_person_fk FOREIGN KEY (tenant_id, referred_person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT referrals_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT referrals_status_check CHECK (status IN ('CREATED','ATTRIBUTED','ENGAGED','QUALIFYING','CONFIRMED','REJECTED','EXPIRED','REVERSED')),
    CONSTRAINT referrals_code_not_blank CHECK (btrim(referral_code) <> ''),
    CONSTRAINT referrals_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX referrals_advocate_idx
    ON referral.referrals (tenant_id, advocate_customer_id, created_at DESC);
CREATE INDEX referrals_referred_idx
    ON referral.referrals (tenant_id, referred_person_id, created_at DESC)
    WHERE referred_person_id IS NOT NULL;

CREATE OR REPLACE FUNCTION referral.reject_active_self_referral()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_advocate_person uuid;
BEGIN
    IF NEW.referred_person_id IS NULL OR NEW.status IN ('REJECTED','EXPIRED','REVERSED') THEN
        RETURN NEW;
    END IF;

    SELECT person_id INTO v_advocate_person
    FROM crm.customers
    WHERE tenant_id = NEW.tenant_id AND id = NEW.advocate_customer_id;

    IF v_advocate_person = NEW.referred_person_id THEN
        RAISE EXCEPTION 'active self-referral is not allowed';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER referrals_no_active_self_referral
BEFORE INSERT OR UPDATE OF advocate_customer_id, referred_person_id, status ON referral.referrals
FOR EACH ROW EXECUTE FUNCTION referral.reject_active_self_referral();
CREATE UNIQUE INDEX referrals_active_person_per_program_unique
    ON referral.referrals (tenant_id, program_id, referred_person_id)
    WHERE referred_person_id IS NOT NULL AND status IN ('ATTRIBUTED','ENGAGED','QUALIFYING','CONFIRMED');

CREATE TABLE referral.referral_qualifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    referral_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'PENDING',
    risk_assessment_id uuid,
    reason_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
    qualified_order_id uuid,
    policy_version text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    CONSTRAINT referral_qualifications_referral_fk FOREIGN KEY (tenant_id, referral_id)
        REFERENCES referral.referrals (tenant_id, id),
    CONSTRAINT referral_qualifications_risk_fk FOREIGN KEY (tenant_id, risk_assessment_id)
        REFERENCES security.risk_assessments (tenant_id, id),
    CONSTRAINT referral_qualifications_order_fk FOREIGN KEY (tenant_id, qualified_order_id)
        REFERENCES commerce.orders (tenant_id, id),
    CONSTRAINT referral_qualifications_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT referral_qualifications_status_check CHECK (status IN ('PENDING','ALLOW','REVIEW','DENY','EXPIRED')),
    CONSTRAINT referral_qualifications_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX referral_qualification_open_unique
    ON referral.referral_qualifications (tenant_id, referral_id)
    WHERE resolved_at IS NULL;

CREATE TABLE loyalty.reward_definitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    reward_key text NOT NULL,
    reward_type text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    perceived_value_minor bigint,
    estimated_cost_minor bigint,
    currency char(3),
    recurring_cost_policy text,
    rules_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT reward_definitions_status_check CHECK (status IN ('ACTIVE','PAUSED','RETIRED')),
    CONSTRAINT reward_definitions_type_check CHECK (reward_type IN ('REFERRAL_CREDIT','ORDER_CREDIT','DISCOUNT','COUPON','GIFT_PASS','APP_ENTITLEMENT','CONNECTION_ENTITLEMENT','PROMOTIONAL_ENTITLEMENT','OTHER')),
    CONSTRAINT reward_definitions_values_check CHECK ((perceived_value_minor IS NULL OR perceived_value_minor >= 0) AND (estimated_cost_minor IS NULL OR estimated_cost_minor >= 0)),
    CONSTRAINT reward_definitions_key_unique UNIQUE (tenant_id, reward_key),
    CONSTRAINT reward_definitions_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE loyalty.rewards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    reward_definition_id uuid NOT NULL,
    source_type text NOT NULL,
    source_id uuid,
    status text NOT NULL DEFAULT 'PENDING',
    economic_value_minor bigint,
    estimated_cost_minor bigint,
    currency char(3),
    issued_at timestamptz,
    available_at timestamptz,
    redeemed_at timestamptz,
    expires_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT rewards_customer_fk FOREIGN KEY (tenant_id, customer_id)
        REFERENCES crm.customers (tenant_id, id),
    CONSTRAINT rewards_definition_fk FOREIGN KEY (tenant_id, reward_definition_id)
        REFERENCES loyalty.reward_definitions (tenant_id, id),
    CONSTRAINT rewards_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT rewards_status_check CHECK (status IN ('PENDING','APPROVED','ISSUED','AVAILABLE','REDEEMED','EXPIRED','REVOKED','FAILED')),
    CONSTRAINT rewards_values_check CHECK ((economic_value_minor IS NULL OR economic_value_minor >= 0) AND (estimated_cost_minor IS NULL OR estimated_cost_minor >= 0)),
    CONSTRAINT rewards_window_check CHECK (expires_at IS NULL OR available_at IS NULL OR expires_at > available_at),
    CONSTRAINT rewards_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX rewards_customer_idx
    ON loyalty.rewards (tenant_id, customer_id, status, created_at DESC);

CREATE TABLE loyalty.reward_ledger_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    reward_id uuid,
    entry_type text NOT NULL,
    amount_minor bigint,
    points_delta integer,
    currency char(3),
    idempotency_key text NOT NULL,
    reference_type text,
    reference_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT reward_ledger_customer_fk FOREIGN KEY (tenant_id, customer_id)
        REFERENCES crm.customers (tenant_id, id),
    CONSTRAINT reward_ledger_reward_fk FOREIGN KEY (tenant_id, reward_id)
        REFERENCES loyalty.rewards (tenant_id, id),
    CONSTRAINT reward_ledger_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT reward_ledger_entry_type_check CHECK (entry_type IN ('EARNED','REDEEMED','EXPIRED','REVOKED','ADJUSTMENT','REVERSAL')),
    CONSTRAINT reward_ledger_value_present_check CHECK ((amount_minor IS NOT NULL AND amount_minor <> 0) OR (points_delta IS NOT NULL AND points_delta <> 0)),
    CONSTRAINT reward_ledger_amount_currency_check CHECK ((amount_minor IS NULL AND currency IS NULL) OR (amount_minor IS NOT NULL AND currency IS NOT NULL)),
    CONSTRAINT reward_ledger_idempotency_unique UNIQUE (tenant_id, idempotency_key),
    CONSTRAINT reward_ledger_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX reward_ledger_customer_idx
    ON loyalty.reward_ledger_entries (tenant_id, customer_id, created_at DESC);

CREATE TABLE loyalty.gift_passes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    issued_to_customer_id uuid NOT NULL,
    source_reward_id uuid,
    code text NOT NULL,
    status text NOT NULL DEFAULT 'AVAILABLE',
    benefit_json jsonb NOT NULL,
    expires_at timestamptz NOT NULL,
    redeemed_by_person_id uuid,
    redeemed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT gift_passes_customer_fk FOREIGN KEY (tenant_id, issued_to_customer_id)
        REFERENCES crm.customers (tenant_id, id),
    CONSTRAINT gift_passes_reward_fk FOREIGN KEY (tenant_id, source_reward_id)
        REFERENCES loyalty.rewards (tenant_id, id),
    CONSTRAINT gift_passes_redeemed_person_fk FOREIGN KEY (tenant_id, redeemed_by_person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT gift_passes_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT gift_passes_status_check CHECK (status IN ('AVAILABLE','REDEEMED','EXPIRED','REVOKED')),
    CONSTRAINT gift_passes_code_not_blank CHECK (btrim(code) <> ''),
    CONSTRAINT gift_passes_redemption_shape_check CHECK ((status = 'REDEEMED' AND redeemed_by_person_id IS NOT NULL AND redeemed_at IS NOT NULL) OR status <> 'REDEEMED'),
    CONSTRAINT gift_passes_code_unique UNIQUE (tenant_id, code),
    CONSTRAINT gift_passes_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX gift_passes_redeemed_person_idx
    ON loyalty.gift_passes (tenant_id, redeemed_by_person_id, redeemed_at DESC)
    WHERE redeemed_by_person_id IS NOT NULL;

CREATE TABLE referral.referral_reward_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    referral_id uuid NOT NULL,
    reward_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT referral_reward_links_referral_fk FOREIGN KEY (tenant_id, referral_id)
        REFERENCES referral.referrals (tenant_id, id),
    CONSTRAINT referral_reward_links_reward_fk FOREIGN KEY (tenant_id, reward_id)
        REFERENCES loyalty.rewards (tenant_id, id),
    CONSTRAINT referral_reward_links_unique UNIQUE (tenant_id, referral_id, reward_id)
);

CREATE TRIGGER reward_ledger_entries_append_only
BEFORE UPDATE OR DELETE ON loyalty.reward_ledger_entries
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

COMMIT;
