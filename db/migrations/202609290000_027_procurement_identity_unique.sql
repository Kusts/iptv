-- AI Revenue & Operations Platform
-- Migration 027: procurement identity uniqueness (Wave 7 review fix F5)
--
-- Justification (review iptv-w7-review, finding 5 HIGH):
-- - `inventory.procurement_orders` had no uniqueness per commerce Order /
--   app trial: two reserves with distinct idempotency keys created two
--   charge-eligible procurements for the same purchase identity.
-- - One active (non-FAILED) procurement per (tenant, commerce_order) and
--   one per (tenant, app_trial): concurrent duplicates serialize on the
--   supplier advisory lock and the loser observes the winner (code treats
--   the violation as an idempotent conflict, never a second charge).
-- - FAILED rows are excluded so a legitimate retry after release/expire/
--   failed-charge can reserve again. APPEND-ONLY RULE: 024/025/026 are
--   never edited; this migration only ADDS constraints.
-- - Partial unique indexes (not table constraints) express the
--   "excluding FAILED" predicate portably.

BEGIN;

CREATE UNIQUE INDEX procurement_orders_one_active_per_commerce_order
    ON inventory.procurement_orders (tenant_id, commerce_order_id)
    WHERE status <> 'FAILED';

CREATE UNIQUE INDEX procurement_orders_one_active_per_app_trial
    ON inventory.procurement_orders (tenant_id, app_trial_id)
    WHERE status <> 'FAILED';

COMMIT;
