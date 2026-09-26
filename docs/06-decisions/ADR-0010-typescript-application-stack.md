# ADR-0010 — TypeScript-first Application Stack

- Status: Proposed
> Review: Auto-reviewed v0.13 — rechecked against stack baseline and current research.
- Data: 2026-09-20

## Context

O produto possui Control Center, API modular, workers, AI runtime, contracts e Browser Worker. Um stack principal único reduz troca de contexto e melhora reutilização de contracts/tipos, especialmente em desenvolvimento assistido por agentes.

## Decision proposed

Adotar como baseline:

- TypeScript como linguagem principal;
- Next.js App Router no Control Center;
- NestJS sobre Fastify na API/Domain Core;
- workers TypeScript no mesmo monorepo.

Python permanece permitido em workloads especializados quando houver vantagem concreta.

## Consequences

### Positive

- shared types/contracts;
- estrutura modular clara para agentes;
- ecossistema forte para IA/browser/integrations;
- menos linguagens no MVP.

### Negative

- NestJS adiciona abstração/boilerplate;
- workloads científicos/mídia podem exigir Python;
- é necessário impedir que decorators/controllers absorvam lógica de domínio.

## Validation before Accepted

- spike de um módulo vertical completo;
- OpenAPI generated/validated;
- worker compartilhando domain package;
- medir ergonomia para Planner/Coder/Reviewer.
