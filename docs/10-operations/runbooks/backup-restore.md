# Runbook — Backup, Restore e Disaster Recovery (baseline executável)

> Status: backup + restore drill IMPLEMENTED (`scripts/db-backup.sh`,
> `scripts/db-restore-drill.sh`); drill executado localmente contra
> PostgreSQL 17 em container = TESTED (ver log abaixo). Agendamento, cópia
> offsite, encryption at rest e retenção de longo prazo são
> OPERATOR/INFRA EVIDENCE REQUIRED — a existência do script não valida DR.
> Targets de referência (RPO ≤ 15 min, RTO ≤ 60 min):
> `docs/15-implementation-baseline/13-nfr-slo-dr.md` — NÃO os declare como
> atendidos até que o agendamento e o restore em infra real tenham evidência.

## Princípios

1. Backup não é DR. Só existe DR quando um restore foi executado e
   validado a partir de um archive real.
2. Todo archive carrega manifest (`sha256`, tamanho, versão do `pg_dump`,
   origem). O drill rejeita archive com hash divergente ANTES de restaurar.
3. O drill roda em container descartável isolado e NUNCA toca o banco fonte.
4. Migrations/version validation faz parte do restore: um archive cujo
   `platform.migration_history` não bate com `db/migrations/*.sql` do
   repositório é um restore parcial — falha, não aviso.
5. Status vocabulary: `IMPLEMENTED` (existe e roda), `TESTED` (executado com
   evidência), `OPERATOR/INFRA EVIDENCE REQUIRED` (depende de infraestrutura
   ou decisão humana externa a este repositório).

## Backup (execução)

```bash
# Container é a fonte (pg_dump roda dentro do container; host não precisa de
# psql/pg_dump). Owner role direto; NUNCA via iptv_app/pooler.
bash scripts/db-backup.sh <container> <db-user> <db-name> <output-dir> [keep=7]
```

Saídas: `<db>-<timestamp>.dump` (formato custom `-Fc`) +
`<db>-<timestamp>.dump.manifest.json`. Retenção local: mantém os N mais
recentes (`keep`).

## Restore drill (validação executável)

```bash
bash scripts/db-restore-drill.sh <backup.dump> <drill-db-name> [postgres:17-alpine] [repo-root]
```

Passos do script: sha256 vs manifest → container descartável →
`pg_restore --exit-on-error` → validações (contagem de migrations idêntica ao
repositório; ledger `finance` balanceado debit=credit quando presente;
espinha `audit_log`/`domain_events` presente; invariantes de provider:
operações terminais com `completed_at`, bindings `ACTIVE` com
`external_id`) → `DRILL PASS`/`DRILL FAIL` + cleanup automático.

`pg_restore` valida o TOC do archive antes de aplicar; archive truncado ou
corrompido falha no restore, não pela metade.

## Procedimento de restore real (incidente)

1. Congelar escritas no alvo (parar API/workers; `deploy/staging` compose:
   `docker compose stop api web worker`).
2. Escolher o archive mais recente **validado** (manifest + hash ok). Em
   dúvida entre archives, rodar o drill em cada candidato antes de decidir.
3. Provisionar o PostgreSQL alvo na MESMA major version do archive (17).
4. `pg_restore -U <owner> -d <db> --no-owner --exit-on-error <backup.dump>` a
   partir de conexão owner direta — as regras do runbook de RLS continuam
   valendo: restore roda como owner; o app só volta como `iptv_app` depois
   das checagens.
5. Reaplicar roles/papéis pós-restore se necessário (`iptv_app` LOGIN,
   grants vêm do dump; a senha do role NÃO — reposicionar via caminho de
   secrets aprovado, ver rls-role-split-cutover.md step 4a).
6. Apontar a aplicação de volta (compose up), confirmar `/v1/health/ready` e
   `LOG_LEVEL` ativo, observar outbox/reconciliação
   (outbox-workflow-backlog.md, reconciliation-drift.md).
7. Registrar evidência (comando, archive hash, duração, checagens) no log de
   operações. Sem esse registro, o incidente não conta como validação DR.

## Encryption e offsite (OPERATOR/INFRA EVIDENCE REQUIRED)

- Encryption at rest do archive: aplicar na camada de storage (ex. `age`/
  `gpg -c` sobre o `.dump` ANTES da cópia offsite, chave em cofre separado —
  Infisical/vault do operador, nunca junto do archive).
- Offsite: copiar `.dump` + `.manifest.json` para storage externo ao host
  (objeto/outra região) com retenção própria. 3-2-1 como alvo declarado.
- Agendamento: cron/tarefa agendada no host chamando `db-backup.sh`; frequência
  definida pelo RPO alvo (15 min ⇒ WAL archiving/PITR é o caminho correto, não
  dumps periódicos — decisão de infra, registrar ADR quando escolhido).
- Testes de restore periódicos: rodar o drill contra um archive recente
  mensalmente (ou pós-qualquer upgrade de major version do PostgreSQL) e
  registrar evidência.

## Log de execução (2026-10-05 — hardening closure round)

- Base migrada via o próprio job de deploy: `iptv-migrate` aplicou as 47
  migrations em container descartável (`applied=47` na primeira execução,
  `skipped=47 idempotente` na re-execução).
- Backup: `scripts/db-backup.sh iptv-verify2 iptv iptv_test artifacts/drill 3`
  → `iptv_test-20261005T182132Z.dump` + manifest (sha256 `b050631d2d6b…`).
- Drill: `scripts/db-restore-drill.sh` em container descartável isolado —
  **DRILL PASS**: hash OK; roles `iptv`/`iptv_app` provisionados antes do
  restore; `pg_restore --exit-on-error` OK; migrations `restored=47
  expected=47`; ledger debit=credit; espinha `audit_log`/`domain_events`
  presente; invariantes de provider OK (0 operações terminais sem
  `completed_at`, 0 bindings `ACTIVE` sem `external_id`).
- Achados do drill (corrigidos no script, são parte do procedimento real):
  1. restore em cluster fresco exige provisionar os roles ANTES do
     `pg_restore` (os dumps carregam `GRANT … TO iptv_app` de
     041/042/043/047) — o passo já constava do runbook como step 5; agora é
     executado e verificado pelo drill;
  2. o entrypoint da imagem sobe um servidor TEMPORÁRIO durante o initdb e o
     reinicia — probes/writes contra ele desaparecem; o drill converge
     re-executando statements reais até os efeitos persistirem;
  3. armadilha bash: `${VAR:-"a b"}` dentro de `for` não sofre word-splitting
     (criaria um role literalmente chamado `iptv iptv_app`).
- NÃO validado nesta rodada (permanece aberto): restore em infra real
  (VPS/storage externo), encryption, agendamento, PITR/WAL.
