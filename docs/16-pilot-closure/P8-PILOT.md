# P8 — Controlled Pilot + Final Closure (runbook do operador)

> A operação do piloto é ato do operador. Este documento define critérios de
> entrada, procedimento, métricas e critérios de saída. Engenharia não opera
> tráfego real nem inventa autorização jurídica.

## Entrada (tudo antes de qualquer tráfego real)

- [x] PRs #12–#26 mergeados em ordem, CI verde na main. (verificado 2026-10-13: #12–#26 MERGED; CI success na main até #63)
- [x] Staging rehearsal repetido pós-merge (P1-exit parte 2 + P7) com API `iptv_app`. (verificado 2026-10-13: lane descartável `iptv-rehearsal2`, evidência em `evidence/p8-rehearsal-rerun-20261013/`)
- [x] Gates de operador com decisão explícita:
      - B1/B2 (Asaas): Nominal PASS verificado em sandbox/staging Contabo (evidence/p3-asaas-sandbox/live-b1-nominal-20261019.md — PIX R$ 5,00 PAID, payment CONFIRMED, order SETTLED, ledger balanceado) + ciclo B-refund fresh governado (evidence/p3-asaas-sandbox/live-b-refund-fresh-20261020.md).
      - M1/M2 (WAHA): M1 text adopt PASS (evidence/p3-waha/m1-adopt-20261014.md), M2 manual drill PASS (evidence/p3-waha/m2-drill-20261014.md), M1-media live + Groq STT Whisper PASS (evidence/p3-waha/m1-media-live-20261021.md e stt-groq-live-20261021.md).
      - G07 (MK Ativador): Diferido formalmente para o pós-MVP via ADR-0027 (2026-10-12) com processo de fallback manual auditado.
      - Steps 3/6–9 (CINEVISION): Credenciais no Infisical (dev/browser-worker/*), leituras homologadas; writes automatizados com Cloudflare Bot Management Challenge (evidence/p3-cinevision/step3-blocked-challenge-20261013.md), adotando formalmente o caminho de fulfillment manual/supervisionado via UI /fulfillment ou API /v1/provider/operations/:id/resolve.
      - F12 (Hatchet): Prova live W0-04 executada com sucesso (evidence/p3-hatchet/w004-live-proof-20261012.md), configuração e tokens canônicos adotados no .env (HATCHET_CLIENT_* + HATCHET_DURABLE_CERTIFIED=1).
- [x] Observabilidade ativa (P6) + alertas + TEST_DATABASE_URL documentada p/ reruns: provado via export OTLP traces/metrics/logs em loopback (scripts/otlp-proof.mjs), alertas 16/16 e relatórios de DR, performance e segurança concluídos (P6-OBSERVABILITY.md, P6-DR.md, P6-PERFORMANCE.md, P6-SECURITY.md).
- [x] `pilot-evidence.yaml`: re-run integral com `last_run` real por ID (P5 follow-up). (verificado 2026-10-13: B2 20/20 tasks verdes, 0 IDs `not_rerun_in_this_task`; F12 segue BLOCKED, G07 DEFERRED)

## Operação (tenant interno, canaries com capability-scoped)

1. Ativar outbox worker pelo procedimento 051 (runbook) OU declarar legado
   como modo do piloto (decisão explícita; sem coexistência).
2. Primeira venda pelo runbook [`pilot-first-sale.md`](../10-operations/runbooks/pilot-first-sale.md)
   (pedido via UI web `/orders` ou via API).
2. WhatsApp inbound → agent/manual → trial → offer → payment sandbox/canary →
   fulfillment → subscription → renewal → support → refund → recovery
   (rehearsal P7 como roteiro, agora com tráfego real autorizado).
3. Medir (janela mínima 1 ciclo de renewal): conversão, human handling,
   worker failures, provider failures, wrong-action, reconciliation,
   duplicate effects, queue age, support, cost — metas na SPEC §16.

## Saída → `READY FOR PRODUCTION — INTERNAL TENANT`

- Regressões resolvidas; zero P0/P1; SLO medido (sem SLO sem mecanismo);
  backup/restore repetido; capability register atualizado; runbooks exercitados;
  fallback humano provado; reconciliação financeira limpa; cleanup de providers.
- Resolver SOMENTE findings release-blocking; o resto vira backlog pós-pilot
  (regra de conclusão SPEC §17: sem criterion violado, sem reabertura).

## Promoção

- Freeze regression suite + docs canônicos; fechar epic de closure; tag release;
  arquivar planning obsoleto; atualizar capability register; fechar Wave 17.
