# MVP Epics — Implementation Backlog

> Status: Proposed  
> Versão: 1.0  
> Data: 2026-09-20  
> Review: Auto-reviewed v0.12 — checked for execution governance and authority order.

## Objetivo

Traduzir PRD + SPECs + migrations em unidades de implementação que os agentes possam executar e revisar sem reinterpretar o produto.

## Regra de autoridade

Epics/Stories **não redefinem** regras de domínio. Em conflito, prevalecem:

```text
Domain / State Machine
→ SPEC
→ Contract
→ Epic / Story / Task
```

## Definition of Done de toda Story

Uma Story só termina com:

- código implementado;
- testes automatizados;
- tenant isolation test quando tocar data plane;
- telemetria/audit quando aplicável;
- happy path + failure path;
- contrato/documentação atualizados se houve mudança;
- sem TODO crítico oculto.

## Epics

1. [EPIC-00 — Platform Foundation](EPIC-00-platform-foundation.md)
2. [EPIC-01 — Identity & CRM](EPIC-01-identity-crm.md)
3. [EPIC-02 — Trial & Compatibility](EPIC-02-trial.md)
4. [EPIC-03 — Commerce, Billing & Ledger](EPIC-03-commerce-billing-ledger.md)
5. [EPIC-04 — Subscription & Entitlements](EPIC-04-subscription-entitlements.md)
6. [EPIC-05 — Provider Fulfillment & Inventory](EPIC-05-provider-inventory.md)
7. [EPIC-06 — Support, Agent, HITL & Knowledge](EPIC-06-support-agent-hitl-knowledge.md)
8. [EPIC-07 — Referral Core](EPIC-07-referral-core.md)
9. [EPIC-08 — Reliability & Pilot Readiness](EPIC-08-reliability-pilot.md)

## Sequência

A sequência padrão é 00 → 08. Dependências específicas dentro das Stories podem permitir paralelismo controlado, mas nenhum agente deve antecipar uma Story se isso exigir inventar contrato ou regra ausente.

## Execution governance

- [`../definition-of-ready-done.md`](../definition-of-ready-done.md) — Definition of Ready/Done.
- [`../task-template.md`](../task-template.md) — canonical task template.
- [`../../00-meta/development-agent-handbook.md`](../../00-meta/development-agent-handbook.md) — implementation-agent behavior and conflict protocol.
