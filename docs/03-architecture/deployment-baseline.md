# Deployment & Environment Baseline

> Status: Proposed MVP baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Environments

```text
local
CI ephemeral
staging
production
```

No production credentials in local/CI fixtures.

## Deployment units

Baseline architecture can deploy independently where justified:

- Web/Control Center;
- API/domain application;
- async worker/workflow runtime;
- Browser Worker;
- PostgreSQL;
- object storage;
- observability services.

This does not imply microservices for every domain.

## Release order

For schema changes use expand → deploy compatible code → backfill/reconcile → contract → cleanup. Migrations are append-only artifacts and run under controlled release permissions.

## Configuration

Validated environment schema at boot. Secrets come from secret manager; non-secret tenant configuration comes from platform configuration tables/services.

## Rollout

Use feature flags/kill switches for risky capabilities. Agent releases and provider adapter revisions may use staged tenant rollout.

## Rollback

Application rollback must remain compatible with already-applied migrations. Destructive schema rollback is not the default recovery mechanism; use forward fixes and restore only under documented DR conditions.

## CI/CD required gates

```text
lint/typecheck
unit tests
contract tests
PostgreSQL migration/integration tests
docs validator
security/static checks
build
staging smoke/e2e
```

## Auto-review result

Reviewed to preserve Modular Monolith-first flexibility while isolating browser/external-risk workloads and protecting database migration safety.
