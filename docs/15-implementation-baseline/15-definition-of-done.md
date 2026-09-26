# Global Definition of Done

A feature is not done because a screen renders or an endpoint returns 200.

## Feature DoD

A production-capable feature must include, as applicable:

1. owning bounded context and canonical terminology;
2. domain/application rule implementation;
3. command/query contracts and validation;
4. permissions + policy behavior;
5. persistence/migration and tenant scoping;
6. events/outbox/inbox implications;
7. API contract/OpenAPI;
8. frontend state including loading/empty/error/recovery;
9. audit/observability/correlation;
10. unit/integration/E2E tests;
11. documentation updated in canonical location;
12. no unresolved contradiction with state/event/policy/capability catalogs.

## Agent-enabled feature additional DoD

- semantic capability/tool schema;
- tool description and failure taxonomy;
- authorization/policy outside model instructions;
- eval fixtures including misuse/failure cases;
- context requirements/minimization;
- HITL path if applicable;
- model fallback/degradation behavior;
- manual UI equivalent for relevant operations.

## Integration feature additional DoD

- authentication/session behavior;
- happy + invalid path;
- idempotency;
- timeout and unknown-effect behavior;
- retry/reconciliation;
- restart/recovery;
- upgrade/canary strategy;
- capability certification and known limitations.

## Documentation DoD

Every changed/new canonical document receives:

- semantic self-review;
- cross-file terminology/state/event review;
- broken-link/structure checks;
- stale-decision scan;
- correction before release.

## MVP-PILOT gate

The pilot may be declared ready only after core integration certifications, critical Agent evals, E2E Golden Loop/renewal/recovery journeys, tenant isolation, backup restore and manual fallback are passing.
The first-value checkpoint is evidence for the core sales loop, not an alternate MVP-PILOT DoD. Tenant Copilot G18, growth/reseller requirements and all other items in `01-product-and-mvp.md` still apply at this gate.

## MVP-SAAS gate

Adds validated external onboarding, platform control plane/billing, usage metering, final pricing/brand, data lifecycle, support/docs and successful assisted external-tenant beta.
