-- 060 Billing customer<->provider binding (GAP-LOOP-1: vinculo pessoa->customer Asaas).
--
-- Justification (operator decision, branch closure/billing-customer-binding):
-- - `charge.create` needs a PROVEN Asaas `customer` id for the order's person.
--   The `RealAsaasAdapter` `/payments` minimum requires `customer`: without a
--   stored binding the stub sent no customer and the provider rejected (4xx),
--   leaving a silent PENDING charge with no operator path. This migration adds
--   the explicit binding table so `charge.create` auto-resolves the id from
--   the person (no forged field on the request — anti-spoofing) and fails
--   closed with an explicit precondition error when no binding exists.
-- - One row per (tenant, person, provider): a person has AT MOST ONE provider
--   customer per provider inside a tenant
--   (`customer_provider_bindings_person_unique`).
-- - One person per (tenant, provider, external id): an external customer id
--   maps to AT MOST ONE person inside a tenant
--   (`customer_provider_bindings_external_unique`). Cross-tenant reuse of the
--   same external id is allowed — tenant scoping mirrors the existing
--   `charge_provider_bindings_external_unique (tenant, provider,
--   external_charge_id)` convention (005). Both uniques are tenant-scoped and
--   documented here; RLS `tenant_isolation` enforces the tenant boundary.
-- - LGPD: this slice stores NO document (no CPF/CNPJ column on
--   `identity.persons` and none here). The provision command carries an
--   optional document in-transit only: sandbox/echo accept the documented
--   test constant, production refuses without a real document
--   (`DOCUMENT_REQUIRED`) and NEVER invents one.
--
-- Deliberately NOT in this migration:
--   * No BYPASSRLS anywhere.
--   * No grants to outbox roles (`outbox_worker`/`outbox_executor` keep
--     their 050 EXECUTE-only boundary and hold NOTHING here).
--   * No GRANT to PUBLIC.
--   * No change to 001-059 (append-only).
BEGIN;

CREATE TABLE billing.customer_provider_bindings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    person_id uuid NOT NULL,
    provider text NOT NULL,
    external_customer_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT customer_provider_bindings_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT customer_provider_bindings_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT customer_provider_bindings_provider_not_blank CHECK (btrim(provider) <> ''),
    CONSTRAINT customer_provider_bindings_external_not_blank CHECK (btrim(external_customer_id) <> ''),
    CONSTRAINT customer_provider_bindings_person_unique UNIQUE (tenant_id, person_id, provider),
    CONSTRAINT customer_provider_bindings_external_unique UNIQUE (tenant_id, provider, external_customer_id),
    CONSTRAINT customer_provider_bindings_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX customer_provider_bindings_person_idx
    ON billing.customer_provider_bindings (tenant_id, person_id, provider);

-- RLS enrollment (052 template): tenant_isolation USING/WITH CHECK on
-- app.tenant_id, fail-closed when unset.
GRANT USAGE ON SCHEMA billing TO iptv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.customer_provider_bindings TO iptv_app;

ALTER TABLE billing.customer_provider_bindings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON billing.customer_provider_bindings;
CREATE POLICY tenant_isolation ON billing.customer_provider_bindings
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
