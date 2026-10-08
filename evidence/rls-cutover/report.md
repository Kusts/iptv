# STAGING-CUTOVER — global cutover rehearsal on disposable staging (P1-exit parte 2)

Branch `closure/p1-cutover`, commit `58640a1` (tree limpo no início; 059 migrations).
Projeto compose isolado `-p iptv-cutover` via cópia operacional do compose em
`$TEMP/opencode/iptv-cutover/docker-compose.cutover.yml` (mesmo conteúdo,
só `container_name` → `iptv-cutover-*` e portas de host `3101/3100` — o projeto
anterior `iptv-staging-p0` segue UP e intocado; volumes dev
`iptv_iptv_pgdata` e `iptv-staging-p0_pgdata` nunca tocados).
Runbooks: `staging-deploy.md` + `rls-role-split-cutover.md` (este rehearsal
vira a seção de procedimento de cutover + certificação PgBouncer).

Disciplina de segredos: valores reais SOMENTE em
`deploy/staging/.env.staging*` (gitignored, reutilizados, nunca impressos).
Senhas trafegaram em memória do processo ou stdin — nunca em linha de comando
nem neste relatório. Token admin viveu em `$TEMP` e foi destruído; a sessão
probe foi removida do banco. Comandos abaixo com `<redacted>` onde há segredo;
saídas resumidas (códigos, contagens, papéis).

## 0. Pré-voo

- `docker ps`: `iptv-staging-{api,web,postgres}` UP (projeto anterior) +
  `iptv-pg-test` (dev, porta 5432 host) — nenhum tocado; por isso o lane novo
  usa host ports `3101` (api) / `3100` (web) e nomes próprios.
- `compose config --quiet` (cópia TEMP) → `CONFIG_OK`. Postgres sem porta
  publicada; api/web só loopback.
- `.env.staging` existente: `APP_DATABASE_URL` user=`iptv_app`,
  `DATABASE_URL` user=`iptv_owner`, `NODE_ENV=production`, `SCHED=0`
  (scheduler desligado o tempo todo), `LEGACY_DRAIN=1`, `LOG=info`,
  `DISPATCH=durable`. Senha owner confere com `POSTGRES_PASSWORD`
  (`OWNER_PW_MATCH`, verificado em memória).

## 1. Build — OK (3/3)

```powershell
docker compose -p iptv-cutover --env-file deploy/staging/.env.staging `
  -f $TEMP/opencode/iptv-cutover/docker-compose.cutover.yml build migrate api web
# Image iptv-cutover-{web,migrate,api}:local Built (imagens próprias do lane;
# as imagens iptv-staging-*:local do projeto anterior não foram tocadas)
```

## 2. Subida — OK

```powershell
docker compose ... up -d postgres        # volume fresco iptv-cutover_pgdata, Healthy
docker compose ... run --rm migrate
# iptv-migrate: applied=59 skipped=0 total=59 dir=/app/db/migrations
# (posicionadas via stdin, sem eco: ALTER ROLE iptv_app / <owner> PASSWORD — 050+ não definem senha)
docker compose ... up -d api web          # ambos Healthy
curl.exe http://127.0.0.1:3101/v1/health        → 200
curl.exe http://127.0.0.1:3101/v1/health/ready  → 200 {"status":"ok","checks":{"database":"ok"}}
curl.exe http://127.0.0.1:3100/                 → 200
```

API subiu como `iptv_app` (o boot prova a senha + o guard fail-closed de
`APP_DATABASE_URL`; sem ela, recusa).

## 3. Provas no PG — OK (direto, owner via socket)

`01-roles.sql` (em `$TEMP`, fora do repo):

```sql
SELECT usename, count(*) FROM pg_stat_activity WHERE datname='iptv' GROUP BY 1;
-- iptv_app 1 (pool da API) + iptv_owner 1 (a própria sessão psql da prova)
SELECT rolname FROM pg_roles WHERE rolbypassrls;  -- só iptv_owner (superuser owner, esperado)
SELECT mode, generation FROM platform.outbox_runtime_control WHERE id = 1;
-- LEGACY, 1 (seed da 051 — cutover de outbox é separado, worker NÃO ativado aqui)
SELECT count(*) FROM platform.outbox_messages WHERE state='PUBLISHING' AND lease_expires_at IS NULL;
-- 0 (zero unfenced)
```

## 4. Seeds piloto — APLICADAS (divergência do STAGING-P0, que pulou)

```powershell
Get-Content db/seeds/001_pilot_baseline.sql | docker exec -i iptv-cutover-postgres `
  psql -U iptv_owner -d iptv -v ON_ERROR_STOP=1
# ... INSERT 0 1 (×N) ... COMMIT — sem erro. O arquivo é transacionado
# (BEGIN linha 5 / COMMIT linha 149) e passou sobre o schema 059 sem ajuste,
# apesar do README ainda dizer "46 files".
```

## 5. A/B funcional sob iptv_app — OK 4/4 (direto)

