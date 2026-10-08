# PILOT-DEPLOY — lane piloto fresco (`iptv-pilot`, :3200/:3201)

TASK_ID `PILOT-DEPLOY`. Main `5052b85` (todo o plano mergeado, CI verde).
Runbooks: `staging-deploy.md` + `rls-role-split-cutover.md` (cutover + ativação
051) + `P8-PILOT.md` (somente a ativação 051 e o smoke; tráfego real é ato do
operador — fora deste escopo).

Isolamento: projeto compose `-p iptv-pilot`, cópia operacional do compose em
`$TEMP/opencode/iptv-pilot/docker-compose.pilot.yml` (mesmo conteúdo, só
`container_name` → `iptv-pilot-*`, imagens `iptv-pilot-*:local`, host ports
`3201/3200`, `env_file` em caminhos absolutos do repo, `build.context`
absoluto). Volumes `iptv-pilot_pgdata` + rede `iptv-pilot_internal` próprios.
Lanes `iptv-staging-*` (:3000/:3001) e `iptv-cutover-*` (:3100/:3101) nunca
tocadas — as 6 portas seguem em LISTENING ao fim.

Disciplina de segredos: valores reais SOMENTE em
`deploy/staging/.env.pilot` + `deploy/staging/.env.pilot.outbox-worker`
(gitignored, `git check-ignore` confirma; `git status` limpo fora de
`evidence/rls-pilot/`). Senhas hex geradas no processo (48 chars papéis,
64 chars auth); trafegaram em memória/stdin — nunca em linha de comando nem
neste relatório. Sessão admin cunhada via SQL owner, token em `$TEMP`,
destruída após o uso (`ADMIN_PROBE_REMOVED`).

## 0. Pré-voo

- Portas :3200/:3201 livres (só :3000/:3001/:3100/:3101 em LISTENING); postgres
  do lane sem porta publicada; api/web só loopback.
- `compose config --quiet` (cópia TEMP) → `CONFIG_OK`.
- `.env.pilot`: `APP_DATABASE_URL` user=`iptv_app`, `DATABASE_URL`
  user=`iptv_owner`, `NODE_ENV=production`, `PORT=3001`, `LOG_LEVEL=info`,
  `PROVIDER_DISPATCH_MODE=durable`, adapters `manual/echo` (sem chamadas
  reais), `API_SCHEDULER_ENABLED` AUSENTE (=off por padrão; liveness confirma
  `"scheduler":"disabled"`), `LEGACY_OUTBOX_DRAIN_ENABLED` ausente no boot
  (=enabled, comportamento preservado), `NEXT_PUBLIC_API_BASE_URL` +
  `CORS/BETTER_AUTH_URL` = `https://iptv.synkroo.com.br`.

## 1. Build — OK (4/4)

```powershell
docker compose -p iptv-pilot --env-file deploy/staging/.env.pilot `
  -f $TEMP/opencode/iptv-pilot/docker-compose.pilot.yml build migrate api web outbox-worker
# 1ª tentativa: migrate/api falhou em tarball transitório do registry
# (ETIMEDOUT postgres-date); retry retomou do cache e concluiu.
# Image iptv-pilot-{migrate,api,web,outbox-worker}:local Built
# (ids curtos: migrate 14136195deea, api 7a4ac55776f0,
#  web 4721847f4b5e, outbox-worker 0d78657d83f9)
```

## 2. Subida — OK

```powershell
docker compose ... up -d postgres        # volume fresco iptv-pilot_pgdata, Healthy
docker compose ... run --rm migrate
# iptv-migrate: applied=59 skipped=0 total=59 dir=/app/db/migrations
# (senhas posicionadas via stdin, sem eco: ALTER ROLE iptv_app / outbox_worker)
docker compose ... up -d api web          # ambos Healthy (api após recreate §5 segue Healthy)
curl.exe http://127.0.0.1:3201/v1/health        → 200 (scheduler "disabled")
curl.exe http://127.0.0.1:3201/v1/health/ready  → 200 {"status":"ok","checks":{"database":"ok"}}
curl.exe http://127.0.0.1:3200/                 → 200
# re-run do migrate no `up`: applied=0 skipped=59 (no-op idempotente)
```

API subiu como `iptv_app` (o boot prova a senha + o guard fail-closed de
`APP_DATABASE_URL`; sem ela, recusa).

## 3. Provas no PG — OK (owner via socket)

`01-roles.sql` (em `$TEMP`, fora do repo):

```sql
SELECT usename, count(*) FROM pg_stat_activity WHERE datname='iptv' GROUP BY 1;
-- iptv_app 1 (pool da API) + iptv_owner 1 (a própria sessão psql da prova)
SELECT rolname FROM pg_roles WHERE rolbypassrls;  -- só iptv_owner (esperado)
SELECT mode, generation FROM platform.outbox_runtime_control WHERE id = 1;
-- LEGACY, 1 (seed da 051 — antes da ativação §5)
SELECT count(*) FROM platform.outbox_messages
  WHERE state='PUBLISHING' AND lease_expires_at IS NULL;
-- 0 (zero unfenced)
```

## 4. Seeds piloto — APLICADAS

```powershell
Get-Content db/seeds/001_pilot_baseline.sql | docker exec -i iptv-pilot-postgres `
  psql -U iptv_owner -d iptv -v ON_ERROR_STOP=1
# INSERT 0 1 (×N) ... COMMIT — sem erro, transacionada, verde sobre 059.
```

