-- AI Revenue & Operations Platform
-- Migration 006: Subscriptions, recurring add-ons, cycles & entitlements

BEGIN;

CREATE SCHEMA IF NOT EXISTS subscription;
CREATE SCHEMA IF NOT EXISTS entitlement;

CREATE TABLE subscription.subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    originating_order_id uuid,
    status text NOT NULL DEFAULT 'PENDING_ACTIVATION',
    started_at timestamptz,
    current_period_start timestamptz,
    current_period_end timestamptz,
    cancel_at_period_end boolean NOT NULL DEFAULT false,
    cancelled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT subscriptions_customer_fk FOREIGN KEY (tenant_id, customer_id)
        REFERENCES crm.customers (tenant_id, id),
    CONSTRAINT subscriptions_plan_fk FOREIGN KEY (tenant_id, plan_id)
        REFERENCES catalog.plans (tenant_id, id),
    CONSTRAINT subscriptions_order_fk FOREIGN KEY (tenant_id, originating_order_id)
        REFERENCES commerce.orders (tenant_id, id),
    CONSTRAINT subscriptions_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT subscriptions_status_check CHECK (status IN ('PENDING_ACTIVATION','ACTIVE','SUSPENDED','ENDED')),
    CONSTRAINT subscriptions_period_check CHECK (current_period_start IS NULL OR current_period_end IS NULL OR current_period_end > current_period_start),
    CONSTRAINT subscriptions_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX subscriptions_customer_idx ON subscription.subscriptions (tenant_id, customer_id, created_at DESC);
CREATE INDEX subscriptions_status_period_idx ON subscription.subscriptions (tenant_id, status, current_period_end);

