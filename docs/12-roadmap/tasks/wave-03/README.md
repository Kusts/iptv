# Execution Wave 03 — Commerce, Billing & Financial Ledger

> Status: Documentation-ready  
> Version: 0.11  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Outcome

Turn an approved offer into an auditable Order, external payment when needed, balanced ledger entries and canonical settlement.

## Story pack

- [CB-01 — Catalog / Plan / Add-on / Price](cb_01.md)
- [CB-02 — Offer resolution](cb_02.md)
- [CB-03 — Order + Price Snapshot](cb_03.md)
- [CB-04 — Asaas payment adapter](cb_04.md)
- [CB-05 — Financial Ledger](cb_05.md)
- [CB-06 — Settlement Engine](cb_06.md)
- [CB-07 — Refund / Chargeback](cb_07.md)

## Execution rule

Stories may run in parallel only when their write ownership and prerequisites do not overlap ambiguously. The Planner must load `docs/00-meta/agent-documentation-loading-order.md` before decomposition.

## Wave gate

- every Story acceptance criterion has automated coverage or a documented manual gate;
- canonical state/event names are reused exactly;
- tenant isolation is covered where the Story touches tenant data;
- idempotency/retry behavior is covered where side effects occur;
- no open domain decision is hidden in code;
- docs/contracts/schema are updated before implementation if the design changes.

## Auto-review result

This Wave index was reviewed against the corresponding Epic and does not redefine product rules. Story files point back to canonical sources and include failure paths, telemetry and security checks.
