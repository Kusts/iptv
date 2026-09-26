# Data Architecture

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20

## 1. Objetivo

Preservar consistência, multi-tenancy, auditabilidade e capacidade analítica sem criar múltiplas fontes de verdade.

## 2. Primary store

PostgreSQL é a recomendação inicial para dados autoritativos relacionais.

Não implica fornecedor específico; Supabase/Neon/Postgres self-hosted podem ser avaliados depois.

## 3. Logical schemas / ownership

Organização conceitual possível:

```text
control_plane
identity_crm
communications
trial
commerce
billing
subscriptions
entitlements
provider_ops
support
knowledge
referral_loyalty
finance
inventory
analytics_metadata
audit
integration
```

Não exige schema físico separado para todos no primeiro release; o objetivo é ownership explícito.

## 4. Tenant isolation

Toda entidade tenant-owned carrega tenant context.

Defesa em profundidade:

```text
Authenticated Tenant Context
+
Application Authorization
+
Database RLS/Equivalent
+
Tenant-aware jobs/events/storage
```

Control-plane data possui regras próprias.

## 5. IDs

Usar IDs internos estáveis como primary identity.

External IDs:

```text
Asaas customer/payment ID
CINEVISION customer ID
WhatsApp ID
Meta click IDs
```

ficam em bindings/references apropriados.

Nunca usar external ID como primary key canônica de negócio.

## 6. Immutable/history patterns

Append-only ou versionado para:

- Financial Ledger;
- Provider Credit Ledger;
- Reward Ledger;
- Audit Log;
- Price Snapshot;
- domain events/outbox;
- provider operation attempts;
- knowledge validation history.

## 7. State tables versus event history

Não é pure event sourcing.

Padrão recomendado:

```text
Current State Tables
+
Immutable Events/Audit/Ledgers
```

State machine lê current state; histórico permite auditoria/reconstrução relevante.

## 8. Transactional Outbox

Mudança de domínio + evento correspondente entram na mesma transaction quando aplicável.

```text
BEGIN
  update aggregate
  insert outbox event
COMMIT
```

Publisher assíncrono entrega posteriormente.

## 9. Integration Inbox

Webhooks/eventos externos devem possuir inbox/deduplication record:

```text
provider
external_event_id
received_at
payload_hash
processing_status
canonical_effect_id
```

Permite at-least-once sem duplicate effects.

## 10. Money

Valores monetários devem ser armazenados em unidade inteira de menor denominação ou decimal adequado consistente, com currency explícita.

Nunca usar float binário para valor financeiro.

## 11. Provider Credits

Provider credits possuem ledger próprio e custo econômico.

Additional Connection gera consumo recorrente em cada ciclo aplicável.

## 12. Knowledge

Separar:

```text
Raw Source
Normalized Content
Candidate Knowledge
Canonical Knowledge
Solution Evidence
```

Vector embeddings, caso utilizados, são índice derivado; Knowledge canônico continua no store autoritativo.

## 13. Search

Começar com mecanismos simples quando suficientes:

- relational filters;
- PostgreSQL full-text;
- optional vector index.

Não introduzir vector database separado sem necessidade mensurável.

## 14. Object storage

Blobs referenciados por metadata tenant-aware.

Path/key deve incluir tenant namespace quando aplicável.

Signed access deve respeitar autorização e expiração.

## 15. Analytics

Operational DB pode alimentar primeiras projections/dashboards.

Com crescimento, analytics warehouse pode ser adicionado sem alterar a definição canônica de eventos/métricas.

## 16. Retention / deletion

Cada classe de dado precisa de policy posterior:

- business/legal retention;
- PII;
- conversations;
- media;
- browser traces;
- raw knowledge source;
- analytics.

Deletion deve respeitar ledgers/audit requirements e pseudonymization quando exclusão física conflitar com obrigações legítimas.

## 17. Auto-revisão aplicada

Revisado para:

- evitar event sourcing desnecessário;
- manter external IDs como bindings;
- preservar ledgers append-only;
- tratar embeddings como derivados;
- manter additional connection no Credit Ledger por ciclo;
- permitir warehouse futuro sem bifurcar semântica.
