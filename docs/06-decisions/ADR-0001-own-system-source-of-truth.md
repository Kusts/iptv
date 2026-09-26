# ADR-0001 — Sistema próprio como fonte da verdade

- **Status:** Accepted
- **Data:** 2026-09-20

## Context

CINEVISION, Asaas, WhatsApp e Ads possuem dados úteis, porém a plataforma será um produto independente e multi-provider.

Depender de um provider externo como backend central criaria lock-in e inconsistência operacional.

## Decision

Backend + database próprios serão a fonte autoritativa dos estados de negócio.

External systems são execução/observação e são reconciliados.

## Consequences

### Positivas

- independência de provider;
- Customer 360 real;
- analytics completos;
- provider switching futuro;
- melhor auditabilidade.

### Custos

- necessidade de sync/reconciliation;
- mais responsabilidade por modelagem;
- necessidade de adapters robustos.
