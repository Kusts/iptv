# Migration Batch — MVP Bootstrap v0.7

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20  
> Implementação: `db/migrations/*.sql`

## 1. Objetivo

Transformar o baseline físico já aprovado em DDL PostgreSQL executável para os três primeiros batches do MVP:

```text
Platform primitives
↓
Identity / CRM
↓
Trial / Retrial
```

## 2. Arquivos

```text
db/migrations/202609201530_001_platform.sql
db/migrations/202609201531_002_identity_crm.sql
db/migrations/202609201532_003_trial.sql
```

## 3. Decisões materializadas

### Platform

- PostgreSQL schemas por bounded area;
- tenant catalog auth-agnostic;
- memberships;
- feature/kill-switch baseline;
- risk assessment baseline;
- idempotency;
- audit append-only;
- domain events + transactional outbox;
- webhook/integration inbox dedupe.

### Identity / CRM

- Person canônica;
- Identity tenant-scoped;
- active identity unique por `(tenant, identity_type, normalized_value)`;
- ambiguous merge é review;
- Lead e Customer são lifecycles independentes;
- Customer Health é snapshot/projeção.

### Trial

- eligibility decision append-oriented;
- lifecycle e technical outcome separados;
- no máximo um `TRIAL` primário por Person;
- exceções são `RETRIAL` com link + razão;
- no máximo um acesso gratuito aberto por Person;
- contexto de device/app/network/compatibility preservado.

## 4. Por que uma única primary Trial constraint é segura

O desenho anterior falava em “um Trial válido”, conceito que depende de resultado técnico e evidência. Tentar calcular toda essa semântica em um índice seria frágil.

O modelo foi refinado para distinguir:

```text
TRIAL   = primeira oportunidade gratuita
RETRIAL = exceção posterior justificada
```

Logo, o banco pode impor de forma simples:

```text
UNIQUE (tenant_id, person_id)
WHERE trial_kind = 'TRIAL'
```

sem decidir se uma exceção é legítima. Essa decisão continua em Domain/Risk/Policy e, quando aprovada, cria `RETRIAL`.

## 5. Concorrência

Além da primary Trial constraint:

```text
UNIQUE (tenant_id, person_id)
WHERE lifecycle_status IN ('REQUESTED','PROVISIONING','ACTIVE')
```

impede duas janelas gratuitas concorrentes causadas por requests simultâneos/replay.

A aplicação ainda deve tratar unique-violation como conflito esperado e resolver/retornar o estado canônico.

## 6. Tenant isolation

O batch usa FKs compostas `(tenant_id, id)` em relações críticas de domínio.

Exemplo corrigido durante auto-review:

```text
TrialEligibilityDecision
→ RiskAssessment
```

usa:

```text
(tenant_id, risk_assessment_id)
→ security.risk_assessments(tenant_id, id)
```

em vez de FK somente por UUID.

## 7. O que ainda não é decidido fisicamente

- RLS final;
- role/grants de runtime;
- auth provider;
- UUIDv7 vs UUID random;
- partitioning;
- workflow-runtime tables;
- provider/commerce/support/referral batches.

Esses itens não devem ser inferidos destas migrations.

## 8. Validação obrigatória antes de aplicar em ambiente compartilhado

1. executar em PostgreSQL vazio;
2. rodar integration tests Identity + Trial;
3. testar duas criações concorrentes do mesmo Identity;
4. testar duas criações concorrentes de primary Trial;
5. testar tentativa de FK cross-tenant;
6. testar event + outbox na mesma transaction;
7. testar webhook replay;
8. revisar query plans dos lookups básicos;
9. validar grants/RLS antes de produção real.

## 9. Rollback

Seguir `migration-strategy.md`: preferir roll-forward. Estas migrations não incluem DROP/down automático porque isso é mais perigoso em ambiente com fatos de negócio.

## 10. Auto-revisão

Revisão feita contra Logical Data Model, Physical Schema, Migration Strategy, Identity SPEC e Trial SPEC. Melhorias incorporadas:

- constraint de primary Trial tornada semanticamente explícita;
- bloqueio de Trial concorrente adicionado;
- RiskAssessment FK tornou-se tenant-aware;
- enums/checks usam estados canônicos de Lead/Customer/Trial;
- `PASSED` permaneceu technical outcome, nunca lifecycle;
- DDL não introduziu provider/auth vendor específico.
