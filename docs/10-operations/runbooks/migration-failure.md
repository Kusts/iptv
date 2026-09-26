# Runbook — Migration Failure

> Status: Operational baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked against expand/migrate/contract strategy and authoritative-data safety.

## Trigger

Migration fails, times out, causes unexpected lock/load, or post-migration verification detects schema/data inconsistency.

## Immediate action

1. stop further deployment stages;
2. determine whether migration transaction rolled back or partially committed;
3. do not blindly rerun non-idempotent data movement;
4. inspect DB health/locks and application compatibility;
5. use feature flag/previous app version when schema compatibility allows.

## Recovery

Prefer forward-fix/compatible expand strategy over destructive down migrations. Restore from backup only when integrity requires it and according to DR process.

## Verification

After fix, run schema checks, targeted data invariants, application smoke tests, outbox/workflow checks and reconciliation where affected.

## Auto-review result

Reviewed to avoid destructive reflex rollback and preserve expand/migrate/contract compatibility.
