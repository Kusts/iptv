# CI/CD & Quality Gates

> Status: Canonical delivery baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked against migration, contract, security, eval and release-management requirements.

## Pull request gates

Required for affected code:

1. formatting/lint/typecheck;
2. unit tests;
3. contract/static validators;
4. OpenAPI/AsyncAPI consistency;
5. migration static checks;
6. tenant-isolation/security tests for changed access paths;
7. targeted integration tests;
8. agent eval subset when prompts/tools/policies/retrieval change;
9. dependency/secrets scan;
10. independent review for high-risk domains.

## Database gate

Any migration must run against a disposable PostgreSQL database from zero plus prior snapshot/upgrade path where relevant. Tests must verify constraints, idempotency and rollback/forward-fix strategy.

## Release gates

Before production:

```text
build reproducible
→ migrations validated
→ smoke tests green
→ feature flags safe
→ observability dashboards/alerts present
→ rollback/disable path confirmed
→ release notes generated
```

High-risk features use shadow/canary/progressive rollout.

## Agent release gate

Prompt/model/tool/policy changes require the eval plan and pinned release metadata. No “prompt hotfix” directly in production without versioning.

## Emergency change

Emergency fixes may shorten normal review only when incident severity requires it, but must preserve audit, post-incident review and follow-up tests/documentation.

## Auto-review result

Reviewed to make automated gates enforce the documented authority model rather than relying on reviewer memory.
