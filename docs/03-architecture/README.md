# Architecture Index

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20  
> Review: Auto-reviewed v0.13 — checked for architecture index completeness and authority boundaries.

## Documentos

- [`overview.md`](overview.md) — estilo arquitetural e visão de alto nível.
- [`system-context.md`](system-context.md) — C4 System Context.
- [`containers.md`](containers.md) — C4 Container Architecture.
- [`data-architecture.md`](data-architecture.md) — armazenamento, tenant isolation, ledgers e outbox/inbox.
- [`event-architecture.md`](event-architecture.md) — commands, events, durable workflows, retries e reconciliation.
- [`multi-tenancy.md`](multi-tenancy.md) — isolamento e metering.
- [`security.md`](security.md) — baseline de segurança e fronteiras de autorização.

## Regra

Architecture descreve **como o sistema é organizado**. Regras de negócio continuam em `docs/02-domain/`; decisões arquiteturais significativas são justificadas em `docs/06-decisions/`.

## Technology & logical design

- [`technology-decision-matrix.md`](technology-decision-matrix.md) — shortlist, critérios e recomendações técnicas.
- [`logical-data-model.md`](logical-data-model.md) — tabelas, constraints e índices lógicos iniciais.

## Physical Data Design

- [`physical-database-schema.md`](physical-database-schema.md) — baseline físico PostgreSQL, tenant FKs, constraints, ledgers e índices.
- [`migration-strategy.md`](migration-strategy.md) — estratégia segura de migrations e backfills.

## Migrations implementáveis

- [`migrations/mvp-bootstrap-v0.7.md`](migrations/mvp-bootstrap-v0.7.md) — primeiro batch de migrations SQL reais (Platform → Identity/CRM → Trial).

- [`migrations/mvp-operations-learning-v0.9.md`](migrations/mvp-operations-learning-v0.9.md) — batch Communications/Support/HITL/Knowledge/Referral/Rewards e test gates.

## Implementation conventions

- [`application-conventions.md`](application-conventions.md) — module/application/domain implementation rules.
- [`repository-module-boundaries.md`](repository-module-boundaries.md) — repository ownership and forbidden coupling.
- [`api-error-conventions.md`](api-error-conventions.md) — stable API/error semantics and retryability.
- [`event-contract-conventions.md`](event-contract-conventions.md) — event envelopes, versioning, idempotent consumers and replay rules.
- [`feature-flags-configuration.md`](feature-flags-configuration.md) — kill switches, release flags and runtime configuration boundaries.

- [`stack-baseline.md`](stack-baseline.md) — stack padrão proposto/aceito para implementação.
