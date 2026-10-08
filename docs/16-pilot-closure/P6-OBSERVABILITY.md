# P6 — Observabilidade real (parte 2: OTLP + alertas + runbooks)

> TASK_ID: CODER-P6B · branch `closure/p6-hardening` · SPEC C7/C8 (fatia 2)
> **Nada de P6a foi tocado.** Mudança de runtime nesta slice, declarada:
> `packages/observability` ganha fiação OTLP real (SDK instalado, construção
> só com endpoint configurado) + hook `emitLog` + `shutdownObservability`;
> `apps/api` e workers **não** mudam nenhum call site (assinaturas
> preservadas; default continua noop, zero overhead, zero rede).

## 1. Export OTLP ativável por env — PROVADO

Ativação (nada mais é preciso; sem endpoint, tudo abaixo é inerte):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_SDK_DISABLED=false            # default true = noop
OTEL_METRIC_EXPORT_INTERVAL_MS=60000  # opcional (default 60 s)
```

O que foi ligado em `packages/observability/src/index.ts`
(`configureOtlp`, antes um stub que lançava): `NodeTracerProvider` +
`BatchSpanProcessor` + OTLP/HTTP traces; `MeterProvider` +
`PeriodicExportingMetricReader` + OTLP/HTTP metrics com os dois counters
existentes espelhados (`commands_executed_total`, `webhooks_received_total`);
`LoggerProvider` + batch + OTLP/HTTP logs atrás do novo `emitLog(level, msg,
attrs)` (stdout JSON sempre; OTLP só quando habilitado; attrs sanitizados
pela mesma denylist — nunca payloads/secrets/tokens). `main.ts` da API não
muda: `initObservability()` sem args já lê o env. `shutdownObservability()`
dá flush (traces+métricas+logs) e devolve ao noop — usado no proof e em
testes.

**Prova executada** (`scripts/otlp-proof.mjs`: stub OTLP/HTTP local +
init real + 1 span + counters + 1 log + flush; tudo em loopback, sem rede
externa, sem credencial):

- `RECEIVED /v1/traces: 1 request(s), 809 byte(s)`
- `RECEIVED /v1/metrics: 3 request(s), 3585 byte(s)`
- `RECEIVED /v1/logs: 1 request(s), 845 byte(s)`
- `OTLP-PROOF PASS` — e a linha stdout carrega `trace_id` correlacionado
  (`{"level":"info","msg":"p6b otlp proof log","trace_id":"8aaea…","component":"otlp-proof"}`).

Instrumentação que já alimenta o pipeline sem call-site novo: `CommandBus`
(command+tenant+code), ingress Asaas/WAHA (provider+outcome), scheduler,
gateway e port Asaas via `withSpan`. **Declarado como hook mínimo que
falta**: o `@iptv/outbox-worker` mantém métricas próprias (`metrics.ts` +
`toSafeLog()`, sem ponte OTLP) — o worker é coberto pelos alertas SQL de
lease/backlog (§2), não por export; a ponte worker→OTLP é follow-up, sem
SLO falso.

## 2. Alertas (thresholds PILOT_CALIBRATE + resposta curta)

Execução: `bash scripts/ops-alert-check.sh <container> <db-user> <db-name>
[api-base-url] [backup-dir]` — exit 0 limpo, 1 com breach (WARN conta
separado). Sweep medido no staging em 2026-10-08: **16 checks, 0 WARN, 0
CRIT, `ALERT-SWEEP CLEAR`**; controle negativo (porta morta) dispara os 2
CRITs de API e exit 1; `backup_fresh` contra o dir do drill: `newest archive
257s old` → OK.

| Alerta | Threshold (warn / crit) | Mede | Resposta (runbook) |
|---|---|---|---|
| `api_live` | != 200 / lat > 2 s (crit direto) | `GET /v1/health` | `database-degraded.md`: liveness não depende do DB — se caiu, é o processo (restart + logs) |
| `api_ready` | != 200 / lat > 2 s (crit direto) | `GET /v1/health/ready` (probe `SELECT 1` ≤ 2 s) | `database-degraded.md`: fora do LB, checar pool/DB |
| `db_connections` | > 80% / > 90% de `max_connections` | `pg_stat_activity` | `database-degraded.md`: caçar idle-in-tx + pooler (`pgbouncer` profile `pooling`) |
| `db_blocked` | > 0 / > 5 lock-waiters | `wait_event_type='Lock'` | `database-degraded.md`: `pg_blocking_pids`, kill cirúrgico, revisar migração |
| `db_oldest_tx` | > 5 min / > 15 min idle-in-transaction | `xact_start` | `database-degraded.md`: fechar transação órfã no app |
| `outbox_backlog` (+ age) | > 100 rows ou age > 5 min / > 1000 ou > 15 min | `PENDING`/`FAILED` count + `max(now-created)` | `outbox-workflow-backlog.md`: drain legado vs worker, `drain-state`, quiescence |
| `outbox_lease` (worker) | > 0 / > 50 leases expirados não reclamados | `PUBLISHING` com `lease_expires_at < now()` | `outbox-workflow-backlog.md`: worker parado ou fence perdido; checar `check` do compose |
| `inbox_queue_age` | > 5 min / > 15 min RECEIVED | `max(now-received)` | `payment-webhook-failure.md`: consumer parado, replay seguro (idempotente) |
| `inbox_stuck` | > 0 PROCESSING > 15 min (warn) | `inbox_stuck_list` equivalente | `rls-role-split-cutover.md#inbox-stuck-rows`: requeue manual 1-a-1, sem auto-reclaim |
| `inbox_unknown` | > 0 não processados (warn) | `event_type ILIKE '%unknown%'` em RECEIVED/PROCESSING | `payment-webhook-failure.md`: mapear normalizer, nada é descartado sem registro |
| `provider_hitl` | > 0 (warn) | `HUMAN_REQUIRED` | `provider-down.md`: triar operação, completar/cancelar com `completed_at` |
| `provider_unknown` | > 0 com > 30 min (warn) | in-flight com `effect_certainty='UNKNOWN'` e `requested_at` antigo | `reconciliation-drift.md`: verificar efeito no provider antes de reemissão (nunca replay cego) |
| `hitl_backlog` / `hitl_overdue` | > 5 / > 20 abertos; > 0 após `sla_due_at` (warn) | `human_review_requests` abertas | `hitl-backlog.md`: fila por `priority`, escalar URGENT |
| `reconcile_drift` | > 0 OPEN (warn) / > 10 ou oldest > 24 h (crit) | `reconciliation_findings` | `reconciliation-drift.md`: conciliar origem, resolver com `resolution_ref` |
| `backup_fresh` | > 30 min (warn) / > 2 h (crit) | manifest `.dump.enc` mais novo | `backup-restore.md` + `P6-DR.md`: cron parado ou disco cheio; sem backup fresco não há RPO |

