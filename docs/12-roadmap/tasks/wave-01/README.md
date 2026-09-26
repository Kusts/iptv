# Execution Wave 01 — Platform Foundation + Canonical Identity

> Status: Ready for implementation planning  
> Version: 0.10  
> Scope: PF-01…PF-05 + CRM-01

## Outcome

Deliver the smallest production-shaped platform baseline capable of resolving a tenant-scoped Person safely, persisting events reliably and running the full migration/fixture/test gate.

This wave intentionally stops before Lead lifecycle and Trial eligibility implementation. It establishes the runtime contracts those slices depend on.

## Story order

1. PF-01 — Workspace bootstrap
2. PF-02 — Tenant context & authorization baseline
3. PF-03 — Migration/runtime fixture gate
4. PF-04 — Idempotency / Inbox / Outbox
5. PF-05 — Secrets + kill switches
6. CRM-01 — Deterministic Person/Identity resolution

PF-02/03 may proceed in parallel after PF-01 when ownership is explicit. PF-04 depends on the DB runtime. CRM-01 depends on PF-02/03/04 foundations.

## Canonical authority

Before implementation, Planner must load:

- `docs/00-vision/principles.md`;
- `docs/02-domain/identity-crm/states.md`;
- `docs/04-specs/01-identity-crm/SPEC.md`;
- `docs/03-architecture/multi-tenancy.md`;
- `docs/03-architecture/event-architecture.md`;
- `docs/05-contracts/openapi/openapi.yaml`;
- `docs/05-contracts/asyncapi/asyncapi.yaml`;
- migrations `001–011`;
- ADR-0001/0002/0003/0006 and relevant Proposed technology ADRs.

Task files never override those sources.

## Wave acceptance gate

- applications boot with validated environment config;
- tenant context is derived from authenticated membership, never request body;
- migrations `001–011` apply in a disposable PostgreSQL database;
- synthetic pilot seed applies twice without duplicate-domain effects;
- cross-tenant integration tests are green;
- idempotency/inbox/outbox behaviors are proven;
- high-risk outbound capabilities can be disabled per tenant without deploy;
- deterministic identity resolution passes exact-match and ambiguity scenarios;
- static docs/contracts tests remain green.

## Required commands

```bash
python scripts/validate_docs.py
python tests/contracts/test_contracts.py
python tests/contracts/test_seed_contract.py
DATABASE_URL=... ./scripts/run_pg_fixture_tests.sh
```
