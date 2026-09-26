# Testing Strategy

> Status: Canonical MVP baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Test pyramid adapted to the platform

### Unit/domain

State transitions, policies, arithmetic, eligibility, ranking/scoring helpers.

### Contract

OpenAPI/AsyncAPI/tool schemas, adapter mappings, event/schema compatibility, DB enum/check alignment.

### Integration

Real PostgreSQL, transaction constraints, outbox/inbox, concurrency, ledger, migrations, RLS/isolation where applicable.

### Adapter integration

Asaas sandbox/test account where available; controlled CINEVISION safe/test account; WhatsApp provider test instance. Never run destructive provider cases on real customer records.

### End-to-end vertical slices

Lead→Trial; Offer→Payment→Settlement; Renewal→Entitlements→Provider; Support→HITL; Referral→Reward.

### Agent evals

Offline datasets, prompt injection, tool misuse, hard-fail business rules, shadow mode and regression cases from production failures.

### Failure/reliability

Duplicate events, timeouts, retry after unknown outcome, partial external outage, queue replay, concurrent Trial requests, cross-tenant attempts, restore tests.

## Mandatory negative cases

- second primary Trial blocked;
- fake payment claim does not renew;
- arbitrary discount denied;
- Order net=0 settles without fake Payment;
- recurring screen produces provider cost in every cycle;
- ProviderOperation click success without postcondition is not SUCCEEDED;
- HUMAN_CONTROL blocks AI outbound;
- external knowledge cannot authorize tool action;
- duplicate webhook/event produces one side effect.

## Test data

Use synthetic fixtures by default. Real customer data is not copied to lower environments unless explicitly governed and sanitized.

## Auto-review result

Reviewed to ensure tests cover domain invariants and external-failure behavior, not only happy-path HTTP responses.
