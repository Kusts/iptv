-- AI Revenue & Operations Platform
-- Migration 004: Catalog, Offers & Commerce

BEGIN;

CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS commerce;

CREATE TABLE catalog.products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    product_key text NOT NULL,
    name text NOT NULL,
    product_type text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT products_type_check CHECK (product_type IN ('SERVICE','APP','ADDON','BUNDLE','OTHER')),
    CONSTRAINT products_status_check CHECK (status IN ('ACTIVE','INACTIVE','ARCHIVED')),
    CONSTRAINT products_key_not_blank CHECK (btrim(product_key) <> ''),
    CONSTRAINT products_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT products_tenant_key_unique UNIQUE (tenant_id, product_key),
    CONSTRAINT products_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE catalog.plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    product_id uuid NOT NULL,
    plan_key text NOT NULL,
    name text NOT NULL,
    billing_interval_unit text NOT NULL,
    billing_interval_count integer NOT NULL DEFAULT 1,
    status text NOT NULL DEFAULT 'ACTIVE',
    metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT plans_product_fk FOREIGN KEY (tenant_id, product_id)
        REFERENCES catalog.products (tenant_id, id),
    CONSTRAINT plans_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT plans_interval_unit_check CHECK (billing_interval_unit IN ('DAY','WEEK','MONTH','YEAR')),
    CONSTRAINT plans_interval_count_positive CHECK (billing_interval_count > 0),
    CONSTRAINT plans_status_check CHECK (status IN ('ACTIVE','INACTIVE','ARCHIVED')),
    CONSTRAINT plans_tenant_key_unique UNIQUE (tenant_id, plan_key),
    CONSTRAINT plans_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE catalog.addons (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    addon_key text NOT NULL,
    name text NOT NULL,
    billing_type text NOT NULL,
    entitlement_feature_key text,
    status text NOT NULL DEFAULT 'ACTIVE',
    metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT addons_billing_type_check CHECK (billing_type IN ('ONE_TIME','RECURRING')),
    CONSTRAINT addons_status_check CHECK (status IN ('ACTIVE','INACTIVE','ARCHIVED')),
    CONSTRAINT addons_tenant_key_unique UNIQUE (tenant_id, addon_key),
    CONSTRAINT addons_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE catalog.prices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    sellable_type text NOT NULL,
    sellable_id uuid NOT NULL,
    amount_minor bigint NOT NULL,
    currency char(3) NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz,
    segment_key text,
    status text NOT NULL DEFAULT 'ACTIVE',
    metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT prices_sellable_type_check CHECK (sellable_type IN ('PRODUCT','PLAN','ADDON')),
    CONSTRAINT prices_amount_nonnegative CHECK (amount_minor >= 0),
    CONSTRAINT prices_window_check CHECK (ends_at IS NULL OR ends_at > starts_at),
    CONSTRAINT prices_status_check CHECK (status IN ('ACTIVE','INACTIVE','ARCHIVED')),
    CONSTRAINT prices_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX prices_lookup_idx
    ON catalog.prices (tenant_id, sellable_type, sellable_id, status, starts_at DESC);

CREATE TABLE catalog.offers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    person_id uuid,
    customer_id uuid,
    status text NOT NULL DEFAULT 'CREATED',
    expires_at timestamptz,
    pricing_context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    presented_at timestamptz,
    accepted_at timestamptz,
    CONSTRAINT offers_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT offers_customer_fk FOREIGN KEY (tenant_id, customer_id)
        REFERENCES crm.customers (tenant_id, id),
    CONSTRAINT offers_status_check CHECK (status IN ('CREATED','PRESENTED','ACCEPTED','EXPIRED','CANCELLED')),
    CONSTRAINT offers_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX offers_person_idx ON catalog.offers (tenant_id, person_id, created_at DESC);
CREATE INDEX offers_customer_idx ON catalog.offers (tenant_id, customer_id, created_at DESC) WHERE customer_id IS NOT NULL;

CREATE TABLE catalog.offer_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    offer_id uuid NOT NULL,
    sellable_type text NOT NULL,
    sellable_id uuid NOT NULL,
    quantity numeric(12,3) NOT NULL DEFAULT 1,
    unit_amount_minor bigint NOT NULL,
    currency char(3) NOT NULL,
    metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT offer_items_offer_fk FOREIGN KEY (tenant_id, offer_id)
        REFERENCES catalog.offers (tenant_id, id),
    CONSTRAINT offer_items_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT offer_items_sellable_type_check CHECK (sellable_type IN ('PRODUCT','PLAN','ADDON')),
    CONSTRAINT offer_items_quantity_positive CHECK (quantity > 0),
    CONSTRAINT offer_items_amount_nonnegative CHECK (unit_amount_minor >= 0),
    CONSTRAINT offer_items_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE catalog.coupons (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    code text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    discount_type text NOT NULL,
    discount_value numeric(14,4) NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz,
    max_redemptions integer,
    max_per_person integer,
    stack_policy text NOT NULL DEFAULT 'NON_STACKABLE',
    eligibility_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    budget_cap_minor bigint,
    currency char(3),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT coupons_status_check CHECK (status IN ('ACTIVE','INACTIVE','EXPIRED','ARCHIVED')),
    CONSTRAINT coupons_discount_type_check CHECK (discount_type IN ('FIXED','PERCENTAGE')),
    CONSTRAINT coupons_discount_value_positive CHECK (discount_value > 0),
    CONSTRAINT coupons_percentage_limit CHECK (discount_type <> 'PERCENTAGE' OR discount_value <= 100),
    CONSTRAINT coupons_window_check CHECK (ends_at IS NULL OR ends_at > starts_at),
    CONSTRAINT coupons_max_redemptions_check CHECK (max_redemptions IS NULL OR max_redemptions > 0),
    CONSTRAINT coupons_max_per_person_check CHECK (max_per_person IS NULL OR max_per_person > 0),
    CONSTRAINT coupons_budget_check CHECK (budget_cap_minor IS NULL OR budget_cap_minor >= 0),
    CONSTRAINT coupons_tenant_code_unique UNIQUE (tenant_id, code),
    CONSTRAINT coupons_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE commerce.orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    person_id uuid NOT NULL,
    customer_id uuid,
    source_offer_id uuid,
    order_type text NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT',
    currency char(3) NOT NULL,
    gross_amount_minor bigint NOT NULL DEFAULT 0,
    discount_amount_minor bigint NOT NULL DEFAULT 0,
    reward_amount_minor bigint NOT NULL DEFAULT 0,
    net_amount_minor bigint NOT NULL DEFAULT 0,
    settled_amount_minor bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    awaiting_payment_at timestamptz,
    settled_at timestamptz,
    cancelled_at timestamptz,
    expires_at timestamptz,
    CONSTRAINT orders_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT orders_customer_fk FOREIGN KEY (tenant_id, customer_id)
        REFERENCES crm.customers (tenant_id, id),
    CONSTRAINT orders_offer_fk FOREIGN KEY (tenant_id, source_offer_id)
        REFERENCES catalog.offers (tenant_id, id),
    CONSTRAINT orders_type_check CHECK (order_type IN ('NEW_SUBSCRIPTION','RENEWAL','ADDON','APP','MIXED','ADJUSTMENT')),
    CONSTRAINT orders_status_check CHECK (status IN ('DRAFT','AWAITING_PAYMENT','SETTLED','CANCELLED','EXPIRED')),
    CONSTRAINT orders_amounts_nonnegative CHECK (
        gross_amount_minor >= 0 AND discount_amount_minor >= 0 AND reward_amount_minor >= 0 AND
        net_amount_minor >= 0 AND settled_amount_minor >= 0
    ),
    CONSTRAINT orders_net_math_check CHECK (net_amount_minor = gross_amount_minor - discount_amount_minor - reward_amount_minor),
    CONSTRAINT orders_discount_not_over_gross CHECK (discount_amount_minor + reward_amount_minor <= gross_amount_minor),
    CONSTRAINT orders_settled_not_over_net CHECK (settled_amount_minor <= net_amount_minor),
    CONSTRAINT orders_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX orders_person_idx ON commerce.orders (tenant_id, person_id, created_at DESC);
CREATE INDEX orders_customer_idx ON commerce.orders (tenant_id, customer_id, created_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX orders_status_idx ON commerce.orders (tenant_id, status, created_at DESC);

CREATE TABLE commerce.order_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    order_id uuid NOT NULL,
    item_type text NOT NULL,
    sellable_type text NOT NULL,
    sellable_id uuid NOT NULL,
    quantity numeric(12,3) NOT NULL DEFAULT 1,
    unit_price_minor bigint NOT NULL,
    gross_minor bigint NOT NULL,
    discount_minor bigint NOT NULL DEFAULT 0,
    reward_minor bigint NOT NULL DEFAULT 0,
    net_minor bigint NOT NULL,
    metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT order_items_order_fk FOREIGN KEY (tenant_id, order_id)
        REFERENCES commerce.orders (tenant_id, id),
    CONSTRAINT order_items_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT order_items_type_check CHECK (item_type IN ('BASE_PLAN','RECURRING_ADDON','ONE_TIME_ADDON','APP','OTHER')),
    CONSTRAINT order_items_sellable_type_check CHECK (sellable_type IN ('PRODUCT','PLAN','ADDON')),
    CONSTRAINT order_items_quantity_positive CHECK (quantity > 0),
    CONSTRAINT order_items_amounts_nonnegative CHECK (
        unit_price_minor >= 0 AND gross_minor >= 0 AND discount_minor >= 0 AND reward_minor >= 0 AND net_minor >= 0
    ),
    CONSTRAINT order_items_net_math_check CHECK (net_minor = gross_minor - discount_minor - reward_minor),
    CONSTRAINT order_items_discount_not_over_gross CHECK (discount_minor + reward_minor <= gross_minor),
    CONSTRAINT order_items_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX order_items_order_idx ON commerce.order_items (tenant_id, order_id);

CREATE TABLE commerce.price_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    order_item_id uuid NOT NULL,
    sale_price_minor bigint NOT NULL,
    supplier_cost_minor bigint,
    currency char(3) NOT NULL,
    price_source_ref text,
    captured_at timestamptz NOT NULL DEFAULT now(),
    context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT price_snapshots_order_item_fk FOREIGN KEY (tenant_id, order_item_id)
        REFERENCES commerce.order_items (tenant_id, id),
    CONSTRAINT price_snapshots_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT price_snapshots_sale_nonnegative CHECK (sale_price_minor >= 0),
    CONSTRAINT price_snapshots_cost_nonnegative CHECK (supplier_cost_minor IS NULL OR supplier_cost_minor >= 0),
    CONSTRAINT price_snapshots_one_per_item UNIQUE (tenant_id, order_item_id),
    CONSTRAINT price_snapshots_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE catalog.coupon_redemptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    coupon_id uuid NOT NULL,
    person_id uuid NOT NULL,
    order_id uuid,
    discount_minor bigint NOT NULL,
    status text NOT NULL DEFAULT 'RESERVED',
    redeemed_at timestamptz,
    released_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT coupon_redemptions_coupon_fk FOREIGN KEY (tenant_id, coupon_id)
        REFERENCES catalog.coupons (tenant_id, id),
    CONSTRAINT coupon_redemptions_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT coupon_redemptions_order_fk FOREIGN KEY (tenant_id, order_id)
        REFERENCES commerce.orders (tenant_id, id),
    CONSTRAINT coupon_redemptions_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT coupon_redemptions_discount_nonnegative CHECK (discount_minor >= 0),
    CONSTRAINT coupon_redemptions_status_check CHECK (status IN ('RESERVED','APPLIED','RELEASED','REVERSED')),
    CONSTRAINT coupon_redemptions_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX coupon_redemptions_coupon_idx ON catalog.coupon_redemptions (tenant_id, coupon_id, created_at DESC);
CREATE INDEX coupon_redemptions_person_idx ON catalog.coupon_redemptions (tenant_id, person_id, created_at DESC);

COMMIT;
