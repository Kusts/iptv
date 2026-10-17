# P6 — Performance / carga representativa (parte 2)

> TASK_ID: CODER-P6B · branch `closure/p6-hardening` · SPEC C7/C8 (fatia 2)
> Metodologia + resultados literais + assumptions. **Nada de P6a foi
> tocado.** O que não foi medido está declarado como gap — sem SLO sem
> mecanismo.

## 1. Metodologia e assumptions de capacidade

- **API** (`scripts/load/api-load.mjs`, stdlib-only, closed-loop N reqs /
  concorrência C, latência por path + mix de status + rps alcançado): mede
  forma de saturação/latência, **não** soak nem jornada autenticada.
- **Outbox/worker/lease sob volume** (`scripts/load/outbox-volume.sh`):
  container descartável + **todas** as `db/migrations/*.sql` em ordem +
  cutover ensaiado (LEGACY→QUIESCING→WORKER via CAS, scratch-only) + volume
  sintético, depois `EXPLAIN (ANALYZE)` dos predicados + throughput de
  `outbox_claim` como `outbox_worker` + idade de fila + headroom de pool
  sob 8 claimers paralelos.
- Assumptions registradas: payloads `jsonb` pequenos (`{"n":1}`); volume
  100k PENDING + 20k PUBLISHING expirados + 10k PUBLISHING vivos (+50k
  PUBLISHED de realismo); host = estação do operador (não hardware de
  produção); staging com DB quase vazio para a parte HTTP; concorrência
  20 (HTTP) / 8 (claimers).
- Targets de referência (não SLAs):
  `docs/15-implementation-baseline/13-nfr-slo-dr.md` — reads p95 ≤ 500 ms,
  comandos síncronos p95 ≤ 800 ms, ingestão de webhook p95 ≤ 2 s.

## 2. Resultados API (staging, 2026-10-08 — 600 reqs, C=20, 580,3 rps)

| Path | n | status | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| `GET /v1/health` (sem DB) | 200 | 200 ×200 | 16,4 ms | 70,0 ms | 165,5 ms | 237,2 ms |
| `GET /v1/health/ready` (probe `SELECT 1`) | 200 | 200 ×200 | 25,2 ms | 100,3 ms | 274,6 ms | 276,0 ms |
| `POST /v1/webhooks/asaas/no-such-tenant` | 200 | **500 ×200** (ver §4) | 25,4 ms | 143,9 ms | 232,2 ms | 279,2 ms |

`ERRORS=0` (sem timeout/socket — os 500 são resposta HTTP válida do app).
Leituras p95 (70/100 ms) cabem no target de 500 ms com folga neste host.

## 3. Resultados outbox/lease/worker sob volume (scratch, 130k rows ativas)

- **Lease-reclaim usa `outbox_lease_recovery_idx`** (critério de aceite):
  `Bitmap Index Scan`, 20.000 rows, `shared hit=483`, **Execution Time
  2,487 ms**.
- Dreno de PENDING usa `outbox_pending_idx`: `Index Scan`, 100 rows,
  **0,176 ms** (contraste registrado; índice 001 preservado).
- **Claim throughput como `outbox_worker`**: 2.000 rows em 6.919 ms =
  **289 claims/s** (20 batches de 100, leases fresh); reclaim de expirados:
  1.000 rows em 3.269 ms = **305 claims/s**. Ordem de grandeza: drenar 100k
  backlog levaria ~6 min a este ritmo single-claimer (sem paralelismo de
  workers, sem publish real — piso, não teto).
- Idade de fila: query `max(now-created)` sobre PENDING/FAILED em **297 ms**
  (valor 24 s = timing do seed, não backlog real).
- Pool: pico **14/100 backends** sob 8 claimers paralelos — headroom amplo
  neste volume; saturação de pool (`db_connections` > 80/90%) fica para soak
  com publish real.

## 4. Gaps honestos (sem medição, sem SLO)

1. **Comando autenticado p95**: sem credencial de staging nesta sessão, não
   há jornada com sessão — o p95 de `POST` acima é piso de roteamento, não
   custo de comando. Re-medir com sessão válida após re-migração do staging.
