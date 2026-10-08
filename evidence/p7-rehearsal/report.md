# P7 dress rehearsal — evidence report (lane descartável `iptv-rehearsal`)

> TASK_ID: P7-REHEARSAL · branch `closure/p7-rehearsal` · 2026-10-08.
> Isolamento: projeto docker `iptv-rehearsal` (nunca tocou dev/staging/cutover/pg-test);
> postgres dedicado `iptv-rehearsal-postgres` em `127.0.0.1:5439`, volume
> `iptv-rehearsal-pgdata`; API em `127.0.0.1:3211`, web em `127.0.0.1:3210`.
> Segredos: só processo-local/`PGPASSWORD` de comando e chave drill-only em
> arquivo 0600 fora do repo (triturados no cleanup); nenhum valor neste relatório.
> WhatsApp real NÃO usado — inbound é webhook sintético na API local (gap declarado).
> Lives M1/M2/B1/G07 NÃO executados.

## 1. Lane fresca 001–059 + seeds + api(`iptv_app`)/web

```powershell
docker run -d --name iptv-rehearsal-postgres -e POSTGRES_DB=iptv -e POSTGRES_USER=iptv \
  -p 127.0.0.1:5439:5432 -v iptv-rehearsal-pgdata:/var/lib/postgresql/data postgres:17-alpine
# 59 migrations aplicadas via psql (ON_ERROR_STOP=1): MIGRATIONS_APPLIED=59 FAILURES=0
# seeds: db/seeds/001_pilot_baseline.sql → SEED_DONE (1 conversation)
# roles: iptv / iptv_app / outbox_worker / outbox_executor presentes; iptv_app NOBYPASSRLS
# platform.migration_history backfilled com sha256 idêntico ao runner
#   (verificado: c51165d9…==c51165d9… em 001) para os suites reusarem a lane
Invoke-RestMethod http://127.0.0.1:3211/v1/health/ready  # {"status":"ok","checks":{"database":"ok"}}
```

