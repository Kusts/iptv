# Documentation Change Protocol

> Status: Canonical documentation governance  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked for authority, traceability, compatibility and agent usability.

## Purpose

Keep documentation synchronized with the implemented system while preventing lower-level artifacts from silently redefining product/domain behavior.

## When a change is required

| Change | Canonical update |
|---|---|
| product objective/scope | PRD/scope/journey |
| business rule/state | Domain + SPEC |
| API/event/tool behavior | Contract + relevant SPEC |
| architecture choice | ADR + architecture docs |
| database shape | schema/migration docs + migration |
| metric meaning | Metric Catalog + tracking/consumers |
| operating procedure | Runbook/operations |
| Story execution detail | Task pack only |

## Change order

```text
canonical meaning
→ dependent contract
→ schema/migration if needed
→ tasks/tests
→ code
```

Emergency production fixes may temporarily invert this order only when necessary to restore service; canonical docs must be reconciled immediately afterward.

## Compatibility review

Every semantic change must answer:

- is this backward compatible?
- does it require event/API versioning?
- does historical data retain its old meaning?
- is migration/backfill needed?
- do analytics/metrics change?
- do evals/tool contracts change?

## Auto-review requirement

Any new/modified canonical document must include review status and pass automated + semantic cross-review before snapshot release.

## Auto-review result

Reviewed to make documentation evolution deterministic and prevent code-first drift from becoming the new undocumented authority.
