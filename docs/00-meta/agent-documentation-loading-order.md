# Development Agent Documentation Loading Order — v1.0

Development/coding agents must load context in this order:

1. `docs/00-vision/principles.md`
2. `docs/15-implementation-baseline/README.md`
3. `02-canonical-domain.md`, `03-state-machines.md`, `04-event-catalog.md`
4. `05-policy-and-configuration.md`, `06-capability-and-tool-registry.md`
5. `07-architecture-stack.md`, `08-agent-harness.md`, `09-security-privacy-governance.md`
6. relevant bounded-context SPEC(s)
7. relevant accepted ADR(s)
8. OpenAPI/AsyncAPI/contracts
9. current wave/task + acceptance criteria
10. relevant runbooks/evals/tests.

If a supporting pre-v1.0 document conflicts with the implementation baseline, stop using the conflicting statement and follow the baseline. Do not silently combine contradictory state names/rules.
