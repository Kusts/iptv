# ADR-0002 — Multi-tenancy desde o primeiro release

- **Status:** Accepted
- **Data:** 2026-09-20

## Context

A primeira operação será própria, mas o objetivo explícito é comercializar o produto para outros usuários após validação.

## Decision

Domínio, autorização, jobs, events, storage, Knowledge e analytics devem nascer tenant-aware.

A implantação inicial pode usar infraestrutura pooled.

## Consequences

### Positivas

- evita migração estrutural single → multi-tenant;
- permite medir cost per tenant desde cedo;
- prepara SaaS Control Plane.

### Custos

- maior disciplina de autorização/testes;
- necessidade de tenant isolation desde MVP.
