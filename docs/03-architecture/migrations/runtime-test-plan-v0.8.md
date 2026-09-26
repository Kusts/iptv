# PostgreSQL Runtime Test Plan — v0.8

> Status: Required before implementation gate  
> Data: 2026-09-20

## Objetivo

Validar em PostgreSQL real aquilo que revisão estática não consegue provar.

## Ambiente mínimo

- versão PostgreSQL definida no ADR/CI;
- banco vazio por execução;
- migrations 001–008 em ordem;
- timezone UTC no banco;
- testes executados também com duas tenants independentes.

## RT-01 — Bootstrap vazio

**Dado:** database vazio.  
**Quando:** migrations 001–008 são aplicadas.  
**Então:** nenhuma migration falha e todos os schemas/tabelas/constraints esperados existem.

## RT-02 — Cross-tenant FK

Criar Tenant A e B. Tentar associar:

- Trial A → RiskAssessment B;
- Subscription A → Customer B;
- ProviderOperation A → ProviderAccount B;
- CreditEntry A → SubscriptionCycle B.

**Esperado:** banco rejeita.

## RT-03 — Trial único

- criar TRIAL primário;
- tentar segundo TRIAL primário para mesma Person;
- criar RETRIAL com previous_trial_id + reason;
- tentar dois acessos abertos simultâneos.

**Esperado:** segundo TRIAL e concorrência falham; RETRIAL válido pode existir após janela aberta anterior terminar/invalidate.

## RT-04 — Order zero-value

Criar Order com gross=3000, reward=3000, net=0.

**Esperado:** modelo aceita settlement sem criar Payment fictício.

## RT-05 — Ledger balance

Caso A:

```text
Debit 3000
Credit 3000
```

**Esperado:** commit.

Caso B:

```text
Debit 3000
Credit 2000
```

**Esperado:** commit falha.

Caso C: `financial_transaction` sem entries.  
**Esperado:** commit falha.

Caso D: entry em moeda diferente da FinancialAccount.  
**Esperado:** FK falha.

Caso E: UPDATE/DELETE em ledger/transaction.  
**Esperado:** bloqueado por append-only trigger.

## RT-06 — Recurring add-on enforcement

- criar ONE_TIME add-on e tentar inserir em `subscription_addons`;
- criar RECURRING add-on e inserir.

**Esperado:** primeiro falha, segundo passa.

## RT-07 — Tela adicional em dois ciclos

Criar conexão adicional recorrente e dois SubscriptionCycles.

Inserir um `subscription_addon_cycle_charges` por ciclo:

```text
Cycle 1: revenue > 0, provider_cost > 0
Cycle 2: revenue > 0, provider_cost > 0
```

Depois testar reward:

```text
Cycle N: revenue = 0, provider_cost > 0
```

**Esperado:** todos os registros válidos e economicamente distinguíveis.

## RT-08 — ProviderOperation idempotency

Tentar duas operações com a mesma `(tenant, provider_account, idempotency_key)`.

**Esperado:** segunda inserção falha/é deduplicada pelo service.

## RT-09 — Credit inventory idempotency

Tentar dois ProviderCreditEntries com mesma idempotency key.

**Esperado:** segunda inserção falha.

## RT-10 — FK tardia do Trial

Depois da migration 007:

- Trial com provider account válido passa;
- provider account/binding de outra tenant falha.

## Gate

A documentação pode marcar migrations `runtime-tested` apenas quando RT-01…RT-10 estiverem automatizados em CI e verdes.
