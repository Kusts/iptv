# ADR-0006 — Eventos versionados + Outbox + Idempotência

- **Status:** Accepted
- **Data:** 2026-09-20

## Context

Payment, fulfillment, messaging, reward e workflows atravessam systems que podem falhar ou redeliver eventos.

## Decision

- eventos de domínio versionados;
- Transactional Outbox para mudanças críticas DB + publish;
- Integration Inbox/dedup para inputs externos;
- consumers idempotentes;
- business idempotency keys para side effects.

Não assumir exactly-once transport.

## Consequences

- maior confiabilidade;
- replay seguro;
- mais infraestrutura/metadata de processamento.
