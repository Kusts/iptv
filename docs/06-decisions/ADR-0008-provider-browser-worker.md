# ADR-0008 — Browser automation isolada atrás do Provider Adapter

- **Status:** Accepted
- **Data:** 2026-09-20

## Context

Grande parte das operações CINEVISION exige navegador autenticado e a UI pode mudar.

Não queremos selectors/browser logic espalhados pelo produto.

## Decision

Operações não cobertas por API autorizada serão executadas por Browser Worker isolado atrás de `IPTVProvider`/Provider Adapter.

O Worker deve:

- usar sessão autorizada;
- validar postcondition;
- produzir trace/evidence;
- detectar drift;
- escalar CAPTCHA/2FA/challenge para HITL.

## Consequences

- isolamento de falha;
- adaptação de UI centralizada;
- custo operacional de browser pool;
- necessidade de manutenção do adapter.
