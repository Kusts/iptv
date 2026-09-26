# AI Revenue & Operations Platform — Implementation Documentation v1.0

> Status: **PLANNING BASELINE — WAVE 0 READY; LATER WAVES CERTIFICATION-GATED**  
> Date: 2026-09-26  
> Scope: Modules 1–25 + planning closure + implementation gates  
> Review: the original v1.0 self-review is historical; state/event reconciliation and implementation gates were updated in ADR-0024.

## Start here

1. [`docs/15-implementation-baseline/README.md`](docs/15-implementation-baseline/README.md) — final authority map.
2. [`docs/15-implementation-baseline/18-implementation-plan.md`](docs/15-implementation-baseline/18-implementation-plan.md) — Wave 0 → MVP-SAAS execution order.
3. [`docs/15-implementation-baseline/15-definition-of-done.md`](docs/15-implementation-baseline/15-definition-of-done.md) — mandatory completion criteria.
4. [`docs/00-meta/development-agent-handbook.md`](docs/00-meta/development-agent-handbook.md) — development-agent behavior.
5. [`docs/06-decisions/ADR-0024-state-event-contract-reconciliation.md`](docs/06-decisions/ADR-0024-state-event-contract-reconciliation.md) — contract reconciliation decision.

## Authority hierarchy

Vision/Principles → v1.0 Implementation Baseline → Domain → Architecture/Accepted ADRs → SPECs → Contracts → Roadmap/Tasks → Code/Tests/Evals → Runbooks/User Docs.

The v1.0 implementation baseline supersedes conflicting pre-v1.0 planning text. Older detail files remain supporting material only where they do not conflict with the baseline.
This repository contains planning, draft migrations/contracts and static checks, not a running application. PostgreSQL runtime and live integration gates remain pending; a green static check is not runtime certification.

Current static checks: `python scripts/validate_docs.py`, `python tests/contracts/test_contracts.py`, and `python tests/contracts/test_seed_contract.py`. `scripts/validate_doc_reviews.py` checks historical v0.14 review markers on a fixed file list; it is not the current v1.0 contract/readiness gate and must not be made green by adding review claims to files that were not reviewed in v0.14.

## Key final decisions

- multi-tenant modular monolith, ports/adapters, PostgreSQL source of truth;
- Next.js + NestJS/Fastify + Kysely;
- Neon São Paulo recommended pilot PostgreSQL deployment;
- Hatchet durable workflows subject to Wave 0 certification, with Inngest as fallback candidate;
- WAHA messaging gateway, GOWS preferred subject to certification;
- CINEVISION and MK private operations through authenticated isolated Playwright workers;
- Asaas official Sandbox → production canary;
- OpenAI Agents SDK TypeScript as harness inside an owned Agent Runtime;
- automation-first operation with capability-scoped safety/degradation and human exception handling;
- hierarchical reseller network: ancestor visibility, direct-child management only; resellers may become SaaS tenants and later SaaS resellers;
- SaaS pricing/package determined from real pilot cost/value telemetry.
- first-value checkpoint after the core sales loop, separate from full MVP-PILOT readiness; live milestones have operation-specific gates.

## Repository areas

- `00-vision` — product principles;
- `01-product` — PRD/journeys/scope;
- `02-domain` — detailed domain support documents;
- `03-architecture` — technical architecture;
- `04-specs` — capability specifications (now includes Modules 20–25);
- `05-contracts` — OpenAPI/AsyncAPI contracts;
- `06-decisions` — ADRs;
- `07-agent` — agent runtime supporting docs;
- `08-data-analytics` — metrics/tracking/experimentation;
- `09-security-compliance` — supporting security/privacy docs;
- `10-operations` — runbooks/operations;
- `11-research` — non-authoritative research;
- `12-roadmap` — plans/tasks;
- `13-product-design` — design system/screen specs;
- `14-user-docs` — user/admin docs;
- `15-implementation-baseline` — **canonical v1.0 implementation contract**.