## 5. A/B funcional sob iptv_app — OK 4/4

Fixture owner `02-fixture.sql`: tenants `pilot-probe-a/b` + 1 person +
1 customer cada (UUIDs fixos, dispostos após as seeds). `03-ab-txn.sql` como
`iptv_app` (senha via variável de memória; blocos `BEGIN; SET LOCAL
app.tenant_id; …; COMMIT` — a disciplina real do app):

| Probe | Resultado |
|---|---|
| A-sees | 1 (só o próprio) |
| B-sees | 1 (só o próprio) |
| noctx-sees | 0 (fail-closed) |
| x-insert (ctx A, linha tenant B) | `ERROR` RLS violation → `ROLLBACK` |

Owner bypass: `owner-sees=2` nos tenants probe (seeds adicionam o 3º customer —
fora do filtro probe, esperado).

## 6. Ativação outbox via 051 — OK (LEGACY→QUIESCING→WORKER, gens 1→2→3)

Sessão platform-admin cunhada via SQL owner (`control.users`
`is_platform_admin=true` + `control.auth_sessions` com
`token_hash = sha256(BETTER_AUTH_SECRET:token)`; token em `$TEMP`, linhas
removidas ao fim — `ADMIN_PROBE_REMOVED`). Detalhe: a 1ª cunhagem usou pepper
aleatório e o API respondeu 401; recunhada com o pepper real → 200
(comportamento, não falha — o pepper é `BETTER_AUTH_SECRET` por desenho).

```powershell
# 1. zero legacy in flight ANTES (recreação mid-drain strandaria linhas)
curl.exe http://127.0.0.1:3201/v1/admin/outbox/drain-state
# → 200 {"enabled":true,"inFlight":0,"totalDrains":0,"lastFinishedAt":null}
# 2. LEGACY_OUTBOX_DRAIN_ENABLED=0 em .env.pilot + recreate imediato da api
docker compose ... up -d --force-recreate api   # Healthy
# 3. zero DEPOIS
curl.exe http://127.0.0.1:3201/v1/admin/outbox/drain-state
# → 200 {"enabled":false,"inFlight":0,"totalDrains":0,"lastFinishedAt":null}
# 4. autoridade DB (owner psql; geração observada, sem salto):
#    SELECT mode, generation ... → LEGACY, 1
#    SELECT platform.outbox_runtime_set('LEGACY','QUIESCING','pilot-operator',1);
#    → 2 (ativação começou em QUIESCING, nunca direto WORKER)
# 5. unfenced-zero + avanço:
#    SELECT count(*) ... PUBLISHING AND lease_expires_at IS NULL → 0
#    SELECT platform.outbox_runtime_set('QUIESCING','WORKER','pilot-operator',2);
#    → 3
# 6-8. worker (.env.pilot.outbox-worker LOCAL, OUTBOX_LEGACY_QUIESCED=1 +
#    OBSERVED drain-enabled=0/in-flight=0):
docker compose ... --profile outbox run --rm outbox-worker check
# → {"status":"ready","worker":"pilot-outbox-1",
#    "checks":["config","connect","role","activation"]}
docker compose ... --profile outbox run --rm outbox-worker run --once
# → {"status":"ok","claimed":0,"published":0,"failed":0,"stale":0,"empty":true}
docker compose ... --profile outbox up -d outbox-worker   # running + healthy
```

Sessões finais: `iptv_app` 1 (API) + `outbox_worker` 1 (loop) + `iptv_owner` 1
(probe). Estado final: modo `WORKER`, geração `3`;
`platform.outbox_messages` vazia (0 linhas — smoke foi read-only, nenhum lease
pendente). Scheduler OFF (`API_SCHEDULER_ENABLED` ausente; liveness
`"scheduler":"disabled"`).

## 7. Tunnel cloudflared — ingress editado, SEM restart

`$HOME\.cloudflared\config-iptv.yml`: `service: http://127.0.0.1:3001` →
`http://127.0.0.1:3201` (só o ingress de `iptv.synkroo.com.br`; mais nada no
arquivo). Tunnel NÃO reiniciado (ato do planner) — a URL pública passa a
servir o piloto após o restart do operador.

## 8. Estado final do lane

`iptv-pilot-{postgres,api,web,outbox-worker}` UP e healthy; api `:3201`,
web `:3200` (loopback). Seeds + fixtures probe no banco descartável; sessão
admin removida. Lane preservado para o piloto; destruir com
`docker compose -p iptv-pilot … down -v` (só volumes `iptv-pilot_*`).

## Limitações explícitas do escopo

- Sem conversa sintética via HTTP (smoke foi A/B via SQL + drain-state via
  admin; nenhum publish/retry/reclaim com dados — `run --once` vazio prova o
  caminho, não o volume).
- Sem backup/restore drill neste lane (coberto no STAGING-P0).
- Sem RPO/RTO, sem browser-worker, sem PgBouncer neste lane.
- Pagamentos seguem echo/manual até M4/M5 (adapters `manual/echo`, sem
  tráfego real nem dinheiro real).
- TLS público depende do restart do tunnel pelo planner/operador.
