# Release closure gaps — 2026-10-09

Lista deduplicada derivada da [matriz de status](RELEASE-CLOSURE-STATUS.md).
Este arquivo não substitui os detalhes operacionais de P3/P6/P8, a matriz G/F,
ou o baseline.

## Bloqueios de engenharia

1. **Segurança da auditoria/dependências:** PR #38 (`closure/security-hardening-20261009`, HEAD `9ef38b8`) corrige advisories alcançáveis (Fastify nested runtime, PostCSS, sharp e source-map-js) e parsing fail-closed; CI ainda estava em execução na última consulta e revisão humana permanece pendente. Restam dois advisories critical de `tinypool` via Vitest 3 (dev/CI) e um high do Jaeger propagator não usado; exige migração Vitest 3→4 e decisão sobre OpenTelemetry, sem exceção formal atual com owner/revisão.
2. **F12 durable workflow:** PR #39 (`closure/workflow-honesty-20261009`, HEAD `32bde15`) remove a declaração falsa de durabilidade e mantém fail-closed; testes locais 11/11 e review aprovado, CI pendente na última consulta. Isso não implementa/injeta Hatchet. Depois do PR, integrar o runtime aceito na ADR-0019 e executar a suíte de crash/replay/retry/HITL/idempotência/concurrency/tenant-isolation; F12 permanece BLOCKED.
3. **CINEVISION writes:** nenhuma operação de criação está implementada. Observar contrato legítimo primeiro, depois adapter, readback, dispatcher, `UNKNOWN`/reconciliation e canário; manter manual até certificação.
4. **Segurança de exposição:** rate limit de login/cadastro e security headers (CSP/frame policy etc.) não estão provados no ingress efetivo. Sem prova de controles do gateway ou restrição privada do piloto, não expor publicamente.
5. **Frontend E2E:** falta browser E2E da versão candidata cobrindo estados, permissões, responsividade e integração backend nos fluxos do escopo.

## Gates de operador / ambiente

1. **Asaas G1/G2/G3:** liquidação PIX fiel no Sandbox, webhook público entregue à API, e teste de eventos fora de ordem/duplicados/atrasados/concor­rência/reversal. Refund `SUCCEEDED` ainda não demonstrado; nada de movimento financeiro sem autorização.
2. **WAHA M1/M2:** multi-session/deep reconnect e drill de fallback manual/restauração sem duplicidade. Não provocar ban/timelock. Media/audio requer decisão explícita sobre escopo.
3. **MK G07:** conta/termos/teto de gasto e autorização para compra controlada; reconciliação do efeito econômico.
4. **Staging/certificações:** rehearsal após merge do candidato, versão/build, role real (`iptv_app`/worker), TLS/ingress, restart/rollback e secrets por identidade. Não ler ou registrar valores secretos.
5. **DR/observabilidade/performance:** offsite real + restore no ambiente alvo, RPO/RTO medidos (sem PITR claim), alertas comprovados e medições p95/p99 representativas.

## G/F e documentação

- `tests/release/pilot-evidence.yaml`: 33 PASS / G07 e F12 BLOCKED. O re-run de
  2026-10-09 comprovou as citações primárias `test:` (184/184), não os arquivos
  `evidence:` históricos; reexecutar evidência que corresponda ao requisito,
  sem alterar `last_run` por inferência.
- PR #37 contém a reconciliação de evidências e aguarda revisão/merge humano.
- A CI da main (`2f181e8`) é anterior ao PR #37 e à correção candidata de
  segurança; a CI da branch #37 (`4736707a`) está verde, mas não incorpora a
  branch de segurança.
- Issues abertas #1, #4, #7 e #27 existem; não criar duplicatas. Revisar
  aplicabilidade/obsolescência após fechar os gates diretamente relacionados.

## Próxima sequência curta

1. Fechar/PR/CI da fatia de segurança, incluindo revisão independente e CI.
2. Corrigir F12 tecnicamente, preservando ADRs e certificando restart/crash;
   fazer em branch própria.
3. Fazer CINEVISION por contrato observado antes de código.
4. Reexecutar suites do sistema em lane descartável; em paralelo seguro, coletar
   somente as evidências externas autorizadas (Asaas, WAHA, MK).
5. Revalidar staging, DR, observabilidade, frontend e performance no candidato;
   atualizar matriz e readiness com evidência direta.

Nenhuma dessas linhas autoriza tráfego real, compra, refund, mensagem a cliente,
ou alteração destrutiva de produção.
