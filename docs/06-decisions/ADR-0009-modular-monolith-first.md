# ADR-0009 — Modular Monolith first

- **Status:** Proposed
- **Data:** 2026-09-20

## Context

O produto possui muitos domínios, mas a equipe inicial é pequena e as regras ainda estão amadurecendo.

Microservices precoces aumentariam deploy, networking, observability e consistency complexity sem benefício comprovado.

## Decision proposta

Implementar Domain Core/API como Modular Monolith com fronteiras de domínio explícitas.

Extrair processos que exigem isolamento operacional desde cedo:

- Browser Worker;
- background/workflow execution;
- potentially ingestion.

Extrair novos serviços apenas com necessidade mensurável.

## Consequences

### Positivas

- velocidade de desenvolvimento;
- transações simples;
- menor custo operacional;
- boundaries ainda testáveis.

### Riscos

- disciplina necessária para evitar “big ball of mud”;
- módulos precisam de ownership/contracts claros.
