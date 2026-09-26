# Execution Wave 05 — Provider Fulfillment & Inventory

> Status: Documentation-ready  
> Version: 0.11  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Outcome

Execute verified external fulfillment and track supplier credits/costs without making the provider authoritative.

## Story pack

- [PI-01 — Provider account / bindings](pi_01.md)
- [PI-02 — ProviderOperation runtime](pi_02.md)
- [PI-03 — API adapter + Browser adapter](pi_03.md)
- [PI-04 — Evidence & adapter version](pi_04.md)
- [PI-05 — Credit procurement](pi_05.md)
- [PI-06 — Credit consumption ledger](pi_06.md)
- [PI-07 — 45-day provider account rule](pi_07.md)

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
