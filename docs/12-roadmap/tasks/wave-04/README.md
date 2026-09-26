# Execution Wave 04 — Subscription & Entitlements

> Status: Documentation-ready  
> Version: 0.11  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Outcome

Translate settled commerce into recurring commercial rights, recurring add-on economics and renewal/cancellation lifecycles.

## Story pack

- [SE-01 — Initial subscription creation](se_01.md)
- [SE-02 — Subscription cycle](se_02.md)
- [SE-03 — Recurring add-on](se_03.md)
- [SE-04 — Add-on cycle economics](se_04.md)
- [SE-05 — Entitlement projection](se_05.md)
- [SE-06 — Renewal / cancellation / grace](se_06.md)

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
