# Provider live read-path — janela Contabo 2026-10-17

> Read-only, sem envio, sem bodies, sem PII (números, LID, pushName — nada disso aqui).
> Raw (report.md + dados mascarados) vive fora do repo em
> `/home/deploy/artifacts/provider-live-contabo-20261017/` (host Contabo).

## Contexto

- Instância WAHA do piloto na VPS Contabo (container `waha` running desde 2026-10-08,
  engine NOWEB, atrás do Traefik `waha.synkroo.com.br` → :3000).
- Sessão `ted` = WORKING persistente desde 2026-10-14
  (`GET /api/sessions` / `GET /api/sessions/ted` = HTTP 200 na janela).
- Zero mutação, zero POST nesta janela.

## Janela

- 2026-10-17T14:27:04Z–14:31:25Z — 261 s, 1 amostra/s/endpoint (`curl -m 5`, corpo descartado).
- Percentis nearest-rank sobre sucessos.

## Metodologia

- 1 req/s por endpoint (`GET /api/sessions`, `GET /api/sessions/ted`), timeout 5 s.
- Corpo descartado (PII descartada); só status + latência registrados.
- Sem envio: fulfillment p95 e challenge/drift NÃO medidos (exigiriam POST — não autorizado).

## Resultados (localhost → container no próprio Contabo)

| Endpoint | n | ok | timeouts | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|
| `GET /api/sessions` | 180 | 180 (100%) | 0 | 9,0 ms | 24,9 ms | 47,7 ms | 58,6 ms |
| `GET /api/sessions/ted` | 180 | 180 (100%) | 0 | 6,8 ms | 21,1 ms | 57,9 ms | 79,3 ms |

## Caveats (lê isto antes de citar o número)

- Amostragem mediu latência **localhost → container no próprio Contabo** —
  NÃO representa o caminho público (Traefik/Cloudflare).
- Read-path apenas: sessão/estado. Fulfillment p95 e challenge/drift seguem BLOCKED.
- Read-only: nenhum envio, nenhuma mutação, nenhum body persistido.

## Referência

- Artifact bruto (fora do repo): `/home/deploy/artifacts/provider-live-contabo-20261017/`.
- Gap residual: fulfillment p95 + challenge/drift = INCONCLUSIVE (exigem janela com envio autorizado).
