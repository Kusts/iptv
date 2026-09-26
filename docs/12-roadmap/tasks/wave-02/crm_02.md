# CRM-02 — Lead lifecycle

> Status: Ready for implementation planning  
> Version: 0.11  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Outcome

Persist and enforce the canonical Lead lifecycle without turning Trial or Payment into Lead states.

## Dependencies

Use the dependency graph defined by the Epic and preceding Wave gates.

## Canonical authority

- `docs/02-domain/identity-crm/states.md`
- `docs/04-specs/01-identity-crm/SPEC.md`
- `docs/05-contracts/openapi/openapi.yaml`
- `docs/03-architecture/multi-tenancy.md`

## Implementation tasks

1. Implement Lead repository/service with canonical transition guard.
2. Preserve acquisition attribution snapshot at Lead creation.
3. Emit canonical Lead events through Outbox.
4. Implement structured reason for LOST/DISQUALIFIED.
5. Add reopen/nurture paths without overwriting history.

## Acceptance criteria

- [ ] Only canonical transitions succeed.
- [ ] Payment failure does not automatically mark Lead LOST.
- [ ] Reopened Lead preserves prior history.

## Failure / edge cases

- **invalid transition:** return domain conflict; do not mutate state
- **duplicate command:** same idempotent effect
- **cross-tenant id:** deny before lookup result leaks

## Required tests

- state transition unit tests
- outbox atomicity integration test
- cross-tenant API test

## Telemetry & audit

- lead transition latency
- transition rejected counter
- audit actor/tenant/correlation

## Security / privacy

- tenant context from membership
- no PII in event payload beyond contract

## Done gate

The Story is complete only when code, automated tests, contract/schema changes (if any), telemetry and documentation all agree. Any newly discovered business rule returns to Planner/Architect before implementation.
