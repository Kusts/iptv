# Definition of Ready & Definition of Done

> Status: Canonical execution baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked against documentation authority, tests, operations and release gates.

## Definition of Ready — Story

A Story is ready when:

- business outcome is clear;
- canonical Domain/SPEC authority exists;
- states/events/contracts are known or explicitly not applicable;
- unresolved external facts are marked, not guessed;
- dependencies are identified;
- acceptance/failure cases exist;
- security/tenant/privacy implications considered;
- required observability/audit identified.

## Definition of Done — Implementation

Done means:

- code follows module/authority boundaries;
- acceptance criteria pass;
- unit/contract/integration/eval tests required by change pass;
- migration/runtime implications validated;
- events/contracts/docs updated when meaning changed;
- tenant isolation/RBAC/policy tests pass;
- logs/traces/metrics avoid secrets/PII leakage;
- rollback/kill-switch path exists for risky capability;
- independent review complete;
- known limitations recorded.

A feature is not Done because “the happy path works on my machine.”

## Auto-review result

Reviewed to ensure execution quality is derived from the documented system, not agent confidence.
