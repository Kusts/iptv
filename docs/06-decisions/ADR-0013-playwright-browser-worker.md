# ADR-0013 — Playwright for Provider Browser Worker

- Status: Accepted
> Review: Auto-reviewed v0.13 — rechecked against stack baseline and current research.
- Data: 2026-09-20

## Context

O provider inicial exige browser para a maioria das operações. Precisamos de sessão, isolamento, tracing, screenshots e verificação pós-condição.

## Decision proposed

Usar Playwright com Chromium/Chrome em Browser Worker isolado.

Preferir browser/context controlado pelo próprio Playwright. `connectOverCDP` fica reservado para cenários que realmente exijam conexão a browser externo/persistente, pois a própria documentação indica menor fidelidade.

## Controls

- origin allowlist;
- profile isolation por tenant/provider account;
- secrets via secret reference;
- no arbitrary navigation tool;
- traces em falha/mutação relevante;
- postcondition checks;
- security challenge → HITL.

## Validation before Accepted

- login/session persistence;
- create/renew test account safely;
- trace capture;
- UI drift simulation;
- worker restart/session recovery.

## Aceitação (2026-09-29)

Aceito pelo operador em 2026-09-29 após dossiê de decisão (explorer MVP-ADR-01).
Complementa o ADR-0008 (Accepted) para o Browser Worker; os secrets do worker seguem via ADR-0014.
