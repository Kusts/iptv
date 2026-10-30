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
4. Histórico de `last_run`: no snapshot B2 de 2026-10-19, 19/20 tarefas Turbo
   passaram e nenhuma suíte citada por uma linha G/F falhou; o rerun integral
   automatizado foi concluído depois no B3 (2026-10-30), registrado por linha
   no YAML. Atualização anterior (2026-10-12): G01/G02/G03/G04/G05/G06/G08/G09
   re-executados contra a main `cfec222` (PostgreSQL 16 descartável); esse
   registro histórico permanece preservado no YAML.

## Cobertura — resumo

- **PASS: 33/35** (todos com teste automatizado existente citado + limitações).
- **BLOCKED: 1/35 + DEFERRED_POST_MVP: 1/35**, todos por gate externo de operador, nunca por "não mapeado":
  - **G07** (compra MK real) → gate G07 do operador (conta/termos + compra
    controlada + reconciliação + limites de gasto). Parcial echo coberto por
    `multidomain-dispatch` (license echo) — sem efeito econômico real. **Diferido pós-MVP (ADR-0027, 2026-10-12); status `DEFERRED_POST_MVP`.**
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
| Injection F09 | PASS (`agent-shadow` bus nega tool/comando não autorizado + `agent-model-failure` recusa ruidosa + suíte adversarial dedicada `packages/ai-runtime/test/f09-prompt-injection.unit.test.ts` 11/11 offline: direct prompt EN/PT, tool-like refund/hostile-tool, quoted web-like em inbound prompt, hostile model-output guardrail, no-overblocking; limitações: EchoModelGateway/offline apenas, padrões EN/PT por regex, sem live provider, sem fetch web real nem boundary de proveniência, superfície de tools limitada a `crm.lookup_person` R0) |
| Stale approval F11 | PASS (`commerce-billing` stale + `commands.unit` expectedStatus + `copilot` 409) |
| Manual fallback (F05/WAHA) | PASS-código (`waha-f05-f06` unit + `p3-waha` item 14 runbook); drill live = gate M2 do operador |

## Gaps e follow-ups (não bloqueiam pilot)

1. Re-run integral das 35 linhas com `TEST_DATABASE_URL` descartável —
   FECHADO para as suítes automatizadas (B3 2026-10-30): `pnpm test
   --concurrency=1` exit 0 (Turbo 20/20; `@iptv/api` 103 arquivos, 1267 passed
   / 1 skipped / 0 failed) contra PostgreSQL 17 descartável (0 tabelas pré-run);
   33 PASS com suíte citada verde; G07 segue `DEFERRED_POST_MVP` e F12 segue
   `BLOCKED` (gates de operador, sem re-run live); único skip intencional é a
   paridade pooled opt-in (`TEST_POOLED_DATABASE_URL` em `worker-rls-matrix`).
   `last_run` real registrado no YAML por ID.
2. Suíte adversarial dedicada F09 (prompt-injection) — FECHADA (2026-10-30): `packages/ai-runtime/test/f09-prompt-injection.unit.test.ts` 11/11 no harness de produção (`AgentHarness` + `EchoModelGateway` + `ToolRegistry`, sem rede/modelo/DB); fail-closed do bus segue coberto por `agent-shadow`. Limites: offline/EchoModelGateway apenas, padrões EN/PT por regex, sem live provider, sem fetch web real nem boundary de proveniência (quoted web-like só como dado em inbound prompt).
3. **F16 fechado (2026-10-30):** suite dedicada em
   `apps/api/test/f16-cross-customer.integration.test.ts` cobre Order,
   Subscription, Cycle, Entitlement e add-on charge, incluindo IDs válidos de
   dois clientes do mesmo tenant, mutações parent-side e controles positivos;
   migration append-only 064 aplica as invariantes no banco. Resultado em
   PostgreSQL descartável: 7/7 testes passam.
4. Gates do operador pendentes: B1 (PIX live), M1/M2 (WAHA live),
   Steps 3/6–9 Fase 6 (CINEVISION writes/canary), decisão Hatchet (F12).
   G07 (MK) diferido pós-MVP per ADR-0027 — reativação pós-MVP, fora do piloto.
5. Scheduler ligado (`API_SCHEDULER_ENABLED=1`) para o caminho F13 em staging.

## Validação

- `python -m unittest tests.release.test_pilot_evidence` — parse YAML, 35 IDs
  exatos, sem UNKNOWN/NOT_MAPPED, BLOCKED só com `unblock` + owner operator,
  DEFERRED_POST_MVP só com `adr` + `unblock` + owner operator,
  toda entrada PASS com `test`+`evidence`.
- `python -c "import yaml; ..."` — parse direto (fallback sem dependência de pacote).
