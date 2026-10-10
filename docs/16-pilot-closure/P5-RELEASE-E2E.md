# P5 — Release E2E evidence matrix (G01–G18 / F01–F17)

> TASK_ID: CODER-P5 · branch `closure/p5-release-e2e`
> Gate canônico: `docs/15-implementation-baseline/14-e2e-acceptance-matrix.md`
> (este doc complementa o baseline; em conflito, o baseline vence).
> Dados executáveis: `tests/release/pilot-evidence.yaml` (+ gate
> `tests/release/test_pilot_evidence.py`).
> Re-run 2026-10-09 (branch `closure/p8-p5-evidence-20261009`): `last_run` das
> linhas PASS passou a ser data real de execução — ver "Re-run 2026-10-09".
> Após finding do PR #37, G01 deixou de ser PASS (ver abaixo): o re-run cobre
> 32 linhas PASS + a perna inbound de G01.
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

- **PASS: 32/35** (todos com teste automatizado existente citado + limitações).
- **BLOCKED: 3/35**, nunca por "não mapeado":
  - **G07** (compra MK real) → primeiro gate de engenharia: implementar e
    certificar adapter real autenticado (saldo/produtos, compra, ativação,
    readback, idempotência e reconciliação de UNKNOWN); depois gate do operador
    (conta/termos, autorização/limites e compra controlada). Parcial echo
    coberto por `multidomain-dispatch` (license echo) — sem efeito econômico real.
  - **F12** (crash-resume durável) → Hatchet 9/9 LIVE-BLOCKED
    (`evidence/p3-hatchet/report.md`); adapter construction-only, SDK ausente,
    sem instância. Desbloqueio: decisão adotar-vs-manter-local + instância +
    SDK pinado + mapeamento real + gate de 9 itens.
  - **G01** (jornada única inbound → identity/conversation → manual reply →
    outbound delivered once): o teste citado (`golden-loop` legs a-b) prova
    apenas a persistência inbound e os envios M1 ao vivo de 2026-10-08 foram
    `sendText` direto, não reply da aplicação vinculado à conversa inbound.
    Desbloqueio: teste determinístico da cadeia completa + evidência live de
    reply vinculado (owner operator; ver `pilot-evidence.yaml`).
- **Zero UNKNOWN / NOT_MAPPED** nos gates MVP-PILOT (gate python impõe).

## Linhas exigidas pelo aceite (§3)

| Linha | Veredito |
|---|---|
| Golden Loop (G02/G05/G06) | PASS (`golden-loop` legs c-f, `agent-shadow`, `commerce-billing` happy path, `subscription-fulfillment` full loop) |
| G01 (jornada única inbound→identity/conversation→manual reply→outbound) | **BLOCKED** — `golden-loop` legs a-b prova só persistência inbound; M1 live foi `sendText` direto, não reply vinculado; falta teste da cadeia completa + evidência live |
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

## Re-run 2026-10-09 — citações primárias re-executadas (software concluído; re-run integral B2 aberto)

