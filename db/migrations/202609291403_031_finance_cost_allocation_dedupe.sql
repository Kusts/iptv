-- AI Revenue & Operations Platform
-- Migration 031: Finance cost-allocation dedupe (Wave 10)
--
-- `finance.cost_allocations` (migration 005) had no dedupe key, so the
-- Wave 10 ingest (`finance.recompute_allocations`) could not replay safely.
-- Roll-forward ADD-only; existing migrations untouched.
--
-- Two complementary keys (one row per fact per cost type):
-- - ledger-linked allocations (settlement-derived supplier COGS): unique on
--   (tenant, cost_type, source_transaction_id, allocation_target_id);
--   every column is NOT NULL on this path so the constraint matches.
-- - fact-derived allocations without a ledger transaction (subscription
--   cycles, sent contacts, attribution touches, referral rewards): partial
--   unique index on (tenant, cost_type, target type, target id) WHERE
--   source_transaction_id IS NULL (NULLs never conflict in the plain
--   UNIQUE constraint above, hence the separate index).

BEGIN;

ALTER TABLE finance.cost_allocations
    ADD CONSTRAINT cost_allocations_source_dedupe_unique
    UNIQUE (tenant_id, cost_type, source_transaction_id, allocation_target_id);

CREATE UNIQUE INDEX cost_allocations_fact_dedupe_uidx
    ON finance.cost_allocations (tenant_id, cost_type, allocation_target_type, allocation_target_id)
    WHERE source_transaction_id IS NULL;

COMMIT;
