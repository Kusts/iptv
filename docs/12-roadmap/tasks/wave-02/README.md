# Execution Wave 02 — Lead Lifecycle + Trial & Compatibility

> Status: Documentation-ready  
> Version: 0.11  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Outcome

Complete the pre-sale path from a canonical Person through Lead qualification, Trial eligibility, anti-abuse, provider provisioning, technical assessment and legitimate Retrial.

## Story pack

- [CRM-02 — Lead lifecycle](crm_02.md)
- [CRM-03 — Customer promotion/reactivation](crm_03.md)
- [CRM-04 — Customer 360 baseline](crm_04.md)
- [CRM-05 — Identity merge review](crm_05.md)
- [TR-01 — Trial eligibility](tr_01.md)
- [TR-02 — Trial concurrency & anti-abuse](tr_02.md)
- [TR-03 — Trial provisioning](tr_03.md)
- [TR-04 — Technical assessment](tr_04.md)
- [TR-05 — Legitimate Retrial](tr_05.md)
- [TR-06 — Compatibility observations](tr_06.md)

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
