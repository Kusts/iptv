# MVP Backlog Matrix

> Status: Proposed  
> Versão: 1.0

## Objetivo

Fornecer uma visão executável dos Epics sem substituir as SPECs.

| Epic | Stories | Dependência principal | Demo/Gate |
|---|---:|---|---|
| EPIC-00 Platform | 5 | — | migrations + tenant isolation + outbox |
| EPIC-01 Identity/CRM | 5 | 00 | identity → Person → Lead/Customer |
| EPIC-02 Trial | 6 | 01 + provider trial adapter | Trial único + Retrial legítimo |
| EPIC-03 Commerce/Billing/Ledger | 7 | 00/01 | Offer → SETTLED + ledger |
| EPIC-04 Subscription/Entitlements | 6 | 03 | 2 ciclos com tela extra recorrente |
| EPIC-05 Provider/Inventory | 7 | 04 | verified fulfillment + credit COGS |
| EPIC-06 Support/Agent/HITL | 7 | 01/02/05 | AI → HITL → candidate knowledge |
| EPIC-07 Referral | 6 | 03/04/06 | referral qualified → reward |
| EPIC-08 Reliability/Pilot | 7 | todos os core epics | pilot release gate |

Total inicial: **56 Stories**. O detalhamento em tasks deve ser criado no momento em que a Story entra em execução, usando a SPEC canônica e evitando backlog prematuro de baixo nível.

## Priorização

P0:

- EPIC-00;
- EPIC-01;
- EPIC-02;
- EPIC-03;
- EPIC-04;
- subset de EPIC-05 necessário a Trial/Renewal.

P1:

- restante do EPIC-05;
- EPIC-06;
- Referral Core do EPIC-07;
- reliability obrigatório do EPIC-08.

P2 pós-core:

- gamificação avançada;
- growth/ads autonomy;
- content automation ampla;
- ML próprio.

## Regra para agentes

Antes de implementar uma Story, o Planner deve carregar:

1. Epic/Story;
2. SPEC correspondente;
3. state machine correspondente;
4. contracts OpenAPI/AsyncAPI afetados;
5. migrations/schema afetados;
6. ADRs relevantes.

Coder não deve alterar regra de domínio para facilitar implementação. Divergência volta ao Planner/Architect e atualiza a documentação canônica primeiro.
