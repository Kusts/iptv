# Runbook — Outbox / Workflow Backlog

> Status: Operational baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked for duplicate-side-effect prevention and ordered recovery.

## Trigger

Increasing outbox age, workflow queue depth, repeated retries/DLQ or delayed customer/business side effects.

## Diagnose

- isolate producer vs dispatcher vs consumer/runtime failure;
- identify affected event/action types and tenants;
- check dependency outage and recent release;
- inspect oldest backlog age and retry storm risk.

## Recovery

1. fix/disable failing consumer or dependency;
2. throttle replay/drain rate;
3. rely on inbox/idempotency at consumers;
4. do not manually re-trigger external mutations without checking existing provider/payment state;
5. monitor backlog age to zero/normal baseline.

## Escalate

Use reconciliation for ambiguous external side effects and HITL for cases that cannot be safely replayed.

## Auto-review result

Reviewed to make backlog recovery safe under at-least-once delivery.