Sem SLO sem mecanismo: latência p95 de comando autenticado, ack de webhook
com segredo válido e latência de provider **não têm probe** (sem credencial
de staging / sem provider live) — estão como gaps em `P6-PERFORMANCE.md` e
**não** geram SLO aqui. Worker OTLP idem (§1).

## 3. Como ativar no staging (operador)

1. Subir um coletor OTLP/HTTP no host (fora deste repo; ex. `otelcol`
   com receiver `otlphttp` em `:4318`).
2. Em `.env.staging`: `OTEL_EXPORTER_OTLP_ENDPOINT=http://<coletor>:4318`
   e `OTEL_SDK_DISABLED=false` (ambos; ausência de qualquer um = noop
   com warning, boot nunca quebra).
3. Recriar a API, rodar `node scripts/otlp-proof.mjs --port <receiver>`
   contra um stub para validar o caminho, depois apontar ao coletor e
   confirmar 1 trace + métricas + 1 log no backend.
4. Agendar `ops-alert-check.sh` (cron do host, ex. a cada 5 min) com o
   `backup-dir` do schedule assim que `backup-dr.sh backup` estiver
   agendado; wire o exit 1 ao canal do operador.

## 4. Validação desta slice

- `otlp-proof.mjs` → **PASS** (1/3/1 sinais, bytes literais acima).
- `ops-alert-check.sh` → **CLEAR 16/16** no staging + controle negativo
  com 2 CRITs + `backup_fresh` OK contra evidência do drill.
- `@iptv/observability`: `build` + `typecheck` + `lint` + `test` **12/12**
  (incl. `emitLog`/shutdown no noop + espelho de counters sem throw).
- `python scripts/validate_docs.py` verde (links só para arquivos
  existentes; sem vocabulário de eventos tocado).
