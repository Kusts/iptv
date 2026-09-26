-- AI Revenue & Operations Platform
-- Migration 005: Billing + immutable financial ledger

BEGIN;

CREATE SCHEMA IF NOT EXISTS billing;
CREATE SCHEMA IF NOT EXISTS finance;

CREATE TABLE finance.financial_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    account_code text NOT NULL,
    name text NOT NULL,
    account_type text NOT NULL,
    currency char(3) NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT financial_accounts_type_check CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE','CONTRA')),
    CONSTRAINT financial_accounts_status_check CHECK (status IN ('ACTIVE','INACTIVE','ARCHIVED')),
    CONSTRAINT financial_accounts_tenant_code_currency_unique UNIQUE (tenant_id, account_code, currency),
    CONSTRAINT financial_accounts_tenant_id_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT financial_accounts_tenant_id_id_currency_unique UNIQUE (tenant_id, id, currency)
);

CREATE TABLE finance.financial_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    transaction_type text NOT NULL,
    reference_type text NOT NULL,
    reference_id uuid,
    idempotency_key text NOT NULL,
    occurred_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    reversal_of_transaction_id uuid,
    metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT financial_transactions_reversal_fk FOREIGN KEY (tenant_id, reversal_of_transaction_id)
        REFERENCES finance.financial_transactions (tenant_id, id),
    CONSTRAINT financial_transactions_tenant_id_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT financial_transactions_idempotency_unique UNIQUE (tenant_id, idempotency_key),
    CONSTRAINT financial_transactions_no_self_reversal CHECK (reversal_of_transaction_id IS NULL OR reversal_of_transaction_id <> id)
);

CREATE INDEX financial_transactions_reference_idx
    ON finance.financial_transactions (tenant_id, reference_type, reference_id, occurred_at DESC);

CREATE TABLE finance.financial_ledger_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    financial_transaction_id uuid NOT NULL,
    financial_account_id uuid NOT NULL,
    direction text NOT NULL,
    amount_minor bigint NOT NULL,
    currency char(3) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT financial_ledger_transaction_fk FOREIGN KEY (tenant_id, financial_transaction_id)
        REFERENCES finance.financial_transactions (tenant_id, id),
    CONSTRAINT financial_ledger_account_fk FOREIGN KEY (tenant_id, financial_account_id, currency)
        REFERENCES finance.financial_accounts (tenant_id, id, currency),
    CONSTRAINT financial_ledger_direction_check CHECK (direction IN ('DEBIT','CREDIT')),
    CONSTRAINT financial_ledger_amount_positive CHECK (amount_minor > 0),
    CONSTRAINT financial_ledger_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX financial_ledger_transaction_idx
    ON finance.financial_ledger_entries (tenant_id, financial_transaction_id);
CREATE INDEX financial_ledger_account_idx
    ON finance.financial_ledger_entries (tenant_id, financial_account_id, created_at DESC);

CREATE OR REPLACE FUNCTION finance.assert_transaction_balanced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_tenant uuid;
    v_tx uuid;
    v_bad_count integer;
