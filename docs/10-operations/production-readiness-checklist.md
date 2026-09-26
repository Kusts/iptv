# Production Readiness Checklist

> Status: Canonical release gate baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked against security, reliability, tests, observability and operations.

## Product/domain

- canonical docs approved for the released slice;
- unresolved external facts do not have guessed implementation;
- acceptance criteria and failure behavior validated.

## Data

- migrations executed from clean + upgrade path;
- backup/restore strategy tested for environment;
- tenant isolation tests pass;
- seed/test data absent from production unless explicitly safe/configured.

## Security/privacy

- secrets provisioned through approved manager;
- RBAC/policy/risk gates validated;
- logging/tracing redaction checked;
- webhook auth verified;
- privacy/retention settings configured.

## Reliability

- idempotency/retry/reconciliation tested;
- dependency degradation behavior tested;
- kill switches verified;
- queues/outbox monitored;
- runbooks linked from alerts.

## Agent

- release pinned;
- eval gates passed;
- tool permissions verified;
- HITL path tested;
- outbound/autonomy flags intentionally enabled, not inherited accidentally.

## Operations

- dashboards/alerts enabled;
- on-call/owner established;
- release rollback/disable path proven;
- incident and provider escalation contacts/process known.

## Auto-review result

Reviewed as a gate checklist; it does not replace domain acceptance tests or infrastructure-specific launch procedure.
