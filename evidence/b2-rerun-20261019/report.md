# B2 — re-run integral da matriz release G01–G18 / F01–F17 · 2026-10-19

> TASK_ID: B2-RERUN-20261019 · branch `closure/b2-rerun-20261019` (base `352cebb`, sem mudança de código).
> Definição: `docs/16-pilot-closure/P5-RELEASE-E2E.md:66-81` · dados: `tests/release/pilot-evidence.yaml`
> (+ gate `tests/release/test_pilot_evidence.py`). Zero atos externos: sem Asaas/WAHA/provider,
> sem cobrança, sem staging/produção, sem segredo em repo/log.

## Banco descartável (verificado vazio)

- Container efêmero `iptv-b2-rerun-20261019` (`postgres:17-alpine`, sem volume, porta host `5433`),
  DB `b2rerun`: `count(*) ... where table_schema='public'` = **0** antes do run.
- `TEST_DATABASE_URL=postgresql://iptv:***@localhost:5433/b2rerun` exportado só no shell do run
  (Turbo não carrega `.env`); nunca commitado. Demais bancos/containers nunca tocados.

## Suíte integral (`pnpm test --concurrency=1`)

- Turbo: **19 successful, 20 total** (7 cached), `Time: 8m29.174s`. Único vermelho: `@iptv/api#test`.
- Por pacote (arquivos / testes, todos PASS exceto api):
  domain 6/27 · ai-runtime 2/35 · secrets 1/17 · workflows 4/54 · database 6/28 ·
  observability 2/13 · config 1/58 · web 8/137 · browser-worker 13/256 ·
  outbox-worker 9/60 · auth 3/21 · **api 84/85 arquivos, 1073/1074 testes**.
- Arquivos citados por IDs G/F verificados verdes no log (todos `✓`):
  golden-loop 3/3 · agent-shadow-approval 8/8 · trial-compat 9/9 · trial-readback 10/10 ·
  commerce-billing 23/23 · subscription-fulfillment 9/9 · multidomain-dispatch 10/10 ·
  renewal-retention 16/16 · waha-f05-f06 13/13 · agent-model-failure 6/6 ·
  cutover-ab-matrix 16/16 · support-hitl-center 6/6 · support-technical-access-g12 1/1 ·
  referral-rewards 11/11 · partners-resellers 13/13 · campaigns-attribution 13/13 ·
  copilot-w14b 15/15 · provider-dispatch 19/19 · analytics-w14a 6/6 ·
  inventory-supplier-credit 5/5 (+ variantes `.unit` verdes).

## Único vermelho: flake, não bug (evidência)

- `apps/api/test/commands-events-hitl.integration.test.ts` > `parallel drains process disjoint
  rows (SKIP LOCKED)`: `AssertionError: expected 3 to be >= 4`
  (`ownOutboxRows(marker)` filtra `created_at >= marker`; vitest roda arquivos em workers
  paralelos contra o mesmo DB — janela de marcador sob carga).
- Arquivo **não é citado por nenhum ID G/F** (nenhum veredito da matriz depende dele).
- Re-run isolado contra o mesmo banco descartável: **6/6 PASS** (6.44s).
- Nenhum código de aplicação foi alterado nesta task (proibido pelo escopo).

## Gates Python (todos verdes)

| Gate | Resultado |
|---|---|
| `python scripts/validate_docs.py` | OK (exit 0) |
| `python tests/contracts/test_contracts.py` | 21 tests OK (exit 0) |
| `python tests/contracts/test_seed_contract.py` | 5 tests OK (exit 0) |
| `python -m unittest tests.release.test_pilot_evidence` | 6 tests OK (exit 0, pós-edição do YAML) |

## YAML (`tests/release/pilot-evidence.yaml`)

- `last_run` real 2026-10-19 em **34/35 IDs**: todos os PASS + G07 (DEFERRED, teste echo re-executado
  verde; status/limitations/unblock/adr intactos). G01 e G05 preservam a nota live anterior e
  ganham o adendo da suíte B2.
- **F12 (BLOCKED) intocado**: `last_run` segue a prova live 2026-10-12 (script temporário removido,
  não re-executável via `pnpm test`) — honestidade primeiro, sem claim de re-run.
- Zero `UNKNOWN`/`NOT_MAPPED`; gate impõe o restante.

## Artefatos

- `report.md` (este arquivo), `suites-summary.log` (per-file results + sumário turbo, sem segredos).
- Log integral do run permanece fora do repo (TEMP do executor).

## Cleanup

- Container descartável removido ao fim (`docker rm -f iptv-b2-rerun-20261019`; sem volume, nada persiste).
- Nenhum resíduo em repo (só `tests/release/pilot-evidence.yaml` + `evidence/b2-rerun-20261019/`),
  em outros bancos ou em serviços externos.
