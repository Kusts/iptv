# MVP Implementation Sequence

> Status: Proposed  
> Versão: 1.0  
> Objetivo: reduzir risco integrando vertical slices completos em vez de construir todos os bancos/APIs primeiro.

## 1. Estratégia

Construir em slices executáveis e demonstráveis.

Cada etapa deve terminar com:

```text
working path
+ automated tests
+ telemetry
+ audit
+ failure path
+ docs updated
```

## 2. Fase 0 — Platform skeleton

Entregas:

- repo/workspace;
- tenant context;
- auth baseline;
- PostgreSQL + migrations;
- Kysely/data access baseline se ADR aprovado;
- audit primitives;
- idempotency table;
- domain events/outbox/inbox;
- structured logging/tracing;
- secrets integration;
- feature/kill switches mínimos.

Gate:

- cross-tenant integration tests;
- migration up/down strategy;
- outbox atomicity test.

## 3. Fase 1 — Identity/CRM

Implementar SPEC MVP-01.

Demo:

```text
WhatsApp/web identity
→ resolve Person
→ create Lead
→ retrieve canonical context
```

## 4. Fase 2 — Trial end-to-end

Implementar:

- eligibility;
- anti-abuse baseline;
- provider trial adapter;
- technical assessment;
- conditional follow-up hooks.

Demo:

```text
new lead
→ ALLOW
→ Trial provisioning
→ ACTIVE
→ technical pass

repeat valid lead
→ DENY

provider failure
→ verified RETRIAL path
```

## 5. Fase 3 — Commerce/Billing

Implementar:

- catalog minimum;
- offer resolution;
- Order + price snapshot;
- Asaas payment adapter;
- webhook inbox/dedupe;
- minimal financial ledger;
- settlement.

Demo:

```text
Offer
→ Order
→ Asaas
→ payment webhook
→ ledger
→ Order SETTLED
```

Testar também zero-value order por reward mock/preconfigured credit.

## 6. Fase 4 — Subscription/Entitlements

Implementar:

- Subscription lifecycle;
- Entitlement grants;
- cycle records;
- recurring add-on;
- renewal order creation.

Demo obrigatória da tela adicional:

```text
Cycle 1: base + extra connection
Cycle 2: base + extra connection again
```

com receita e provider COGS em ambos os ciclos.

## 7. Fase 5 — Provider fulfillment robusto

Expandir Browser Worker/API Adapter:

- renew;
- change connections;
- migrate server;
- Trust Renewal +3 dias quando elegível no provider;
- trace/evidence;
- drift/HITL.

## 8. Fase 6 — Support + Agent/HITL

Implementar:

- conversation runtime;
- tool contracts;
- support ticket;
- solution outcome;
- knowledge retrieval baseline;
- human guidance;
- takeover/return-to-AI;
- eval dataset inicial.

## 9. Fase 7 — Referral Core

MVP referral:

- referral link/code;
- attribution;
- qualification after valid conversion;
- anti-abuse;
- simple rewards/credits;
- ask-referral trigger after good moments;
- referral metrics.

Gamificação avançada fica NEXT.

## 10. Fase 8 — Operations hardening

- reconciliation scheduled;
- SLO dashboards;
- alerts;
- backup/restore test;
- provider kill switch;
- agent shadow/eval process;
- privacy/export/delete operational flow;
- baseline case metrics captured.

## 11. Release gate do tenant piloto

Antes de depender operacionalmente do sistema:

- payment replay tested;
- provider retry tested;
- tenant isolation tested;
- restore tested;
- manual fallback documented;
- agent cannot grant arbitrary discount/reward;
- trial abuse baseline active;
- recurring extra connection economics verified;
- core metrics observable.

## 12. O que não antecipar

Evitar antes do core provar valor:

- microservices decomposition;
- sophisticated ML fraud/churn;
- full ads autonomy;
- full social publishing;
- complex gamification;
- data lake;
- multi-provider routing automático;
- large multi-agent orchestration.


## 13. Epics executáveis

A decomposição em Stories vive em [`epics/README.md`](epics/README.md) e a visão consolidada em [`mvp-backlog.md`](mvp-backlog.md).

A sequência permanece a mesma; os Epics não substituem SPECs nem State Machines.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — implementation sequence uses validated Trust Renewal terminology.
