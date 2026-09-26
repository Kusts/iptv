# Database Migration Strategy

> Status: Proposed  
> Versão: 1.0  
> Escopo: PostgreSQL schema/data migrations para MVP e evolução SaaS.

## 1. Princípio

Migrations são código de produção e precisam ser:

```text
versionadas
revisáveis
repetíveis em ambientes novos
observáveis
compatíveis com rollout
```

Nunca editar migration já aplicada em ambiente compartilhado para “corrigir histórico”; criar nova migration corretiva.

## 2. Ownership

Uma única ferramenta/processo possui schema migrations.

ORM/query builder não deve executar mudanças implícitas de schema em produção.

## 3. Naming

Formato sugerido:

```text
YYYYMMDDHHMM_<short_description>.sql
```

ou sequence monotônica gerada pela ferramenta escolhida.

O importante é ordenação inequívoca e checksum.

## 4. Expand / Migrate / Contract

Mudanças breaking devem seguir:

```text
EXPAND
add backward-compatible schema
↓
MIGRATE
backfill/dual-read/dual-write as needed
↓
VERIFY
metrics/reconciliation
↓
CONTRACT
remove old path later
```

Evitar rename/drop em uma única release quando app antigo ainda pode estar rodando.

## 5. Estado/enums

Como state machines evoluem, evitar decisões físicas que tornem novos estados operacionalmente difíceis.

Se usar PostgreSQL enum nativo, documentar custo de evolução. Baseline favorece `text + check` quando isso simplificar rollout/versioning, mas decisão final deve ser validada no spike de DB.

## 6. Monetary changes

Nunca migrar valores financeiros por cálculo aproximado silencioso.

Backfills financeiros precisam:

- script determinístico;
- dry run/report;
- reconciliation totals;
- audit/reference;
- rollback lógico quando possível.

## 7. Tenant-aware backfills

Backfill grande deve processar em batches tenant-scoped, com checkpoints.

Não executar update global sem limite em tabela de produção grande.

## 8. Lock safety

Antes de migration potencialmente bloqueante:

- avaliar lock level;
- tamanho da tabela;
- duração esperada;
- online alternative;
- timeout;
- rollback/abort.

## 9. Defaults e NOT NULL

Em tabelas grandes, preferir rollout seguro:

```text
add nullable column
↓
backfill
↓
verify
↓
add constraint/not null
```

quando necessário para evitar locks/rewrite relevantes.

## 10. Indexes

Índices grandes devem usar opção online/concurrent quando aplicável e segura.

Migration runner precisa tratar comandos que não podem executar dentro da mesma transaction quando PostgreSQL exigir.

## 11. Data deletion / privacy

Deletion/anonymization jobs de privacidade não devem apagar fatos financeiros/audit que possuam retenção legal/legítima sem avaliação de base e policy.

Separar:

- delete;
- anonymize;
- restrict processing;
- retention hold.

## 12. Rollback

Rollback físico automático não é sempre seguro.

Preferência:

- backward-compatible releases;
- roll-forward correction;
- restore apenas em desastre;
- down migration apenas quando semanticamente segura.

## 13. Migration CI gate

Toda PR com migration deve executar:

- apply from empty DB;
- apply from previous released schema;
- schema diff expected;
- integration tests;
- tenant isolation tests afetados;
- lint/static checks;
- seed/test fixture compatibility.

## 14. Production gate

Registrar:

```text
migration version
start/end
actor/deployment
result
checksum
application version
```

Alertar falha parcial.

## 15. First migration batches

Sequência recomendada:

1. control/tenant/auth support;
2. platform audit/idempotency/events/outbox/inbox;
3. identity + CRM;
4. trial;
5. catalog + commerce + billing + ledger;
6. subscription + entitlements;
7. provider operations;
8. communication/support/agent;
9. referral/rewards;
10. analytics operational tables.

Essa sequência acompanha os vertical slices e minimiza tabelas sem consumidor.
