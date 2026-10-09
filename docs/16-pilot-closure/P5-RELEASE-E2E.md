# P5 — Release E2E evidence matrix (G01–G18 / F01–F17)

> TASK_ID: CODER-P5 · branch `closure/p5-release-e2e`
> Gate canônico: `docs/15-implementation-baseline/14-e2e-acceptance-matrix.md`
> (este doc complementa o baseline; em conflito, o baseline vence).
> Dados executáveis: `tests/release/pilot-evidence.yaml` (+ gate
> `tests/release/test_pilot_evidence.py`).
> Re-run 2026-10-09 (branch `closure/p8-p5-evidence-20261009`): `last_run` das
> 33 linhas PASS passou a ser data real de execução — ver "Re-run 2026-10-09".
> Issue #9 (golden workflows) absorvida aqui; issue #1 fora de escopo salvo
> necessidade declarada — não houve necessidade (nenhum live executado no
> mapeamento CODER-P5 e nenhum no re-run de software de 2026-10-09; lives de
> operador em outras tasks, em 2026-10-08, estão registrados em
> `evidence/p3-waha/m1-live.md` e `evidence/p3-asaas-sandbox/live-b1.md`).

## Método

1. Leitura do gate canônico (35 IDs: 18 golden + 17 failure/recovery).
2. Para cada ID, localização do teste automatizado existente mais específico
   (`apps/api/test/*`, citação `arquivo:"teste"` exata) ou da evidência
   controlada existente (`evidence/p3-*/report.md`, `evidence/staging-p0-051/`).
3. Sem automação nova de domínio e sem lives na task de mapeamento: o que
   exige sessão live, compra real ou worker durável virou BLOCKED com dono
   `operator` + condição de desbloqueio explícita (gates B1/M1/M2/G07/F12 já
   nomeados em P3 e no PLAN). Nenhum código de domínio foi editado.
4. Honestidade de `last_run`: nenhuma suíte de integração foi re-executada
   nesta tarefa (sem `TEST_DATABASE_URL` descartável verificado); PASS =
   suíte/evidência existente citada exatamente, não re-run local. (Descreve o
   mapeamento original CODER-P5; o re-run de 2026-10-09 está na seção própria.)

## Cobertura — resumo

- **PASS: 33/35** (todos com teste automatizado existente citado + limitações).
- **BLOCKED: 2/35**, ambos por gate externo de operador, nunca por "não mapeado":
  - **G07** (compra MK real) → gate G07 do operador (conta/termos + compra
    controlada + reconciliação + limites de gasto). Parcial echo coberto por
    `multidomain-dispatch` (license echo) — sem efeito econômico real.
  - **F12** (crash-resume durável) → Hatchet 9/9 LIVE-BLOCKED
    (`evidence/p3-hatchet/report.md`); adapter construction-only, SDK ausente,
    sem instância. Desbloqueio: decisão adotar-vs-manter-local + instância +
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
| Manual fallback (F05/WAHA) | PASS-código (`waha-f05-f06` unit + `p3-waha` item 14 runbook); M1 parcial ao vivo em 2026-10-08 (`evidence/p3-waha/m1-live.md`: session/restart/outbound/inbound/auth/dedupe/LID/triage PASS ao vivo); drill manual M2 ainda NÃO executado (`evidence/p3-waha/m2-drill.md`) |

## Re-run 2026-10-09 — citações primárias re-executadas (follow-up 1 fechado)

Follow-up 1 ("re-run integral com `TEST_DATABASE_URL` descartável", B2) fechado
em 2026-10-09 na branch `closure/p8-p5-evidence-20261009`; neste re-run de
software nenhum live, operador ou provider foi acionado:

- `pnpm exec turbo build --filter=@iptv/api...` — **9/9 tasks** verdes.
- Vitest alvo — **18 arquivos** (as citações primárias `arquivo:teste` das 33
  linhas PASS): **184/184 passed**, 0 skipped, 0 failed, contra PostgreSQL 17
  fresco, sem volume, em loopback.
- Gate Python da release `tests/release/test_pilot_evidence.py` — **5/5**.

Escopo honesto: o re-executado é a citação primária `test:` de cada linha PASS.
Os arquivos citados em `evidence:` (ex.: `evidence/p3-*/report.md`) são evidência
histórica corroborante e **não** foram re-executados nesta data — seguem válidos
como registro do que já havia sido executado. É exatamente esse o significado de
`last_run` no YAML.

G07 (compra MK real) e F12 (crash-resume durável Hatchet) permanecem
**BLOCKED** com dono `operator`: este re-run não executa gate de operador e não
promove nenhum status live — prova apenas as citações de software.

## Gaps e follow-ups (não bloqueiam pilot)

1. Suíte adversarial dedicada F09 (prompt-injection) — hoje só fail-closed.
2. Teste F16 dedicado cobrindo as 5 superfícies
   (Order/Subscription/Cycle/Entitlement/add-on) em um só lugar.
3. Gates do operador pendentes — **B1 Asaas parcial**, não fechado
   (`evidence/p3-asaas-sandbox/live-b1.md`, 2026-10-08: customer + charge PIX +
   `receiveInCash` + readback PAID + cleanup ao vivo; duplicate/reconcile em
   banco descartável; `receiveInCash` não é liquidação PIX fiel; restam G1
   dashboard, G2 entrega webhook Asaas→nós e G3 reorder dedicado; refund live
   recusado pelo provider), **M1 WAHA parcial** (`evidence/p3-waha/m1-live.md`,
   2026-10-08: session/restart/outbound/inbound/auth/dedupe/LID/triage PASS ao
   vivo; restam multi-sessão, reconnect profundo e restriction), **M2 WAHA não
   executado** (`evidence/p3-waha/m2-drill.md`: drill manual = ato do operador),
   G07 (MK), Steps 3/6–9 Fase 6 (CINEVISION writes/canary), decisão Hatchet
   (F12).
4. Scheduler ligado (`API_SCHEDULER_ENABLED=1`) para o caminho F13 em staging.

## Validação

- `python -m unittest tests.release.test_pilot_evidence` — parse YAML, 35 IDs
  exatos, sem UNKNOWN/NOT_MAPPED, BLOCKED só com `unblock` + owner operator,
  toda entrada PASS com `test`+`evidence`.
- `python -c "import yaml; ..."` — parse direto (fallback sem dependência de pacote).