O follow-up 1 do mapeamento ("re-run integral com `TEST_DATABASE_URL`
descartável", B2) tem três partes com estados distintos — separá-las evita
falso fechamento (finding do PR #37):

- **(a) CONCLUÍDO em 2026-10-09** (branch
  `closure/p8-p5-evidence-20261009`): re-run de software das citações
  primárias `test:`; nenhum live, operador ou provider foi acionado.
- **(b) NÃO re-executado nesta data:** arquivos citados em `evidence:`
  (`evidence/p3-*/report.md` etc.) — seguem válidos como registro histórico.
- **(c) ABERTO:** fechamento integral do release gate — arquivos `evidence:`
  não rerodados, G07/F12 BLOCKED e lane pós-merge não testada. B2 **não**
  está fechado; `P8-PILOT.md` mantém a caixa do re-run integral desmarcada.

O que foi executado em (a):

- `pnpm exec turbo build --filter=@iptv/api...` — **9/9 tasks** verdes.
- Vitest alvo — **18 arquivos** (as citações primárias `arquivo:teste` das
  então-33 linhas PASS; após reclassificar G01 como BLOCKED, 32 linhas PASS +
  a perna inbound de G01, coberta pelo mesmo arquivo): **184/184 passed**,
  0 skipped, 0 failed, contra PostgreSQL 17 fresco, sem volume, em loopback.
- Gate Python da release `tests/release/test_pilot_evidence.py` — **5/5**.

Escopo honesto: o re-executado é a citação primária `test:` de cada linha PASS.
Os arquivos citados em `evidence:` (ex.: `evidence/p3-*/report.md`) são evidência
histórica corroborante e **não** foram re-executados nesta data — seguem válidos
como registro do que já havia sido executado. É exatamente esse o significado de
`last_run` no YAML.

G07 (compra MK real) e F12 (crash-resume durável Hatchet) permanecem
**BLOCKED** com dono `operator`: este re-run não executa gate de operador e não
promove nenhum status live — prova apenas as citações de software. G01 também
permanece **BLOCKED**: o re-run executa a perna inbound, mas não existe teste
nem evidência da cadeia manual reply → outbound entregue 1×.

## Gaps e follow-ups / gates restantes

Os itens abaixo não têm todos a mesma severidade: **os gates marcados como
obrigatórios bloqueiam a readiness do piloto**; apenas melhorias explicitamente
marcadas como follow-up não bloqueante podem ficar para depois. A lista não
substitui a matriz de `RELEASE-CLOSURE-STATUS.md`.

1. Suíte adversarial dedicada F09 (prompt-injection) — hoje só fail-closed.
2. Teste F16 dedicado cobrindo as 5 superfícies
   (Order/Subscription/Cycle/Entitlement/add-on) em um só lugar.
3. Gates do operador pendentes — **B1 Asaas parcial**, não fechado
   (`evidence/p3-asaas-sandbox/live-b1.md`, 2026-10-08: customer + charge PIX +
   `receiveInCash` + readback PAID + cleanup ao vivo; duplicate/reconcile em
   banco descartável; `receiveInCash` não é liquidação PIX fiel; restam G1
   dashboard e G2 entrega webhook Asaas→nós do operador; **G3 reorder
   dedicado é teste de software — bloqueio de engenharia**; refund live
   recusado pelo provider), **M1 WAHA parcial** (`evidence/p3-waha/m1-live.md`,
   2026-10-08: session/restart/outbound/inbound/auth/dedupe/LID/triage PASS ao
   vivo; restam multi-sessão, reconnect profundo e restriction), **M2 WAHA não
   executado** (`evidence/p3-waha/m2-drill.md`: drill manual = ato do operador;
   media/audio não implementados = bloqueio de engenharia),
   G07 (MK — adapter real é bloqueio de engenharia, mais gates de operador), Steps 3/6–9 Fase 6
   (CINEVISION writes/canary), decisão Hatchet (F12).
4. Scheduler ligado (`API_SCHEDULER_ENABLED=1`) para o caminho F13 em staging.
5. **B2 / re-run integral do release gate — ABERTO:** concluído apenas o
   re-run de software das citações primárias (build 9/9 + Vitest 184/184 +
   gate Python 5/5, 2026-10-09). Fechar exige rerodar os arquivos `evidence:`
   que correspondem a cada requisito, fechar G07/F12 e rerodar na lane
   pós-merge — sem alterar `last_run` por inferência.

## Validação

- `python -m unittest tests.release.test_pilot_evidence` — parse YAML, 35 IDs
  exatos, sem UNKNOWN/NOT_MAPPED, BLOCKED só com `unblock` + owner operator,
  toda entrada PASS com `test`+`evidence`.
- `python -c "import yaml; ..."` — parse direto (fallback sem dependência de pacote).
