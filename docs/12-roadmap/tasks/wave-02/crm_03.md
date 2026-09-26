# CRM-03 — Customer promotion/reactivation

> Status: Ready for implementation planning  
> Version: 0.11  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Outcome

Create or reactivate a single Customer relationship for a Person without duplicating identity.

## Dependencies

Use the dependency graph defined by the Epic and preceding Wave gates.

## Canonical authority

- `docs/02-domain/identity-crm/states.md`
- `docs/04-specs/01-identity-crm/SPEC.md`
- `docs/05-contracts/openapi/openapi.yaml`
- `docs/03-architecture/multi-tenancy.md`

## Implementation tasks

1. Implement promotion on first commercial activation.
2. Enforce one current Customer relationship record per Person/tenant model.
3. Implement LAPSED/CHURNED → REACTIVATING → ACTIVE flow.
4. Emit activation/reactivation events.

## Acceptance criteria

- [ ] Conversion never creates a second Person.
- [ ] Reactivation keeps historical Customer identity.

## Failure / edge cases

- **concurrent activation:** unique/transactional guard prevents duplicates
- **reactivation fails:** Customer remains CHURNED and failure event is emitted

## Required tests

- concurrent promotion test
- reactivation state tests

## Telemetry & audit

- customer activation metric
- reactivation outcome
- audit

## Security / privacy

- tenant-scoped unique constraints

## Done gate

The Story is complete only when code, automated tests, contract/schema changes (if any), telemetry and documentation all agree. Any newly discovered business rule returns to Planner/Architect before implementation.
