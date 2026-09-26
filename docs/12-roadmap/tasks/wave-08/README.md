# Execution Wave 08 — Reliability & Pilot Readiness

> Status: Documentation-ready  
> Version: 0.11  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Outcome

Make the pilot operationally dependable, observable, recoverable and measurable before relying on it in production.

## Story pack

- [RP-01 — Reconciliation jobs](rp_01.md)
- [RP-02 — SLOs / alerts](rp_02.md)
- [RP-03 — Backup / restore](rp_03.md)
- [RP-04 — Privacy operations](rp_04.md)
- [RP-05 — Pilot baseline](rp_05.md)
- [RP-06 — Manual fallback / runbooks](rp_06.md)
- [RP-07 — Release gate](rp_07.md)

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
