# CRM-04 — Customer 360 baseline

> Status: Ready for implementation planning  
> Version: 0.11  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Outcome

Expose a tenant-scoped projection combining identity, lead, customer and Trial summary without inventing a global customer status.

## Dependencies

Use the dependency graph defined by the Epic and preceding Wave gates.

## Canonical authority

- `docs/02-domain/identity-crm/states.md`
- `docs/04-specs/01-identity-crm/SPEC.md`
- `docs/05-contracts/openapi/openapi.yaml`
- `docs/03-architecture/multi-tenancy.md`

## Implementation tasks

1. Build read model/query service.
2. Return only authorized sections.
3. Add pagination/history bounds where needed.
4. Keep projection rebuildable from authoritative tables.

## Acceptance criteria

- [ ] Projection shows orthogonal states separately.
- [ ] No secrets/provider credentials are returned.

## Failure / edge cases

- **partial subsystem unavailable:** return partial/typed unavailable section when policy permits
- **cross-tenant request:** 404/403 without existence leak

## Required tests

- projection contract test
- privacy field test
- cross-tenant test

## Telemetry & audit

- query latency
- partial projection counter

## Security / privacy

- field-level privacy
- least data response

## Done gate

The Story is complete only when code, automated tests, contract/schema changes (if any), telemetry and documentation all agree. Any newly discovered business rule returns to Planner/Architect before implementation.
