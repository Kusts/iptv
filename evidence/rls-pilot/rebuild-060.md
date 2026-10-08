# PILOT-REBUILD — lane piloto reconstruída no main atual 001–060 (dados preservados)

TASK_ID `PILOT-REBUILD`. Main `bceea8b` (merge #30, billing binding 060).
Runbooks: `staging-deploy.md` + `rls-role-split-cutover.md` (051) + `P8-PILOT.md`
(só ativação 051 + smoke; tráfego real é ato do operador — fora deste escopo).

Isolamento: projeto compose `-p iptv-pilot` apenas; cópia operacional em
`$TEMP/opencode/iptv-pilot/docker-compose.pilot.yml` (container `iptv-pilot-*`,
imagens `iptv-pilot-*:local`, host ports `3201/3200`). Volumes
`iptv-pilot_pgdata` + rede `iptv-pilot_internal` próprios. Lanes
`iptv-staging-*` (:3000/:3001), `iptv-cutover-*` (:3100/:3101) e dev nunca
tocados — todos os containers seguiam UP ao fim (ver §8).

Disciplina de segredos: valores reais SOMENTE em
`deploy/staging/.env.pilot` + `deploy/staging/.env.pilot.outbox-worker`
(gitignored, reutilizados — nenhuma senha regenerada, nada impresso).
Senhas de papéis trafegaram em memória/stdin. Sessão admin cunhada via SQL
owner, token em `$TEMP`, linhas removidas ao fim (`ADMIN_PROBE_REMOVED`).
Dump seletivo em `$TEMP\opencode\iptv-pilot-rebuild-060\` (fora do repo),
destruído após a re-importação (§9). Este relatório contém 0 segredos
(só contagens, UUIDs preservados, modos e status HTTP).

## 0. Pré-voo

- `compose config --quiet` (cópia TEMP) → `CONFIG_OK`.
- Pré-destroy: `platform.migration_history` = 59; runtime `WORKER` gen 3;
  outbox vazia; `membership_roles` do tenant = 0 (nada a preservar ali).
- `.env.pilot`: `APP_DATABASE_URL` user=`iptv_app`, `DATABASE_URL`
  user=`iptv_owner`, `NODE_ENV=production`, `LOG_LEVEL=info`,
  `PROVIDER_DISPATCH_MODE=durable`, adapters `manual/echo`, scheduler off,
  URLs públicas `https://iptv.synkroo.com.br`. `LEGACY_OUTBOX_DRAIN_ENABLED`
  foi a `1` antes do boot fresco (para a re-ativação literal §5) e voltou a
  `0` ao fim — mesmo valor de antes do rebuild.

## 1. Preservação PRÉ-destroy — OK (8 linhas, 6 arquivos CSV)

```powershell
# COPY seletivo (só dados do tenant slug synkroo-iptv) para /tmp no container,
# depois docker cp para $TEMP (fora do repo). Colunas explícitas, sem segredos
# impressos — só contagens COPY de retorno:
\copy (SELECT ... FROM control.tenants WHERE slug='synkroo-iptv') ...          # COPY 1
\copy (SELECT ... users JOIN memberships JOIN tenants WHERE slug=...) ...      # COPY 1
\copy (SELECT ... auth_credentials JOIN ... WHERE slug=...) ...                # COPY 1
\copy (SELECT ... tenant_memberships JOIN tenants WHERE slug=...) ...          # COPY 1
\copy (SELECT ... tenant_channels WHERE tenant_key='synkroo-iptv') ...         # COPY 1
\copy (SELECT ... exceptions JOIN tenants WHERE slug=... AND status='OPEN')   # COPY 3
```

| Tabela (filtro) | Pré |
|---|---|
| `control.tenants` (slug `synkroo-iptv`, id `01a11c34-…ebc17d`) | 1 |
| `control.users` (do tenant) | 1 |
| `control.auth_credentials` (do usuário) | 1 |
| `control.tenant_memberships` (do tenant) | 1 |
| `billing.tenant_channels` (`tenant_key synkroo-iptv`, id `7071ecbf-…a7c03`, ASAAS/ACTIVE, hash len 64) | 1 |
| `billing.exceptions` (do tenant, `OPEN`: 3× `UNKNOWN_CHARGE`) | 3 |

## 2. Destroy + rebuild — OK

```powershell
docker compose -p iptv-pilot --env-file deploy/staging/.env.pilot `
  -f $TEMP/opencode/iptv-pilot/docker-compose.pilot.yml down -v
# removeu iptv-pilot-{web,api,migrate,postgres} + volume pgdata; o worker do
# perfil outbox exigiu 2º down com --profile outbox (mesmo projeto) + rede.
# Nenhum outro projeto/volume tocado (nomes confirmados antes).
docker compose ... build migrate api web outbox-worker   # 4/4 do main atual
docker compose ... up -d postgres                         # volume fresco, Healthy
docker compose ... run --rm migrate
# iptv-migrate: applied=60 skipped=0 total=60 dir=/app/db/migrations
# (senhas iptv_app/outbox_worker posicionadas via stdin dos .env existentes)
docker compose ... up -d api web                          # ambos Healthy
curl.exe http://127.0.0.1:3201/v1/health        → 200 (scheduler "disabled")
curl.exe http://127.0.0.1:3201/v1/health/ready  → 200 {"status":"ok","checks":{"database":"ok"}}
curl.exe http://127.0.0.1:3200/                 → 200
```

PG (owner): API pool = `iptv_app` 1 sessão; `BYPASSRLS` = só `iptv_owner`;
runtime `LEGACY` gen 1; unfenced-zero 0.

## 3. Seeds + re-importação — OK (diff zero)

```powershell
Get-Content db/seeds/001_pilot_baseline.sql | docker exec -i iptv-pilot-postgres `
  psql -U iptv_owner -d iptv -v ON_ERROR_STOP=1 -q   # sem erro (pilot-synthetic; sem colisão)
# CSVs de volta ao container + \copy FROM com mesmos ids (sem ON CONFLICT —
# qualquer colisão abortaria; nenhuma ocorreu):
\copy control.tenants (...) FROM ...                 # COPY 1
\copy control.users (...) FROM ...                   # COPY 1
\copy control.auth_credentials (...) FROM ...        # COPY 1
\copy control.tenant_memberships (...) FROM ...      # COPY 1
\copy billing.tenant_channels (...) FROM ...        # COPY 1 (hash verbatim por round-trip)
\copy billing.exceptions (...) FROM ...             # COPY 3
```

| Tabela | Pré | Pós | Ids pós (iguais ao pré) |
|---|---|---|---|
| tenants | 1 | 1 | `01a11c34-…ebc17d` |
| users | 1 | 1 | mesmo id pré-destroy |
| auth_credentials | 1 | 1 | mesmo id; hash len 178 |
| tenant_memberships | 1 | 1 | mesmo id |
| tenant_channels | 1 | 1 | `7071ecbf-…a7c03`, hash len 64 |
| exceptions OPEN | 3 | 3 | `01a11c3a-…`, `01a11ca6-…`, `01a11ca9-…` |

Diff de contagens: **0 em todas as linhas**; ids e comprimentos de hash idênticos.

## 4. A/B funcional sob iptv_app — OK 2/2 (read-only, sem escrita no lane real)

```sql
-- como iptv_app, SET LOCAL app.tenant_id = <synkroo-iptv>:
SELECT count(*) FROM billing.exceptions WHERE status='OPEN';  -- 3 (só o próprio)
-- sem contexto:
SELECT count(*) FROM billing.exceptions WHERE status='OPEN';  -- 0 (fail-closed)
```

| Probe | Resultado |
|---|---|
| ctx synkroo | 3 (as linhas preservadas, via RLS) |
| noctx | 0 (fail-closed) |

## 5. Ativação outbox via 051 — OK (LEGACY→QUIESCING→WORKER, gens 1→2→3)

Sessão platform-admin cunhada via SQL owner (token em `$TEMP`, removida ao fim).

```powershell
curl.exe http://127.0.0.1:3201/v1/admin/outbox/drain-state
# → 200 {"enabled":true,"inFlight":0,"totalDrains":0,"lastFinishedAt":null}
# LEGACY_OUTBOX_DRAIN_ENABLED=0 em .env.pilot + recreate imediato da api → Healthy
curl.exe http://127.0.0.1:3201/v1/admin/outbox/drain-state
# → 200 {"enabled":false,"inFlight":0,"totalDrains":0,"lastFinishedAt":null}
# SELECT mode, generation ... → LEGACY, 1
# SELECT platform.outbox_runtime_set('LEGACY','QUIESCING','pilot-rebuild-operator',1); → 2
# SELECT count(*) ... PUBLISHING AND lease_expires_at IS NULL → 0 (unfenced-zero)
# SELECT platform.outbox_runtime_set('QUIESCING','WORKER','pilot-rebuild-operator',2); → 3
docker compose ... --profile outbox run --rm outbox-worker check
# → {"status":"ready","worker":"pilot-outbox-1","checks":["config","connect","role","activation"]}
docker compose ... --profile outbox run --rm outbox-worker run --once
# → {"status":"ok","claimed":0,"published":0,"failed":0,"stale":0,"empty":true}
docker compose ... --profile outbox up -d outbox-worker   # running + healthy
```

Sessões finais: `iptv_app` 1 (API) + `outbox_worker` 1 (loop `outbox-worker`) +
`iptv_owner` 1 (probe, depois removida). Modo `WORKER`, geração `3`.
`ADMIN_PROBE_REMOVED` (0 users/sessions do probe).

## 6. Smoke — OK

- Login preservado via API: `POST /v1/auth/login` com senha incorreta → **401**
  (prova que a credencial preservada está viva e a verificação executa; o login
  positivo com a senha temporária é ato do operador — NÃO resetada, NÃO impressa).
- `drain-state` em WORKER → `enabled:false,inFlight:0`.
- `ready` público via tunnel (sem tocar no tunnel):
  `https://iptv.synkroo.com.br/v1/health/ready` → **200 `{"status":"ok",…}`**.
- `migrate` re-run → `applied=0 skipped=60` (no-op idempotente).

## 7. Estado final do lane

`iptv-pilot-{postgres,api,web,outbox-worker}` UP e healthy; api `:3201`, web
`:3200` (loopback). Main 001–060 + seeds + 8 linhas preservadas (mesmos ids).
Tunnel segue apontando `:3201` (não tocado).

## 8. Lanes alheios — intocados

`iptv-staging-{postgres,api,web}`, `iptv-cutover-{postgres,api,web,pgbouncer}`,
`iptv-pg-test`, `iptv-dr-site-1803` todos UP ao fim; `down -v` operou só
recursos de nome `iptv-pilot_*`.

## 9. Limpeza

CSVs `/tmp/preserve_*.csv` removidos do container; diretório
`$TEMP\opencode\iptv-pilot-rebuild-060\` (incl. `admin-token.txt`) destruído.
Única mudança no repo: este relatório.

## Limitações explícitas do escopo

- Sem login positivo (senha temporária com o operador).
- Sem publish/retry/reclaim com dados (`run --once` vazio prova o caminho).
- Sem backup/restore drill neste lane (coberto no STAGING-P0).
- Sem PgBouncer/browser-worker neste lane; pagamentos seguem echo/manual.
