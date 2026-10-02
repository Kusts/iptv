# Implementation Baseline v1.0.1

> Status: **IMPLEMENTED THROUGH WAVE 16 + W0 CINEVISION RUNTIME HARDENING (FASES 0–5)** — migration 046 applied  
> Baseline date: 2026-10-02  
> Delivery record of truth: `CHANGELOG.md` (`## Unreleased`)  
> Scope: consolidation of Modules 1–25 + planning closure + implementation delivery to Wave 16  
> Authority: this directory is the implementation baseline. If an older supporting document conflicts with this baseline, **this baseline wins**.

## Purpose

This baseline converts the product planning into an implementation contract. It freezes the canonical domain vocabulary, architecture, agent harness, security posture, integration strategy, MVP scope, critical path, acceptance criteria and operational gates.

The pilot tenant is the founder's own streaming/subscription operation. It is a normal tenant and must not receive architectural special cases.
The first-value core-sales checkpoint is earlier than the complete MVP-PILOT gate. ADR-0025 records the final authority direction and canonical reconciliation; ADR-0024 is historical/superseded where it promoted old scaffolds into domain rules. Pre-implementation migrations and OpenAPI/AsyncAPI are scaffolds, not proof of a running system.

## Authority order

1. `00-vision/` — product principles.
2. This implementation baseline — final cross-domain decisions and implementation gates.
3. `02-domain/` — detailed domain support documents where not superseded here.
4. `03-architecture/` and accepted ADRs.
5. `04-specs/` — capability detail.
6. `05-contracts/` — executable API/event contracts.
7. `12-roadmap/` — implementation sequencing.
8. Code, tests and evals — implementation truth once they exist.

## Canonical baseline files

- [01-product-and-mvp.md](01-product-and-mvp.md)
- [02-canonical-domain.md](02-canonical-domain.md)
- [03-state-machines.md](03-state-machines.md)
- [04-event-catalog.md](04-event-catalog.md)
- [05-policy-and-configuration.md](05-policy-and-configuration.md)
- [06-capability-and-tool-registry.md](06-capability-and-tool-registry.md)
- [07-architecture-stack.md](07-architecture-stack.md)
- [08-agent-harness.md](08-agent-harness.md)
- [09-security-privacy-governance.md](09-security-privacy-governance.md)
- [10-integrations-certification.md](10-integrations-certification.md)
- [11-partners-resellers.md](11-partners-resellers.md)
- [12-product-ux-ai-experience.md](12-product-ux-ai-experience.md)
- [13-nfr-slo-dr.md](13-nfr-slo-dr.md)
- [14-e2e-acceptance-matrix.md](14-e2e-acceptance-matrix.md)
- [15-definition-of-done.md](15-definition-of-done.md)
- [16-risk-register.md](16-risk-register.md)
- [17-future-capability-registry.md](17-future-capability-registry.md)
- [18-implementation-plan.md](18-implementation-plan.md)
- [19-open-items-and-validation.md](19-open-items-and-validation.md)
- [20-data-model-blueprint.md](20-data-model-blueprint.md)
- [21-api-and-contract-blueprint.md](21-api-and-contract-blueprint.md)
- [22-repository-and-module-boundaries.md](22-repository-and-module-boundaries.md)
- [23-implementation-backlog.md](23-implementation-backlog.md)

## Implementation entry gate

Implementation may start when:

- ADRs marked `ACCEPTED` are loaded by development agents;
- Wave 0 technical spikes are scheduled before dependent production code;
- coding agents load the canonical glossary, domain ownership matrix, state/event catalogs and Agent Harness contract;
- no implementation task bypasses the Command/Policy/Tool pipeline;
- the first vertical slice has reconciled state/event contracts and passing static validation; each later slice repeats this before its Wave exit;
- every task includes acceptance tests and explicit bounded-context ownership.

No remaining planning item blocks beginning Wave 0 with sandbox/synthetic fixtures. Live-operation gates are explicit in `19-open-items-and-validation.md`; an unproven spike cannot certify a later Wave.