2. **Webhook ack com segredo válido**: o path medido devolve **500, não
   404** — artefato de drift: staging está em **051** e `resolveChannel` lê
   `billing.tenant_channels` sob RLS de `iptv_app` (grants vieram na **052**),
   logo `aclcheck_error` → 500 genérico. Fail-closed (corpo genérico, sem
   leak, `x-trace-id` presente), mas o ack nominal (202) e o 404 precisam de
   re-medição com staging em 052+. Nenhum SLO de webhook é alegado aqui.
3. **Latência provider (read-path)**: medição fechada na janela Contabo
   2026-10-17 (180 amostras/endpoint, 100% ok, `GET /api/sessions` p95
   24,9 ms / `GET /api/sessions/ted` p95 21,1 ms) — ver
   [provider-live-read-window-20261017.md](../../evidence/p3-waha/provider-live-read-window-20261017.md).
   Caveats: localhost→container no próprio Contabo (NÃO representa o caminho
   público Traefik/Cloudflare); read-only, sem envio; PII descartada.
   Fulfillment p95 e challenge/drift PERMANECEM BLOCKED (exigiriam envio —
   não autorizado).
4. **Worker throughput ponta a ponta**: o número acima é claim SQL; publish
   real (transporte) + loop do worker + scheduler em carga ficam para soak
   com staging re-migrado.
5. **Staging atrás do HEAD** (51 vs 59 migrations, ver `P6-DR.md` §5):
   re-migrar 052–059 e **re-rodar os três scripts** antes de transformar
   qualquer número acima em SLO.

## 5. Validação desta slice

- `api-load.mjs` (600/C20) → tabela §2, `ERRORS=0`.
- `outbox-volume.sh` (100k/20k/10k) → exit 0, índice provado por plano
  (`Bitmap Index Scan … Execution Time: 2.487 ms`), claims/s literais.
- `python scripts/validate_docs.py` verde (este doc não toca registry nem
  referencia arquivo inexistente).

## 6. Re-provision e re-medição (staging FRESH, 2026-10-17)

Stack anterior inexistente (`down -v`): re-provision FRESH em 2026-10-17 na
revisão `fb06e9ee` com **60/60 migrations** + no-op idempotente no re-run.
Números abaixo são runs do operador no host em 2026-10-17 (artefatos
host-local, fora do repo); scripts em `scripts/load/`
(`api-load.mjs`, `outbox-volume.sh`, `scheduler-soak.mjs` rev. `ba91091`).

- **Migrate**: 60/60 aplicadas + no-op idempotente no re-deploy.
- **DRILL**: `db-restore-drill` verde 60/60, **DRILL PASS em 25 s**
  (ver §5 do `P6-DR.md` — origem == HEAD, drill re-confiável).
- **API load** (600 reqs, C=20): **rps 268,5, ERRORS=0** —
  health p95 95,5 ms, ready p95 117,7 ms, webhook-404 p95 118,1 ms.
- **Ack 202 ×3**: t 31,0/5,9/6,0 ms, inbox +1 insert-uma-vez;
  pós-remoção de canal → 404 (fail-closed, sem leak).
- **Outbox-volume**: **429 claims/s fresh / 440 reclaim**, índices USED
  (`outbox_pending_idx` + lease-recovery), pool **14/100** sob claimers
  paralelos.
- **Comando autenticado p95**: **22,8 ms** (p50 9,8 / p99 33,6, n=200) —
  fecha o gap 1 do §4 (re-medição com sessão válida pós re-migração).
- **Soak HTTP** (`scheduler-soak.mjs`, rev. `ba91091` — gates de status,
  hardening de cobertura/Openloop, probe de estabilidade HTTP): aceitação
  é **202** e backlog é **NOT measured by design** (a prova de backlog é
  o `outbox-volume` acima). Runs: estático **PASS**
  (read 7,3 / ready 9,8 / 404 11,0 ms p95); scheduler-ON **PASS**
  (drift 11,1→8,3 ms, sem flip); pós-WORKER **PASS**
  (8,1/10,3/9,3, observe 8,0).
- **Estado final do staging**: `API_SCHEDULER_ENABLED=1` (F13 cumprido) e
  worker profile ativo e drenando.

**Gap parcialmente fechado**: provider live read-path = **MEDIDO** (baseline
p95 24,9/21,1 ms na janela Contabo 2026-10-17 — gap 3 do §4 fechado para
read-path). Fulfillment p95 + challenge/drift seguem **INCONCLUSIVE**
(operator-gated, exigem janela com envio autorizado).
