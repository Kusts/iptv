# Operational Dashboard Catalog

> Status: Canonical baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked against observability, SLO, finance and workflow requirements.

## Platform health

Show:

- API availability/latency/error;
- DB connections/latency/storage;
- workflow queue/backlog/retries/DLQ;
- outbox/inbox lag;
- deployment/migration health;
- active incidents.

## Provider operations

Show by provider/action:

- pending/running/succeeded/failed/human-required;
- latency percentiles;
- postcondition verification failures;
- browser challenge/drift;
- server health scores;
- reconciliation mismatches.

## Messaging

Show:

- gateway session health;
- inbound/outbound throughput;
- handoff/delivery failures where observable;
- queue age;
- suppressions/frequency-cap decisions.

## AI/Agent

Show:

- runs/tool executions;
- latency/cost;
- policy denials;
- tool failures/ambiguous outcomes;
- HITL escalation;
- eval regression/release version.

## Billing/Revenue operations

Show:

- webhook age/backlog;
- unprocessed payment events;
- Orders awaiting settlement;
- paid-but-unfulfilled cases;
- ledger posting failures;
- reconciliation drift.

## Inventory

Show:

- current provider-credit inventory;
- burn rate;
- forecast/safety stock;
- supplier recharge deadline;
- low-credit alerts.

## Dashboard rule

Every red operational widget must link to an owner/runbook or an actionable filtered work queue. Dashboards are not decoration.

## Auto-review result

Reviewed to align dashboards with actual operational decisions rather than duplicate business analytics dashboards.
