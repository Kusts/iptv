# CRM-05 — Identity merge review

> Status: Ready for implementation planning  
> Version: 0.11  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Outcome

Allow ambiguous identities to be manually reviewed, merged and unmerged with complete audit history.

## Dependencies

Use the dependency graph defined by the Epic and preceding Wave gates.

## Canonical authority

- `docs/02-domain/identity-crm/states.md`
- `docs/04-specs/01-identity-crm/SPEC.md`
- `docs/05-contracts/openapi/openapi.yaml`
- `docs/03-architecture/multi-tenancy.md`

## Implementation tasks

1. Create merge review command.
2. Store merge evidence/confidence.
3. Implement reversible link/mapping rather than destructive delete.
4. Audit merge and unmerge.

## Acceptance criteria

- [ ] Ambiguous match is never auto-merged.
- [ ] Unmerge restores distinct identities without losing history.

## Failure / edge cases

- **merge conflict:** send to review
- **identity already linked elsewhere:** block and surface conflict

## Required tests

- merge/unmerge integration tests
- history preservation test

## Telemetry & audit

- merge review count
- false merge corrections

## Security / privacy

- high-risk action requires authorized role

## Done gate

The Story is complete only when code, automated tests, contract/schema changes (if any), telemetry and documentation all agree. Any newly discovered business rule returns to Planner/Architect before implementation.