CREATE TABLE subscription.subscription_cycles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    cycle_no integer NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    renewal_order_id uuid,
    status text NOT NULL DEFAULT 'PENDING',
    base_revenue_minor bigint NOT NULL DEFAULT 0,
    base_provider_cost_minor bigint,
    currency char(3) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT subscription_cycles_subscription_fk FOREIGN KEY (tenant_id, subscription_id)
        REFERENCES subscription.subscriptions (tenant_id, id),
    CONSTRAINT subscription_cycles_order_fk FOREIGN KEY (tenant_id, renewal_order_id)
        REFERENCES commerce.orders (tenant_id, id),
    CONSTRAINT subscription_cycles_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT subscription_cycles_cycle_positive CHECK (cycle_no > 0),
    CONSTRAINT subscription_cycles_window_check CHECK (ends_at > starts_at),
    CONSTRAINT subscription_cycles_status_check CHECK (status IN ('PENDING','ACTIVE','COMPLETED','FAILED','CANCELLED')),
    CONSTRAINT subscription_cycles_amounts_check CHECK (base_revenue_minor >= 0 AND (base_provider_cost_minor IS NULL OR base_provider_cost_minor >= 0)),
    CONSTRAINT subscription_cycles_unique UNIQUE (tenant_id, subscription_id, cycle_no),
    CONSTRAINT subscription_cycles_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE subscription.subscription_addons (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    addon_id uuid NOT NULL,
    quantity numeric(12,3) NOT NULL DEFAULT 1,
    status text NOT NULL DEFAULT 'ACTIVE',
    effective_from timestamptz NOT NULL,
    effective_until timestamptz,
    price_policy_ref text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT subscription_addons_subscription_fk FOREIGN KEY (tenant_id, subscription_id)
        REFERENCES subscription.subscriptions (tenant_id, id),
    CONSTRAINT subscription_addons_addon_fk FOREIGN KEY (tenant_id, addon_id)
        REFERENCES catalog.addons (tenant_id, id),
    CONSTRAINT subscription_addons_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT subscription_addons_quantity_positive CHECK (quantity > 0),
    CONSTRAINT subscription_addons_status_check CHECK (status IN ('SCHEDULED','ACTIVE','CANCEL_AT_PERIOD_END','CANCELLED','EXPIRED')),
    CONSTRAINT subscription_addons_window_check CHECK (effective_until IS NULL OR effective_until > effective_from),
    CONSTRAINT subscription_addons_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX subscription_addons_active_idx
    ON subscription.subscription_addons (tenant_id, subscription_id, status, effective_from);

CREATE OR REPLACE FUNCTION subscription.require_recurring_addon()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_billing_type text;
BEGIN
    SELECT billing_type INTO v_billing_type
    FROM catalog.addons
    WHERE tenant_id = NEW.tenant_id AND id = NEW.addon_id;

    IF v_billing_type IS DISTINCT FROM 'RECURRING' THEN
        RAISE EXCEPTION 'subscription_addons only accepts RECURRING catalog.addons';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER subscription_addons_recurring_only
BEFORE INSERT OR UPDATE OF addon_id, tenant_id ON subscription.subscription_addons
FOR EACH ROW EXECUTE FUNCTION subscription.require_recurring_addon();

CREATE TABLE subscription.subscription_addon_cycle_charges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    subscription_cycle_id uuid NOT NULL,
    subscription_addon_id uuid NOT NULL,
    quantity numeric(12,3) NOT NULL,
    revenue_minor bigint NOT NULL,
    provider_cost_minor bigint NOT NULL,
    currency char(3) NOT NULL,
    order_item_id uuid,
    provider_credit_entry_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT addon_cycle_charges_cycle_fk FOREIGN KEY (tenant_id, subscription_cycle_id)
        REFERENCES subscription.subscription_cycles (tenant_id, id),
    CONSTRAINT addon_cycle_charges_addon_fk FOREIGN KEY (tenant_id, subscription_addon_id)
        REFERENCES subscription.subscription_addons (tenant_id, id),
    CONSTRAINT addon_cycle_charges_order_item_fk FOREIGN KEY (tenant_id, order_item_id)
        REFERENCES commerce.order_items (tenant_id, id),
    CONSTRAINT addon_cycle_charges_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT addon_cycle_charges_quantity_positive CHECK (quantity > 0),
    CONSTRAINT addon_cycle_charges_amounts_nonnegative CHECK (revenue_minor >= 0 AND provider_cost_minor >= 0),
    CONSTRAINT addon_cycle_charges_unique UNIQUE (tenant_id, subscription_cycle_id, subscription_addon_id),
    CONSTRAINT addon_cycle_charges_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE entitlement.entitlements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    feature_key text NOT NULL,
    status text NOT NULL DEFAULT 'PENDING',
    quantity numeric(12,3),
    starts_at timestamptz NOT NULL,
    ends_at timestamptz,
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT entitlements_customer_fk FOREIGN KEY (tenant_id, customer_id)
        REFERENCES crm.customers (tenant_id, id),
    CONSTRAINT entitlements_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT entitlements_status_check CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','EXPIRED','REVOKED','CANCELLED')),
    CONSTRAINT entitlements_quantity_check CHECK (quantity IS NULL OR quantity >= 0),
    CONSTRAINT entitlements_window_check CHECK (ends_at IS NULL OR ends_at > starts_at),
    CONSTRAINT entitlements_feature_not_blank CHECK (btrim(feature_key) <> ''),
    CONSTRAINT entitlements_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX entitlements_customer_active_idx
    ON entitlement.entitlements (tenant_id, customer_id, feature_key, status, starts_at DESC);

CREATE TABLE entitlement.entitlement_grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    entitlement_id uuid NOT NULL,
    grant_type text NOT NULL,
    delta_quantity numeric(12,3),
    starts_at timestamptz NOT NULL,
    ends_at timestamptz,
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT entitlement_grants_entitlement_fk FOREIGN KEY (tenant_id, entitlement_id)
        REFERENCES entitlement.entitlements (tenant_id, id),
    CONSTRAINT entitlement_grants_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT entitlement_grants_window_check CHECK (ends_at IS NULL OR ends_at > starts_at),
    CONSTRAINT entitlement_grants_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TRIGGER entitlement_grants_append_only
BEFORE UPDATE OR DELETE ON entitlement.entitlement_grants
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

COMMIT;
