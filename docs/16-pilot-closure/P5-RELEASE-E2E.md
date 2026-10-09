# P5 — Release E2E evidence matrix (G01–G18 / F01–F17)

> TASK_ID: CODER-P5 · branch `closure/p5-release-e2e`
> Gate canônico: `docs/15-implementation-baseline/14-e2e-acceptance-matrix.md`
> (este doc complementa o baseline; em conflito, o baseline vence).
> Dados executáveis: `tests/release/pilot-evidence.yaml` (+ gate
> `tests/release/test_pilot_evidence.py`).
> Issue #9 (golden workflows) absorvida aqui; issue #1 fora de escopo salvo
> necessidade declarada — não houve necessidade (nenhum live executado).

## Método

1. Leitura do gate canônico (35 IDs: 18 golden + 17 failure/recovery).
2. Para cada ID, localização do teste automatizado existente mais específico
   (`apps/api/test/*`, citação `arquivo:"teste"` exata) ou da evidência
   controlada existente (`evidence/p3-*/report.md`, `evidence/staging-p0-051/`).
3. Sem automação nova de domínio e sem lives: o que exige sessão live,
   compra real ou worker durável virou BLOCKED com dono `operator` +
   condição de desbloqueio explícita (gates B1/M1/M2/G07/F12 já nomeados em
   P3 e no PLAN). Nenhum código de domínio foi editado.
4. Honestidade de `last_run`: nenhuma suíte de integração foi re-executada
   nesta tarefa (sem `TEST_DATABASE_URL` descartável verificado); PASS =
   suíte/evidência existente citada exatamente, não re-run local.

## Cobertura — resumo

- **PASS: 33/35** (todos com teste automatizado existente citado + limitações).
- **BLOCKED: 2/35**, ambos por gate externo de operador, nunca por "não mapeado":
  - **G07** (compra MK real) → gate G07 do operador (conta/termos + compra
    controlada + reconciliação + limites de gasto). Parcial echo coberto por
    `multidomain-dispatch` (license echo) — sem efeito econômico real.
  - **F12** (crash-resume durável) → Hatchet 9/9 LIVE-BLOCKED
    (`evidence/p3-hatchet/report.md`); adapter construction-only, SDK ausente,
    sem instância. O falso claim de contrato do stub (`enqueue` retornava
    `{ durable: true }` sem criar run) foi corrigido em 2026-10-09 falhando
    fechado; o bloqueio permanece por certificação externa, não por este bug.
    Desbloqueio: decisão adotar-vs-manter-local + instância +
    SDK pinado + mapeamento real + gate de 9 itens.
- **Zero UNKNOWN / NOT_MAPPED** nos gates MVP-PILOT (gate python impõe).

## Linhas exigidas pelo aceite (§3) — todas atendidas

| Linha | Veredito |
|---|---|
| Golden Loop (G01/G02/G05/G06) | PASS (`golden-loop` legs a-b/c-f/g, `agent-shadow`, `commerce-billing` happy path, `subscription-fulfillment` full loop) |
| Renewal (G08/G09) | PASS (`renewal-retention` happy path; `trial-compat` boundary 4-dias-nega/3-dias-permite) |
| Recovery (F02/F03/F13) | PASS (`subscription-fulfillment` F02; `provider-dispatch` VERIFYING; `renewal-retention` F13) |
| Duplicate payment (F01) | PASS (`commerce-billing` duplicate webhook no-op) |
| Provider unknown (F03 + reconciliação) | PASS (`provider-dispatch` post-send VERIFYING; `trial-compat` UNKNOWN reconciles; `multidomain` license UNKNOWN) |
| Tenant isolation (F10) | PASS (`cutover-ab-matrix` REAL sob `iptv_app` + `commerce-billing` isolation + `rls-tenant-context`) |
| Cross-customer F16 | PASS (`commerce-billing` cross-customer refund rejected + `inventory-app-trial` cross-customer mixes) |
| Refunds F17 | PASS (concorrentes + stale + UNKNOWN-reconcile + chargeback distintos, todos em `commerce-billing`) |
| Workflow crash F12 | **BLOCKED** (hatchet, motivado, dono operator) |
| Injection F09 | PASS (`agent-shadow` bus nega tool/comando não autorizado + `agent-model-failure` recusa ruidosa; limitação: sem suíte adversarial dedicada) |
| Stale approval F11 | PASS (`commerce-billing` stale + `commands.unit` expectedStatus + `copilot` 409) |
| Manual fallback (F05/WAHA) | PASS-código (`waha-f05-f06` unit + `p3-waha` item 14 runbook); drill live = gate M2 do operador |

## Gaps e follow-ups (não bloqueiam pilot)

1. Re-run integral das 35 linhas com `TEST_DATABASE_URL` descartável (B2) —
   registrar `last_run` real por ID antes do pilot.
2. Suíte adversarial dedicada F09 (prompt-injection) — hoje só fail-closed.
3. Teste F16 dedicado cobrindo as 5 superfícies
   (Order/Subscription/Cycle/Entitlement/add-on) em um só lugar.
4. Gates do operador pendentes: B1 (PIX live), M1/M2 (WAHA live), G07 (MK),
   Steps 3/6–9 Fase 6 (CINEVISION writes/canary), decisão Hatchet (F12).
5. Scheduler ligado (`API_SCHEDULER_ENABLED=1`) para o caminho F13 em staging.

## Validação

- `python -m unittest tests.release.test_pilot_evidence` — parse YAML, 35 IDs
  exatos, sem UNKNOWN/NOT_MAPPED, BLOCKED só com `unblock` + owner operator,
  toda entrada PASS com `test`+`evidence`.
- `python -c "import yaml; ..."` — parse direto (fallback sem dependência de pacote).
