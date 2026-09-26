# Execution Wave 07 — Referral Core

> Status: Documentation-ready  
> Version: 0.11  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Outcome

Turn referrals into a measurable acquisition/retention loop with anti-abuse and economically accounted rewards.

## Story pack

- [RF-01 — Referral identity / code](rf_01.md)
- [RF-02 — Qualification](rf_02.md)
- [RF-03 — Referral anti-abuse](rf_03.md)
- [RF-04 — Reward issuance](rf_04.md)
- [RF-05 — Referral-triggered renewal](rf_05.md)
- [RF-06 — Ask-referral triggers](rf_06.md)

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
