# SPEC — Reconciliation & Reliability

> Status: Supporting detail — reconciled under v1.0 implementation baseline
> Versão: 1.0  
> Slice: MVP-06  
> Dependências: Billing, Provider Fulfillment, Events/Outbox, Ledger

## 1. Objetivo

Garantir que falhas parciais, mensagens duplicadas e divergências com sistemas externos não corrompam o estado autoritativo nem produzam efeitos duplicados.

## 2. Princípios

- external systems are not authoritative;
- duplicate delivery is normal;
- timeout does not prove failure;
- retry must verify whether effect already happened;
- repair is a new auditable action, not silent mutation;
- reconciliation detects drift; it does not rewrite history.

## 3. Reliability primitives

Obrigatórios no MVP:

```text
Idempotency keys
Transactional Outbox
Inbox/Deduplication
Retry with backoff
Timeouts
Dead-letter / terminal failure state
Correlation & causation IDs
Reconciliation runs
Audit trail
```

Circuit breaker pode ser aplicado por integração quando volume/risco justificar.

## 4. Reconciliation scopes

### Billing

Comparar:

```text
local Payment/Order/Ledger
↔
Asaas payment state
```

### Provider fulfillment

Comparar:

```text
Subscription/Entitlement truth
↔
observed provider state
```

### Messaging — mínimo

Comparar delivery states quando provider fornecer IDs confiáveis; não bloquear core comercial por telemetria incompleta de mensageria.

## 5. Modelo de mismatch

`reconciliation_mismatches` deve registrar:

- scope;
- local entity/type/state;
- external reference/state;
- severity;
- detected_at;
- evidence;
- recommended repair;
- repair status;
- linked provider operation/payment/audit IDs.

## 6. Severidade

Sugestão inicial:

```text
INFO       — diferença esperada/transitória
WARNING    — atraso além do normal
HIGH       — cliente/receita pode estar afetado
CRITICAL   — risco financeiro, cross-tenant ou efeito destrutivo
```

## 7. Auto-repair

Só permitir quando:

- regra determinística;
- baixo risco;
- efeito idempotente;
- pós-condição verificável;
- policy autoriza.

Exemplos potenciais:

- reenfileirar provider operation não executada;
- marcar webhook duplicado como processed;
- atualizar telemetry derivada a partir de fonte validada.

Não auto-repair por simples overwrite de ledger, entitlement ou identity.

## 8. Falhas críticas modeladas

### F1 — Payment paid externally, processing crashed locally

```text
webhook persisted/inbox
↓
worker crash
↓
retry consumes inbox
↓
ledger once
↓
Order settlement once
```

### F2 — Provider effect happened, response timed out

```text
operation timeout
↓
DO NOT blindly retry
↓
observe provider state
├─ postcondition satisfied → SUCCEEDED
└─ not satisfied → retry policy
```

### F3 — Order settled, fulfillment unavailable

```text
Order SETTLED
Subscription PENDING_ACTIVATION
Entitlements PENDING
ProviderOperation RETRY_WAIT/HUMAN_REQUIRED
```

Nenhum pagamento é perdido e nenhum falso `ACTIVE` é criado.

### F4 — Reward consumed twice by replay

Unique effect/idempotency + ledger constraints impedem segundo lançamento.

## 9. Scheduling

Rodar reconciliation:

- event-triggered após falha suspeita;
- periódico para billing/provider;
- manual on-demand pelo operador.

Cadência exata será decisão operacional baseada em volume e limites externos.

## 10. Observabilidade

Dashboard mínimo:

- mismatches abertos por scope/severity;
- age of oldest mismatch;
- auto-repair success;
- manual review backlog;
- outbox lag;
- inbox duplicate rate;
- provider retry rate;
- webhook processing latency.

## 11. Critérios de aceitação

- CA-01: replay de evento não duplica efeito financeiro.
- CA-02: timeout externo não é interpretado automaticamente como failure final.
- CA-03: repair gera auditoria e novo fato/operation quando aplicável.
- CA-04: ledger history não é sobrescrita para “bater” com provider.
- CA-05: reconciliation cross-tenant é impossível.
- CA-06: mismatch crítico é visível e alertável.
- CA-07: outbox/inbox conseguem replay seguro.

## 12. Testes mínimos

- crash after external webhook persist;
- duplicate webhook x10;
- provider timeout after successful effect;
- provider timeout before effect;
- settlement + provider outage;
- outbox publisher restart;
- reconciliation repair;
- forbidden cross-tenant repair.
