-- AI Revenue & Operations Platform
-- Migration 036: Analytics metric catalog + snapshots (Wave 14 slice W14a)
--
-- Read-only analytics substrate (canonical domain §87-89): analytics NEVER
-- is a source of truth — it only READS settled domain facts and writes its
-- OWN tables below. F14: analytics degrades without ever blocking the
-- sale/payment/fulfillment path (no FK FROM domain tables TO analytics,
-- no trigger, no shared write path).
-- - `analytics.metric_definitions`: tenant-scoped catalog of the metric keys
--   the projections compute (key, family, formula_ref/version, unit,
--   granularity). Seeded per tenant by the recompute itself (upsert), so no
--   global seed rows here.
-- - `analytics.metric_snapshots`: daily (or gauge) computed points,
--   idempotent by (tenant, key, bucket): replay deletes + re-inserts the
--   window's own rows. Deliberately NOT append-only (unlike ledger/facts):
--   snapshots are a replaceable read-model, never history.
-- Money stays exact minor-unit strings (value_minor bigint, nullable);
-- ratios are integer basis points inside value_json (never floats).

BEGIN;

CREATE SCHEMA IF NOT EXISTS analytics;

CREATE TABLE analytics.metric_definitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    metric_key text NOT NULL,
    family text NOT NULL,
    formula_ref text NOT NULL,
    formula_version text NOT NULL DEFAULT 'v1',
    unit text NOT NULL,
    granularity text NOT NULL DEFAULT 'DAY',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT metric_definitions_key_not_blank CHECK (btrim(metric_key) <> ''),
    CONSTRAINT metric_definitions_family_not_blank CHECK (btrim(family) <> ''),
    CONSTRAINT metric_definitions_granularity_check CHECK (granularity IN ('DAY')),
    CONSTRAINT metric_definitions_tenant_key_unique UNIQUE (tenant_id, metric_key),
    CONSTRAINT metric_definitions_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE analytics.metric_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    metric_key text NOT NULL,
    bucket_start timestamptz NOT NULL,
    granularity text NOT NULL DEFAULT 'DAY',
    value_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    value_minor bigint,
    computed_at timestamptz NOT NULL DEFAULT now(),
    data_quality text NOT NULL DEFAULT 'OK',
    CONSTRAINT metric_snapshots_granularity_check CHECK (granularity IN ('DAY')),
    CONSTRAINT metric_snapshots_quality_check CHECK (data_quality IN ('OK','PARTIAL','EMPTY','DEGRADED')),
    CONSTRAINT metric_snapshots_tenant_key_bucket_unique UNIQUE (tenant_id, metric_key, bucket_start),
    CONSTRAINT metric_snapshots_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX metric_snapshots_tenant_key_bucket_idx
    ON analytics.metric_snapshots (tenant_id, metric_key, bucket_start);

CREATE INDEX metric_snapshots_tenant_computed_idx
    ON analytics.metric_snapshots (tenant_id, computed_at);

COMMIT;