API correu como `iptv_app` (`APP_DATABASE_URL`, NOBYPASSRLS, RLS valendo);
scheduler on (tick 10s), `LEGACY_OUTBOX_DRAIN_ENABLED=0`, `ASAAS_ADAPTER=echo`,
sem `WAHA_*` (LocalEcho) e sem `OPENAI_API_KEY` (Echo gateway).
Web rebuildada com `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3211`
(`pnpm --filter @iptv/web build` OK; `897-*.js` contém `127.0.0.1:3211`;
`next start` em :3210 → `GET /` 200, 5772 bytes; nota: `next start` emitiu
o warning `output: standalone` (usar `node .next/standalone/server.js` no
caminho produtivo) mas serviu o build do rehearsal normalmente.

## 2. Fluxo simulado ponta-a-ponta (live HTTP + suites)

Live (`p7-live-waha`, tenant `01a1197d-e15f…`):

| Perna | Comando literal | Resultado |
|---|---|---|
| register | `POST /v1/auth/register {email,tenantName}` | 201 + token + tenant |
| canal | `INSERT INTO communication.tenant_channels … 'p7-live-waha'` (hash sha256) | 1 canal ACTIVE |
| inbound#1 | `POST /v1/webhooks/waha/p7-live-waha` (wamsg-p7-001, sender inédito) | 202 `{"accepted":true,"deduped":false}` → inbox 1 PROCESSED + exception 1 OPEN (quarentena, sem attach silencioso) |
| duplicate | mesmo POST outra vez | 202 `{"accepted":true,"deduped":true}`; inbox continua 1 linha |
| person | `POST /v1/crm/persons {canonicalName, WHATSAPP 5511999888777}` | 201 id |
| exception resolve | `POST …/exceptions/:id/resolve {"action":"map","personId"}` | 201 `status:RESOLVED` + conversationId |
| inbound#2 | POST wamsg-p7-002 (mesmo sender) | 202 + `INBOUND wamsg-p7-002` na conversa |
| reply | `POST …/conversations/:id/send-manual` | 201 `deliveryStatus:SENT`, `providerMessageId:echo:8ddd…` |
| copilot | `POST /v1/agent/copilot/ask {question,screen:{route:/crm}}` | 201 `confidence:OBSERVED` (determinístico, sem modelo) |

Suites na lane (`TEST_DATABASE_URL` = lane; 11 arquivos, **105/105 PASS**):

| Arquivo | n | Cobre (pernas) |
|---|---|---|
| golden-loop | 3 | legs a-b (inbound→lead/person/conversa→trial ACTIVE), c-f (offer→order→charge settled→subscription→renewal→ticket), g (isolamento) |
| commerce-billing | 16 | quote→charge→webhook PAID→settled; duplicate no-op; tampered→exception; stale approval rejeitada; refunds concorrentes; cross-customer negado; UNKNOWN→reconcile; chargeback; **charge PENDING para no echo (B1 bloqueado — sem PIX sandbox)** |
| subscription-fulfillment | 9 | fulfillment manual/echo → subscription ACTIVE |
| renewal-retention | 16 | renewal/reminder/recovery |
| support-hitl-center | 6 | ticket→HITL claim/decide→recovery |
| provider-dispatch | 19 | timeout→VERIFYING/UNKNOWN, sem reexecução |
| trial-compat | 9 | trial lifecycle + compat |
| scheduler | 4 | tick (due + drains; 1 falha não mata as demais) |
| billing-rls-rehearsal | 5 | RLS sob `iptv_app` |
| agent-model-failure | 6 | falha de modelo→recusa ruidosa; determinístico imune; modelo saudável recupera |
| waha-f05-f06 | 12 | F05/F06 unit |

## 3. Drills (estímulo → observado → recuperação → tempo)

| Drill | Estímulo | Observado | Recuperação | Tempo |
|---|---|---|---|---|
| WAHA down | `WAHA_BASE_URL=http://127.0.0.1:3999` (morto) + `send-manual` | 201 `deliveryStatus:FAILED`, `providerMessageId:null`, 0.1s, 1 tentativa; conversa OPEN; inbound#3 202 + ingerido (inbound imune) | reboot echo → `SENT echo:273d…`, 0.1s | ~2 min (2 reboots) |
| Provider down | porta travada (suite, lane) | VERIFYING/UNKNOWN via timeout de envio; nunca FAILED; nunca reenvia | `reconcile`/`recoverOnce` convergem; sem 2º send | suite 6.3s |
| DB restart | `docker restart iptv-rehearsal-postgres` | scheduler `terminating connection…`; **API caiu (pg Client `error` não tratado, exit 1)** — achado §4 | reboot API → ready 200; contagens iguais (conv=43 msg=56 inbox=72 outbox=879), zero perda | restart 5.5s; recovery ~30s |
| Worker kill | `run` loop (lease 8s) + `Stop-Process -Force` (kill -9) | processo morto (exit 1); linha PUBLISHING retida; `--once` com lease vivo → `claimed:0` (fence segura) | pós-expiração `--once` → `claimed:1/published:1`; 881 PUBLISHED, 0 stranded | lease 60s + reclaim ~5s |
| Model outage | sem chave (Echo) + suite F07 | live `copilot/ask` 201 determinístico; suite: falha→recusa ruidosa, determinístico imune, saudável recupera | gateway Echo/fallback declarado (sem live chave+endpoint morto — gap) | suite 1.3s |
| Duplicate webhook | re-POST idêntico (WAHA live + Asaas suite) | live `deduped:true`, 1 linha inbox; suite: duplicate Asaas no-op | n/a (idempotente por construção) | imediato |
| Stale approval | suite: aprovação velha (pagamento drenado por outro refund) | execute rejeita como stale | nova aprovação requerida (caminho existe; re-execução pós-stale NÃO exercitada live — limite) | suite 13.2s |
| Backup restore | `backup-dr.sh drill iptv-rehearsal-postgres iptv iptv <tmp>` (reuso P6) | **DRILL PASS 296s**; pré==pós (59 migrations, outbox 881 PUBLISHED, ledger 330400=330400, postura 050 intacta); gate canônico 59==59; WARN `no manifest sidecar` (limite) | destroy foi no second-site; origem intacta; ready 200 pós-drill | 296s |
| Secret rotation | `ALTER ROLE iptv_app/outbox_worker PASSWORD` + reload | 0 claims stranded pré (0 PUBLISHING); API+worker rebootados nas novas URLs | ready ok + worker `check ready` + `send-manual SENT`; sessão antiga sobrevive (sessões são DB-backed) | ~1 min |

## 4. Achados (follow-up, não falha escondida)

1. **API não sobrevive a restart do DB**: `pg` Client emite `error` não tratado →
   queda do processo (exit 1). Fail-closed (sem corrupção; contagens iguais), mas
   recovery exige restart do processo (compose `restart:` cobre). Recomendação:
   handler de `error` no pool + reconexão com backoff (dono: Planner).
2. **Higiene do suite `billing-rls-rehearsal`**: ele troca a senha de `iptv_app`
   por aleatória e a zera (`PASSWORD NULL`) no fim — um boot da API entre o run
   e uma re-senha falha com 28P01 (observado, diagnosticado, re-senhado; sem defeito).
3. **Leituras de conversa divergem do DB**: `GET /v1/communications/conversations`
   → `[]` e copilot `0 conversa(s) aberta(s)` com 1 conversa OPEN no tenant
   (write/reply funcionam). Possível scoping de read-model; fora do escopo infra —
   dono Planner.
4. Backup WARN `no manifest sidecar` (gate de integridade pulado; shas de
   offsite put/get verificados mesmo assim).
5. `billing-rls-rehearsal` + este lane provam `iptv_app` ponta a ponta; cutover
   produtivo continua dono do operador (runbook existente).

## 5. Validação

- `pnpm --filter @iptv/api exec vitest run <11 arquivos> --reporter=basic` →
  `Test Files 11 passed`, `Tests 105 passed`, Duration 140.81s
  (log compacto: `suites-summary.log`; nenhum teste novo criado).
- Comandos literais + resultados nas tabelas acima (detalhes curtos em `drills.log`).
- `python scripts/validate_docs.py` → verde (nenhum contrato/registry tocado).
- `git status`: só `evidence/p7-rehearsal/*` + `docs/16-pilot-closure/P7-REHEARSAL.md`
  como novos (3 docs modificados pré-existentes no branch intocados); sem commit/push.
- Cleanup: web+API parados; chave 0600 + workdir do drill triturados;
  lane destruída (`docker rm` + `docker volume rm iptv-rehearsal-pgdata`) após evidência.
