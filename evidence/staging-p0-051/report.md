# STAGING-P0 — primeira prova staging com migration 051 (issue #10)

Branch: `closure/p0-outbox-interlock` (PR #12 draft), commit `2f27ae4` no início da prova.
Projeto compose isolado: `-p iptv-staging-p0` (volumes `iptv-staging-p0_*`; volume dev
`iptv_iptv_pgdata` nunca tocado; confirmado via `docker volume ls` — removido só `iptv-staging-p0_pgdata` no destroy).
Runbook: `docs/10-operations/runbooks/staging-deploy.md`. Compose: `deploy/staging/docker-compose.staging.yml`.

Disciplina de segredos: valores reais SOMENTE em `deploy/staging/.env.staging*`
(gitignored, nunca commitados). Senhas trafegaram via stdin (`psql -i`) ou variáveis
de memória — nunca em linha de comando nem neste relatório. Tokens de sessão admin
viveram em `$env:TEMP` e foram destruídos. Este relatório traz comandos literais e
saídas RESUMIDAS (códigos, contagens, papéis) — nenhum segredo.

## 0. Pré-voo

- `docker ps`: nenhum `iptv-staging-*` ATIVO. Havia 4 containers `Exited (0) 22h`
  de prova anterior (outro projeto compose, mesmo `container_name`): removidos com
  `docker rm iptv-staging-postgres iptv-staging-migrate iptv-staging-api iptv-staging-web`
  (containers apenas; volumes do projeto isolado intactos).
- `compose config --quiet` → `CONFIG_OK`. Portas publicadas: só `127.0.0.1:3001` (api)
  e `127.0.0.1:3000` (web); postgres sem porta publicada.
- `.env.staging`: refresh a partir do `.example` (adicionado o bloco comentado
  `LEGACY_OUTBOX_DRAIN_ENABLED` que faltava na cópia antiga); segredos locais preservados.
- `.env.staging.outbox-worker`: criado do `.example` (senha hex gerada localmente):
  `OUTBOX_WORKER_ENABLED=1`, `OUTBOX_WORKER_ID=staging-outbox-1`,
  `OUTBOX_WORKER_DATABASE_URL=postgresql://outbox_worker:<redacted>@postgres:5432/iptv`
  (valores de quiescência preenchidos só no passo 5, após observação).

## 1. Build — OK (4/4)

```powershell
docker compose -p iptv-staging-p0 --env-file deploy/staging/.env.staging `
  -f deploy/staging/docker-compose.staging.yml build migrate api web outbox-worker
```

Log integral: `evidence/staging-p0-051/build.log` (últimas linhas: `Image iptv-staging-{migrate,api,web,outbox-worker}:local Built`,
`BUILD_EXIT=True`). Imagens anteriores (22h, pré-051) foram substituídas.

## 2. Subida — OK

```powershell
docker compose ... up -d postgres                                   # fresh volume iptv-staging-p0_pgdata, Healthy
docker compose ... run --rm migrate
# iptv-migrate: applied=51 skipped=0 total=51 dir=/app/db/migrations
# (posicionadas via stdin: ALTER ROLE iptv_app / outbox_worker PASSWORD — sem eco)
docker compose ... up -d api web                                    # ambos Healthy
curl.exe http://127.0.0.1:3001/v1/health        → 200
curl.exe http://127.0.0.1:3001/v1/health/ready  → 200 {"status":"ok","checks":{"database":"ok"}}
curl.exe http://127.0.0.1:3000/                 → 200
```

API subiu como `iptv_app` (boot prova a senha: sem ela, o guard recusa).

## 3. Provas no PG — OK

```sql
SELECT usename, count(*) FROM pg_stat_activity WHERE datname='iptv' GROUP BY 1;
-- iptv_app 1 (pool da API) + iptv_owner 1 (a própria sessão psql da prova)
SELECT rolname FROM pg_roles WHERE rolbypassrls;  -- só iptv_owner (superuser owner, esperado)
SELECT mode, generation FROM platform.outbox_runtime_control WHERE id=1;
-- LEGACY, 1 (seed da 051)
-- owners: outbox_runtime_control/transitions + outbox_runtime_{mode,set} + outbox_claim → outbox_executor
```

## 4. Restart + drill backup→destroy→restore — OK (CORRIGIDO pós-review)

- `compose restart api` → `/v1/health/ready` 200 `{"status":"ok","checks":{"database":"ok"}}`.
- REVIEW FINDING (HIGH, corrigido): o primeiro drill usou `pg_restore --no-owner`,
  que achata a fronteira de privilégios 050/051 (objetos restaurados pertencem ao
  restaurador e o `SECURITY DEFINER` passaria a executar como superuser) — e o
  ownership só havia sido checado ANTES do restore. O drill foi REFEITO do jeito
  certo; o que vale é o procedimento abaixo.
- Procedimento correto (executado): baseline autoritativo via `migrate` fresco
  (`applied=51`, owners instalados pelas migrations: runtime → `outbox_executor`) →
  `pg_dump -Fc` → `down -v` (só o projeto isolado) → `up -d postgres` (cluster fresco)
  → cenário B (roles compatíveis pré-criadas: `iptv_app LOGIN NOBYPASSRLS`,
  `outbox_worker LOGIN NOBYPASSRLS`, `outbox_executor NOLOGIN NOINHERIT NOBYPASSRLS`)
  → senhas reposicionadas via stdin → `pg_restore --exit-on-error` SEM `--no-owner`
  (exit 0, sem erros).
- Verificação PÓS-restore (o ponto do finding): 4/4 tabelas com owner esperado
  (`outbox_runtime_control/transitions → outbox_executor`,
  `outbox_messages/transitions → iptv_owner` — desenho da 050); 6/6 funções
  `outbox_executor`-owned `SECURITY DEFINER`
  (`runtime_mode`, `runtime_set`, `claim`, `renew`, `complete`, `fail`); grants
  exatos (`claim→outbox_worker` só; `mode→iptv_app+outbox_worker`;
  `set→ninguém`; BYPASSRLS só `iptv_owner`); modo `LEGACY` geração `1`,
  transições `0` (baseline fresco — o ciclo gen 2–5 do rehearsal vive no banco
  anterior, não neste drill de fronteira).
- `run --rm migrate` → `applied=0 skipped=51 total=51` (no-op idempotente; history intacto).
- `up -d api web` → api Healthy, `/v1/health/ready` 200, web `/` 200,
  sessão `iptv_app` presente.
- Nota honesta: um restore intermediário desta correção PROVOU o problema — após
  `--no-owner`, tudo pertencia a `iptv_owner` (fronteira perdida). O restore final
  COM owners preservou a fronteira acima.

## 5. Cutover rehearsal 051 (set() via DB) — OK

Sessão platform-admin cunhada via SQL owner (`control.users` is_platform_admin +
`control.auth_sessions` com `token_hash = sha256(secret:token)`; token em TEMP,
destruído ao fim). drain-state exige `x-tenant-context-revision: 0` (sem ele, 409
`TENANT_CONTEXT_CONFLICT` — comportamento do guard, não falha).

| Passo | Comando / evidência | Resultado |
|---|---|---|
| drain-state pré | `GET /v1/admin/outbox/drain-state` | `{"enabled":true,"inFlight":0,...}` 200 |
| desliga legacy | `LEGACY_OUTBOX_DRAIN_ENABLED=0` + `up -d --force-recreate api` | — |
| drain-state pós | idem | `{"enabled":false,"inFlight":0,...}` 200 |
| `LEGACY→QUIESCING` | `SELECT platform.outbox_runtime_set('LEGACY','QUIESCING','staging-p0-ops',1)` | gen `2` |
| unfenced-zero | `count(*) PUBLISHING AND lease_expires_at IS NULL` e `... claim_token IS NULL` | `0` e `0` |
| `QUIESCING→WORKER` | `..._set('QUIESCING','WORKER','staging-p0-ops',2)` | gen `3`, mode `WORKER` |
| legacy recusa | `POST /v1/admin/outbox/drain {"limit":10}` | 409 `LEGACY_DRAIN_DISABLED` |
| CAS negativo | `_set('WORKER','QUIESCING','staging-p0-ops',2)` (gen obsoleta) | `ERROR: outbox_runtime_set: runtime mode changed concurrently` (mensagem fixa, sem eco) |
| claim gate | `SELECT count(*) FROM platform.outbox_claim(10,'staging-p0-probe',300)` em WORKER | `0` (passa, tabela vazia) |
| worker env | `OUTBOX_LEGACY_QUIESCED=1`, `OUTBOX_LEGACY_DRAIN_ENABLED=0`, `OUTBOX_LEGACY_IN_FLIGHT=0` (observados) | — |
| `check` | `--profile outbox run --rm outbox-worker check` | `{"status":"ready",...}` exit `0` |
| `run --once` | `--profile outbox run --rm outbox-worker run --once` | `{"status":"ok","claimed":0,...,"empty":true}` exit `0` (tabela vazia — caminho empty certificado) |
| loop | `--profile outbox up -d outbox-worker` | `healthy`; `pg_stat_activity`: `iptv_app 1` + `outbox_worker 1` |

Nota: o 409 do drain legado veio pelo env kill-switch (checado antes, por desenho);
o gate de modo no DB (`C-LEGACY-GATE`) é coberto por `apps/api/test/outbox-legacy-quiescence.test.ts`
+ `db/tests/016`.

## 6. Rollback rehearsal + re-arm legacy — OK

- Pré-stop: `PUBLISHING` com lease vivo = `0`; `stop outbox-worker`.
- `set('WORKER','QUIESCING',...,3)` → gen `4`; `set('QUIESCING','LEGACY',...,4)` → gen `5`, mode `LEGACY`.
- `platform.outbox_runtime_transitions`: 4 linhas (`LEGACY→QUIESCING 2`, `QUIESCING→WORKER 3`,
  `WORKER→QUIESCING 4`, `QUIESCING→LEGACY 5`, actor `staging-p0-ops`).
- Re-arm: `LEGACY_OUTBOX_DRAIN_ENABLED=1` + `up -d --force-recreate api` →
  drain-state `{"enabled":true,"inFlight":0,...}` 200, `/v1/health/ready` 200.
- Container do worker removido (`--profile outbox rm -f outbox-worker`, parado, sem dados).
  Estado final: postgres+api+web Healthy, modo `LEGACY` (legacy volta a deter publishing).

## Limitações explícitas do escopo (review finding)

"Drill OK" e "prova OK" neste relatório referem-se SOMENTE ao escopo executado:

- Sem validação de scheduler/jobs (`API_SCHEDULER_ENABLED=0` o tempo todo; drains
  legados nunca agendados — só via endpoint admin sob controle do operador).
- Sem pooling/PgBouncer (tráfego direto; certificação do pooler pendente, ver runbook
  de cutover passo 4).
- Sem publish/retry/reclaim com dados: o smoke do worker foi empty-batch
  (`claimed:0, empty:true`); happy publish, fail/retry, renew, reclaim e restart
  com linhas reais estão cobertos por testes (`worker.integration.test.ts`,
  `db/tests/015-016`), não por esta prova.
- Sem RPO/RTO: backup foi `pg_dump -Fc` local (arquivo destruído após o restore);
  agendamento, offsite, encryption e PITR continuam `OPERATOR/INFRA EVIDENCE REQUIRED`.
- Seeds piloto puladas (ver Decisões): sem fixtures de domínio neste banco.

## Decisões

- Seeds piloto (`001_pilot_baseline.sql`) PULADAS: o smoke do worker precisa de escritas
  de domínio vivas (linhas de outbox), não de fixtures seed; o caminho empty-batch é o
  smoke certificado (healthcheck usa `check` zero-claim). Restore drill já exercitou
  dados reais (schema + sessão ops).
- Senhas de papel reposicionadas pós-restore via caminho aprovado local (stdin owner),
  conforme `backup-restore.md` passo 5 — roles são cluster-level e não vivem no dump.
- 409 inicial sem header de revisão registrado como comportamento esperado do guard.
- Build log integral em `build.log` (neste diretório); sem segredos em nenhum arquivo commitável
  (verificado: só nomes de papéis/contagens/códigos neste relatório).