BEGIN
    v_tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
    v_tx := COALESCE(NEW.financial_transaction_id, OLD.financial_transaction_id);

    SELECT count(*) INTO v_bad_count
    FROM (
        SELECT currency,
               sum(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END) AS net_minor
        FROM finance.financial_ledger_entries
        WHERE tenant_id = v_tenant
          AND financial_transaction_id = v_tx
        GROUP BY currency
        HAVING sum(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0
    ) q;

    IF v_bad_count > 0 THEN
        RAISE EXCEPTION 'financial transaction % is not balanced for tenant %', v_tx, v_tenant;
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER financial_ledger_balanced_at_commit
AFTER INSERT OR UPDATE OR DELETE ON finance.financial_ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION finance.assert_transaction_balanced();


CREATE OR REPLACE FUNCTION finance.assert_transaction_has_entries()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_entry_count integer;
BEGIN
    SELECT count(*) INTO v_entry_count
    FROM finance.financial_ledger_entries
    WHERE tenant_id = NEW.tenant_id
      AND financial_transaction_id = NEW.id;

    IF v_entry_count < 2 THEN
        RAISE EXCEPTION 'financial transaction % must contain at least two ledger entries', NEW.id;
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER financial_transaction_complete_at_commit
AFTER INSERT ON finance.financial_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION finance.assert_transaction_has_entries();

CREATE TRIGGER financial_transactions_append_only
BEFORE UPDATE OR DELETE ON finance.financial_transactions
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

CREATE TRIGGER financial_ledger_entries_append_only
BEFORE UPDATE OR DELETE ON finance.financial_ledger_entries
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

CREATE TABLE finance.cost_allocations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    cost_type text NOT NULL,
    amount_minor bigint NOT NULL,
    currency char(3) NOT NULL,
    allocation_target_type text NOT NULL,
    allocation_target_id uuid NOT NULL,
    allocation_method text NOT NULL,
    source_transaction_id uuid,
    occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cost_allocations_source_tx_fk FOREIGN KEY (tenant_id, source_transaction_id)
        REFERENCES finance.financial_transactions (tenant_id, id),
    CONSTRAINT cost_allocations_amount_nonnegative CHECK (amount_minor >= 0),
    CONSTRAINT cost_allocations_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX cost_allocations_target_idx
    ON finance.cost_allocations (tenant_id, allocation_target_type, allocation_target_id, occurred_at DESC);

CREATE TABLE billing.payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    order_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'PENDING',
    amount_minor bigint NOT NULL,
    currency char(3) NOT NULL,
    payment_method text,
    due_at timestamptz,
    paid_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT payments_order_fk FOREIGN KEY (tenant_id, order_id)
        REFERENCES commerce.orders (tenant_id, id),
    CONSTRAINT payments_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT payments_status_check CHECK (status IN ('PENDING','PROCESSING','PAID','FAILED','CANCELLED','EXPIRED','PARTIALLY_REFUNDED','REFUNDED','CHARGEBACK')),
    CONSTRAINT payments_amount_positive CHECK (amount_minor > 0),
    CONSTRAINT payments_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX payments_order_idx ON billing.payments (tenant_id, order_id, created_at DESC);
CREATE INDEX payments_status_due_idx ON billing.payments (tenant_id, status, due_at) WHERE status IN ('PENDING','PROCESSING');

CREATE TABLE billing.payment_provider_bindings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    payment_id uuid NOT NULL,
    provider text NOT NULL,
    external_customer_id text,
    external_payment_id text NOT NULL,
    status_raw text,
    last_synced_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT payment_provider_bindings_payment_fk FOREIGN KEY (tenant_id, payment_id)
        REFERENCES billing.payments (tenant_id, id),
    CONSTRAINT payment_provider_bindings_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT payment_provider_bindings_external_unique UNIQUE (tenant_id, provider, external_payment_id),
    CONSTRAINT payment_provider_bindings_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE billing.payment_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    payment_id uuid NOT NULL,
    attempt_no integer NOT NULL,
    status text NOT NULL,
    provider_request_id text,
    error_code text,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    CONSTRAINT payment_attempts_payment_fk FOREIGN KEY (tenant_id, payment_id)
        REFERENCES billing.payments (tenant_id, id),
    CONSTRAINT payment_attempts_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT payment_attempts_attempt_positive CHECK (attempt_no > 0),
    CONSTRAINT payment_attempts_unique UNIQUE (tenant_id, payment_id, attempt_no),
    CONSTRAINT payment_attempts_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE billing.refunds (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    payment_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'REQUESTED',
    amount_minor bigint NOT NULL,
    currency char(3) NOT NULL,
    reason text NOT NULL,
    provider_external_id text,
    requested_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CONSTRAINT refunds_payment_fk FOREIGN KEY (tenant_id, payment_id)
        REFERENCES billing.payments (tenant_id, id),
    CONSTRAINT refunds_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT refunds_status_check CHECK (status IN ('REQUESTED','PROCESSING','SUCCEEDED','FAILED','CANCELLED')),
    CONSTRAINT refunds_amount_positive CHECK (amount_minor > 0),
    CONSTRAINT refunds_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX refunds_payment_idx ON billing.refunds (tenant_id, payment_id, requested_at DESC);

COMMIT;