Fixture owner `02-fixture.sql`: tenants `cutover-probe-a/b` + 1 person +
1 customer cada (UUIDs fixos, dispostos após as seeds).

`03-ab-txn.sql` como `iptv_app` (socket, blocos `BEGIN; SET LOCAL app.tenant_id; …; COMMIT`
— a disciplina real do app):

| Probe | Resultado |
|---|---|
| A-sees | 1 (só o próprio) |
| B-sees | 1 (só o próprio) |
| noctx-sees | 0 (fail-closed) |
| x-insert (ctx A, linha tenant B FK-válida) | `ERROR 42501` RLS violation (confirmado com `VERBOSITY=verbose` → `SQLSTATE 42501`) |

Owner bypass: `owner-sees=3` (2 probe + 1 seed) — owner vê tudo, esperado.

## 6. drain-state + runtime — OK (worker NÃO ativado, por escopo)

Sessão platform-admin cunhada via SQL owner (`control.users`
`is_platform_admin=true` + `control.auth_sessions` com
`token_hash = sha256(secret:token)`; segredo lido em memória, token em
`$TEMP`, destruído após o uso; linhas removidas ao fim —
`ADMIN_PROBE_REMOVED`):

```powershell
curl.exe http://127.0.0.1:3101/v1/admin/outbox/drain-state `
  -H "Authorization: Bearer <redacted>" -H "x-tenant-context-revision: 0"
# → 200 {"enabled":true,"inFlight":0,"totalDrains":0,"lastFinishedAt":null}
```

Sem o header de revisão o guard responde 409 (comportamento, não falha).
Modo DB `LEGACY` gen 1 (§3) + `LEGACY_OUTBOX_DRAIN_ENABLED=1` + scheduler
desligado: o drain legado detém publishing; nenhuma transição `set()` foi
executada e o perfil `outbox` nunca subiu — ativação é procedimento separado
(runbook staging-deploy § Outbox worker activation).

## 7. PgBouncer profile — OK (certificado neste lane)

`deploy/pgbouncer/userlist.staging.txt` gerado localmente (gitignored,
confirmado via `git check-ignore`; entradas plaintext `iptv_app` + owner para
SCRAM — mesma regra do `userlist.txt` de dev):

```powershell
docker compose ... --profile pooling up -d pgbouncer   # PgBouncer 1.25.2, listening 6432
```

Readiness repetida com pooler UP: `/v1/health/ready` → 200, web `/` → 200.
Fluxo A/B via pooler (`psql -h iptv-cutover-pgbouncer -p 6432 -U iptv_app`,
mesmo `03-ab-txn.sql`, senha via variável de memória, rede
`iptv-cutover_internal`):

| Probe via pooler | Resultado |
|---|---|
| A-sees / B-sees / noctx-sees | 1 / 1 / 0 — idêntico ao direto |
| x-insert | `ERROR` RLS violation (42501-class) |

Transação por transação com `SET LOCAL` sobrevive ao `pool_mode=transaction`
+ `server_reset_query = DISCARD ALL` sem vazamento de contexto entre
transações sequenciais do mesmo cliente. **Pooler CERTIFICADO para o lane de
staging sobre a árvore 059** (tráfego direto continua o default; migrations e
owner seguem DIRECT, nunca pooled).

## 8. Estado final do lane

`iptv-cutover-{postgres,api,web,pgbouncer}` UP (api/web healthy); fixtures
probe + seeds no banco descartável; sessão admin removida; `userlist.staging.txt`
local gitignored. Lane preservado para re-verificação; destruir com
`docker compose -p iptv-cutover … down -v` (só volumes `iptv-cutover_*`).

## Limitações explícitas do escopo

- Scheduler desligado (`API_SCHEDULER_ENABLED=0`): drains legados nunca
  agendados — só o endpoint admin sob controle do operador.
- Sem publish/retry/reclaim com dados: smoke é A/B + RLS + readiness; happy
  publish, fail/retry, renew, reclaim seguem cobertos por testes
  (`worker.integration`, `db/tests/015-016-019-021`) e pelo rehearsal de
  ativação separado (STAGING-P0 cobriu o ciclo LEGACY→…→LEGACY em 051).
- Sem backup/restore drill neste lane (coberto no STAGING-P0 com a fronteira
  050/051 verificada pós-restore).
- Sem RPO/RTO, sem browser-worker, sem TLS público (loopback-only por desenho).
- `db/seeds/README.md` continua dizendo "46 files" (stale; fora do escopo de
  escrita — registrado para o Planner).

## Decisões (para o Planner)

- Seeds aplicadas (não puladas): transacionadas e verdes sobre 059; fixtures
  de domínio presentes sem mascarar o A/B (asserts usam tenants probe).
- Worker `outbox` NÃO ativado: procedimento de ativação é outro slice; modo
  `LEGACY` preservado e provado.
- `userlist.staging.txt` é setup de ambiente gitignored (não mudança de repo).
- Pré-existentes no `git status` (eval-runner, ADR-0020, fixtures agent-evals)
  não tocados.
