# Auto-review Report — v0.6

> Data: 2026-09-20  
> Escopo: novas SPECs do MVP, Agent Tool Contracts/Evals, physical DB baseline, migration strategy e implementation sequence.

## 1. Objetivo da revisão

Verificar se a nova camada implementável introduziu divergências em relação às fontes canônicas já existentes.

Foram revisados:

- PRD;
- Glossary;
- Domain State Machines;
- Event Model;
- Logical Data Model;
- OpenAPI;
- AsyncAPI;
- Architecture/ADRs;
- Data & Analytics;
- Security baseline.

## 2. Validações executadas

### Links internos

Todos os links Markdown locais foram verificados após a criação deste relatório.

### Event Model

Todas as referências `*.v1` presentes nas novas SPECs/Agent docs foram comparadas com `docs/02-domain/event-model.md`.

Resultado esperado final: **0 eventos desconhecidos**.

### OpenAPI

O YAML foi parseado e todas as referências locais `$ref` foram resolvidas.

Resultado:

```text
90 refs verificadas
0 refs quebradas
```

### AsyncAPI

Os canais do contrato foram comparados com o Event Model.

Resultado:

```text
18 canais
18 presentes no Event Model
0 divergências
```

### State machines

Estados usados nas SPECs Trial, Commerce/Payment, Subscription, Entitlements e Provider Fulfillment foram verificados contra suas máquinas canônicas.

Resultado: **0 estados canônicos ausentes**.

## 3. Correções aplicadas durante a revisão

### C1 — Runtime tool status ≠ Domain state

`SUCCEEDED/DENIED/REVIEW_REQUIRED/...` das tools foram explicitamente definidos como estados do **tool runtime**, evitando confusão com `ProviderOperation SUCCEEDED`, `Order SETTLED` ou outros estados de domínio.

### C2 — Additional connection recorrente

A recorrência foi reafirmada em três camadas:

- Commerce/Billing SPEC;
- Subscription/Entitlements SPEC;
- Physical Database Schema.

Cada ciclo ativo precisa tornar observáveis:

```text
recurring sale revenue
+
recurring provider COGS
```

Uma recompensa pode zerar preço ao Customer em um ciclo, mas não deve apagar custo real do provider.

### C3 — Trial technical pass

`PASSED` permanece parte do Technical Assessment e não do Trial Access Lifecycle.

A SPEC permite corretamente:

```text
Trial ACTIVE
+
Technical Assessment PASSED
```

simultaneamente.

### C4 — Order settlement

Todas as novas SPECs preservam:

```text
Order SETTLED != Payment PAID
```

Orders integralmente cobertas por rewards/créditos não exigem Payment fictício.

### C5 — Provider retry

Foi formalizado que timeout não significa necessariamente falha do efeito externo.

Antes de retry de ação potencialmente duplicável:

```text
observe external state
→ verify postcondition
→ retry only if still needed
```

### C6 — Tool autonomy

O Agent Tool Contract impede que o modelo:

- invente preço/desconto/reward;
- reinterprete Trial `DENY`;
- confirme pagamento por mensagem do usuário;
- acesse selectors/credentials do Browser Worker;
- ignore HITL/policy/risk.

## 4. Consistência arquitetural

As SPECs seguem a hierarquia:

```text
PRD
↓
Domain Rules / State Machines
↓
Architecture
↓
SPEC
↓
Executable Contracts
↓
Implementation
```

Nenhuma SPEC foi tratada como nova fonte canônica de estados/eventos.

## 5. Multi-tenancy

Todas as novas capacidades mutantes exigem tenant context derivado da autenticação/runtime.

Gates explícitos adicionados para:

- identity resolution;
- provider account usage;
- reconciliation repair;
- tool execution;
- database foreign keys/constraints.

## 6. Reliability

O baseline implementável agora inclui:

- idempotency;
- outbox;
- inbox/deduplication;
- retries/backoff;
- reconciliation;
- provider postcondition verification;
- correlation/causation;
- append-only ledgers;
- audit.

## 7. Agent safety/evals

O Eval Plan inclui hard-fail conditions que não podem ser compensadas por média alta em outros scores.

Exemplos:

- trial indevido;
- pagamento inventado;
- desconto inventado;
- cross-tenant access;
- secret leakage;
- HITL bypass;
- RAG instruction injection.

## 8. Physical data design

O physical schema baseline continua **Proposed**, não migration final.

Pontos explicitamente deixados para spike/implementação:

- UUID strategy final;
- RLS implementation detail;
- PostgreSQL enum vs text/check por categoria;
- exact ledger balance enforcement mechanism;
- migration runner/tool.

Isso evita transformar decisões ainda abertas em contrato prematuro.

## 9. Itens deliberadamente não resolvidos nesta versão

- schema SQL completo;
- migration files reais;
- Support/HITL/Knowledge SPECs detalhadas;
- Referral Core SPEC detalhada;
- production SLO numeric thresholds;
- final Auth provider;
- promoção de ADRs técnicos Proposed para Accepted.

## 10. Resultado

A versão v0.6 está consistente para avançar para implementação planejada/migrations iniciais.

Não foram identificadas regressões conceituais em:

- Trial único;
- Retrial;
- recurring additional connections;
- Commerce/Entitlements/Fulfillment separation;
- Payment vs Settlement;
- Provider postcondition verification;
- tenant isolation.
