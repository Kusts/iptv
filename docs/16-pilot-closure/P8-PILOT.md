# P8 — Controlled Pilot + Final Closure (runbook do operador)

> A operação do piloto é ato do operador. Este documento define critérios de
> entrada, procedimento, métricas e critérios de saída. Engenharia não opera
> tráfego real nem inventa autorização jurídica.

## Entrada (tudo antes de qualquer tráfego real)

- [ ] PRs #12–#26 mergeados em ordem, CI verde na main.
- [ ] Staging rehearsal repetido pós-merge (P1-exit parte 2 + P7) com API `iptv_app`.
- [ ] Gates de operador com decisão explícita: B1/B2 (Asaas sandbox→canary),
      M1/M2 (WAHA), G07 (MK), Steps 3/6–9 (CINEVISION), F12 (Hatchet ou
      local-honesto aceito), legal/provider/tax (SPEC §12.4, M1–M4).
- [ ] Observabilidade ativa (P6) + alertas + `TEST_DATABASE_URL` documentada p/ reruns.
- [ ] `pilot-evidence.yaml`: re-run integral com `last_run` real por ID (P5 follow-up).

## Operação (tenant interno, canaries com capability-scoped)

1. Ativar outbox worker pelo procedimento 051 (runbook) OU declarar legado
   como modo do piloto (decisão explícita; sem coexistência).
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
