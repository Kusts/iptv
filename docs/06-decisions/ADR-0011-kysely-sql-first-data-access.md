# ADR-0011 — Kysely / SQL-first Data Access

- Status: Proposed
> Review: Auto-reviewed v0.13 — rechecked against stack baseline and current research.
- Data: 2026-09-20

## Context

O produto terá ledgers, reconciliações, analytics operacionais e queries relacionais complexas. Precisamos de type safety sem esconder SQL nem acoplar o domínio a um ORM pesado.

## Decision proposed

Usar Kysely como query builder TypeScript tipado e migrations SQL explícitas/reviewable.

SQL direto continua permitido para queries especiais.

## Consequences

### Positive

- queries previsíveis;
- bom fit para PostgreSQL;
- type safety;
- baixo nível de magic;
- legível para humanos e agentes.

### Negative

- mais responsabilidade de modelagem SQL;
- menos abstrações automáticas de relacionamento que ORMs completos;
- migrations exigem disciplina própria.

## Validation before Accepted

- implementar Order + Payment + Ledger em spike;
- testar transaction boundaries;
- testar migrations expand/contract;
- avaliar codegen/schema workflow.
