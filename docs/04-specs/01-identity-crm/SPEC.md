# SPEC — Identity & CRM Core

> Status: Supporting detail — reconciled under v1.0 implementation baseline
> Versão: 1.0  
> Slice: MVP-01  
> Dependências: Tenant/Auth context  
> Próximos slices: Trial, Commerce, Communications

## 1. Objetivo

Criar uma identidade canônica de pessoa e um lifecycle comercial desacoplado de canais, para que WhatsApp, landing page, pagamento e futuros canais apontem para a mesma `Person` sempre que houver evidência suficiente.

## 2. Não objetivos

- fuzzy identity matching autônomo de alto risco;
- deduplicação probabilística complexa;
- enriquecimento externo de dados pessoais;
- Customer 360 completo nesta primeira entrega.

## 3. Entidades

Mínimo do slice:

- `persons`;
- `identities`;
- `identity_merge_reviews`;
- `leads`;
- `customers`;
- `audit_log`;
- `domain_events` / `outbox_messages`;
- `idempotency_keys`.

## 4. Regras canônicas

- `Person` representa a pessoa, não um canal.
- Uma `Person` pode possuir múltiplas `Identity`.
- Identity externa precisa de `(tenant_id, provider/type, external_identifier)` único quando aplicável.
- Merge ambíguo não é automático: cria `identity_merge_review`.
- Unmerge deve ser possível e auditado.
- `Lead` lifecycle e `Customer` lifecycle são máquinas separadas.
- `AT_RISK` é classificação, não estado de Customer.

Estados de Lead canônicos:

```text
NEW
CONTACTED
QUALIFIED
ENGAGED
OFFERED
CONVERTED
NURTURE
LOST
DISQUALIFIED
```

Estados de Customer canônicos:

```text
ACTIVE
LAPSED
CHURNED
REACTIVATING
```

## 5. Command principal — CreateOrResolvePerson

### Entrada

- channel/type;
- external identifier;
- display data opcional;
- contact data normalizada quando disponível;
- correlation ID;
- idempotency key quando origem permitir.

### Algoritmo

```text
normalize identity
↓
lookup exact tenant-scoped identity
├─ found → return linked Person
└─ not found
   ↓
   inspect deterministic safe keys
   ├─ unambiguous match → link identity
   ├─ ambiguous → create merge review
   └─ no match → create Person + Identity
```

Nenhum match probabilístico deve fundir pessoas sem review no MVP.

## 6. API

Contrato atual:

```text
POST /v1/persons
GET  /v1/persons/{personId}
```

`POST /v1/persons` deve ser semanticamente idempotente para a mesma identity normalizada.

## 7. Eventos

Produzidos conforme o caso:

```text
person.created.v1
identity.created.v1
identity.verified.v1
identity.linked.v1
identity.merge_review_requested.v1
identity.detached.v1
lead.created.v1
customer.created.v1
```

## 8. Transação

Criação inicial deve persistir em uma transação:

```text
Person
+ Identity
+ Lead quando aplicável
+ Domain Event(s)
+ Outbox
```

A resposta HTTP não depende da publicação externa do evento; depende da persistência consistente local.

## 9. Tenant isolation

Obrigatório testar:

- mesmo número/identifier pode existir em tenants diferentes;
- nenhuma busca por `person_id` pode omitir `tenant_id` no enforcement;
- merge nunca cruza tenant;
- audit records preservam tenant context.

## 10. PII e privacidade

- identificadores sensíveis não devem ser incluídos integralmente em logs;
- normalização não elimina o valor original quando necessário para comunicação, mas armazenamento deve respeitar classificação definida;
- eventos usam IDs, não payload completo de contato, salvo necessidade explícita.

## 11. Falhas

### Duplicate race

Duas mensagens simultâneas tentam criar a mesma identity.

Controle:

- unique constraint tenant-scoped;
- uma transação vence;
- a outra resolve a entidade existente.

### Ambiguous identity

Não mesclar automaticamente. Retornar Person segura apenas quando houver regra determinística; caso contrário abrir review.

## 12. Observabilidade

Mínimo:

- count `person_resolved_existing`;
- count `person_created`;
- count `identity_merge_review_requested`;
- duplicate constraint conflicts;
- latency por command;
- correlation_id em trace/audit.

## 13. Critérios de aceitação

- CA-01: mesma identity exata no mesmo tenant resolve para a mesma Person.
- CA-02: mesma identity em tenants diferentes não colide.
- CA-03: criação concorrente não gera duas identities canônicas iguais.
- CA-04: match ambíguo não faz merge automático.
- CA-05: merge/unmerge fica auditável.
- CA-06: eventos relevantes entram em outbox na mesma transação do estado.
- CA-07: nenhum endpoint aceita `tenant_id` do body como autoridade.

## 14. Testes mínimos

- unit: normalização de identity;
- unit: deterministic matching;
- integration: unique race;
- integration: tenant isolation;
- integration: outbox atomicity;
- security: BOLA entre tenants;
- audit: merge/unmerge trace.

## 15. Refinamentos CRM v0.14

### Workspace e pipelines

CRM é projeção operacional sobre fatos canônicos. Manter pipelines especializados para Comercial, Ativação, Renovação e Recuperação. Drag/drop executa command validado; nunca `UPDATE stage` sem regras.

### Customer creation

Customer é criado quando a relação comercial é confirmada por `Order SETTLED`/pagamento confirmado conforme settlement, **antes** de depender do sucesso do fulfillment. Falha de provisionamento é fato operacional posterior.

### Next Action e atenção

Cada projeção pode possuir `next_action`, due time, owner e reason. `Attention Score` prioriza urgência operacional; Customer Health permanece classificação distinta.

### Customer 360 técnico

Adicionar `CustomerDevice` com type/brand/model/os/mac/device_id/app/app_device_key/nickname/status/last_seen/last_verified_at. Valores sensíveis devem ser mascarados/RBAC. Identidade ambígua: confirmar com usuário e depois Human Review se necessário; nunca merge probabilístico silencioso.

### Acquisition

Preservar múltiplos touches; `primary_source` é apenas projeção de conveniência. Filtros/Saved Views são requisito transversal.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — CRM projections, customer creation and device context checked.

