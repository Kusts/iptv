# Execution Wave 06 — Support, Agent, HITL & Knowledge

> Status: Documentation-ready  
> Version: 0.11  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Outcome

Operate conversations and support safely, escalate uncertainty and turn validated outcomes into reusable knowledge.

## Story pack

- [SA-01 — Conversation runtime](sa_01.md)
- [SA-02 — Support Ticket](sa_02.md)
- [SA-03 — Agent Tool Gateway](sa_03.md)
- [SA-04 — HITL package](sa_04.md)
- [SA-05 — Human takeover / return to AI](sa_05.md)
- [SA-06 — Knowledge candidate loop](sa_06.md)
- [SA-07 — Evals + shadow mode](sa_07.md)

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
