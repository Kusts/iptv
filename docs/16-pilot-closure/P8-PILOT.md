# P8 — Controlled Pilot + Final Closure (runbook do operador)

> A operação do piloto é ato do operador. Este documento define critérios de
> entrada, procedimento, métricas e critérios de saída. Engenharia não opera
> tráfego real nem inventa autorização jurídica.

## Entrada (tudo antes de qualquer tráfego real)

- [ ] PRs de closure conhecidos (#12–#36) integrados; PR #37 (reconciliação de evidências) revisado/mergeado; CI verde no HEAD final da main. Confirmar novamente no GitHub — números de PR não substituem revisão/CI.
- [ ] Staging rehearsal repetido pós-merge (P1-exit parte 2 + P7) com API `iptv_app`.
- [ ] Fechar os bloqueios técnicos em `RELEASE-CLOSURE-STATUS.md` antes de entrada; qualquer exceção deve estar explicitamente permitida pela SPEC e registrar owner, mitigação e prazo de revisão. A simples decisão de operador não transforma implementação não durável em F12 PASS.
- [ ] Gates de operador com decisão explícita — **todos seguem abertos**:
      **B1 (Asaas sandbox→canary)** PARCIAL ao vivo em 2026-10-08
      (`evidence/p3-asaas-sandbox/live-b1.md`: customer descartável + charge
      PIX + `receiveInCash` + readback PAID + cleanup ao vivo). NÃO fechado e
      NÃO certificado: `receiveInCash` não é liquidação PIX fiel;
      duplicate/reconcile foram testes de integração contra PostgreSQL
      descartável, não entrega de webhook Asaas→nós ao vivo; refund recusado
      pelo Sandbox (`evidence/p3-asaas-sandbox/live-refund-pix-exec.md` —
      `KNOWN_NOT_APPLIED`, nenhum refund bem-sucedido). Restam **G1**
      (liquidação PIX fiel via dashboard), **G2** (webhook Asaas→nós via URL
      pública) e **G3** (reorder dedicado). **B2** re-run de software
      2026-10-09 (`P5-RELEASE-E2E.md`): apenas as citações primárias `test:`
      das 33 linhas PASS re-executadas — arquivos `evidence:` históricos NÃO
      re-executados. **M1 (WAHA)** PARCIAL ao vivo em 2026-10-08
      (`evidence/p3-waha/m1-live.md`: session/restart/outbound/inbound/auth/
      dedupe/LID/triage PASS ao vivo; restam multi-sessão, reconnect profundo
      e restriction/timelock). **M2 (WAHA)** NÃO executado
      (`evidence/p3-waha/m2-drill.md`: drill manual = ato do operador).
      **G07 (MK)**, **Steps 3/6–9 (CINEVISION)** e **F12 (runtime durável
      certificado; `LocalWorkflowAdapter` não é substituto)** permanecem gates; legal/provider/tax
      (SPEC §12.4, M1–M4) também.
- [ ] Observabilidade ativa (P6) + alertas + `TEST_DATABASE_URL` documentada p/ reruns.
- [ ] `pilot-evidence.yaml`: re-run integral com `last_run` real por ID
      (P5 follow-up). Situação em 2026-10-09 (branch
      `closure/p8-p5-evidence-20261009`): re-run de software executado — 33
      linhas PASS com `last_run` real (citação primária `test:`
      re-executada: build 9/9 + Vitest 184/184 contra PostgreSQL 17 fresco em
      loopback); **G07 e F12 seguem BLOCKED** com dono operator; arquivos
      `evidence:` históricos NÃO foram re-executados. Como "integral"
      exigiria também a re-execução dos arquivos de evidência e o fechamento
      dos gates de operador (G07/F12 abertos), a caixa permanece
      **desmarcada** até decisão do operador.

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
