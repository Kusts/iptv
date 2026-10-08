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
3. **Latência de provider**: sem provider live neste ambiente (P3,
   operator-gated) — provider latency, fulfillment p95 e challenge/drift
   seguem BLOCKED para medição real.
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
