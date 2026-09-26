# ADR-0007 — Ledger antes de saldo

- **Status:** Accepted
- **Data:** 2026-09-20

## Context

O produto precisa explicar dinheiro, provider credits, rewards e referral credits ao longo do tempo.

Balances mutáveis sem histórico dificultam audit, reversão e profitability.

## Decision

Movimentações relevantes serão registradas append-only/versionadas e balances serão derivados/projetados.

Inclui:

- Financial Ledger;
- Provider Credit Ledger;
- Reward/Referral Wallet Ledger.

## Consequences

- auditabilidade;
- reversões explícitas;
- cálculo econômico melhor;
- modelagem financeira mais rigorosa.
