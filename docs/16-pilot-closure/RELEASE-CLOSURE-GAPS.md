# Release closure gaps — 2026-10-09

Lista deduplicada derivada da [matriz de status](RELEASE-CLOSURE-STATUS.md).
Este arquivo não substitui os detalhes operacionais de P3/P6/P8, a matriz G/F,
ou o baseline.

## Bloqueios de engenharia

1. **Segurança da auditoria/dependências:** PR #38 corrige Fastify nested runtime, PostCSS, sharp, source-map-js e endurece parser; PR #41 migra Vitest 3→4.1.11 e remove `tinypool` criticals; PR #42 (`closure/security-otel2-20261009`, `d44ea3c`, stacked sobre #41) migra o conjunto OTel coerentemente para SDK 2.12.0/exporters 0.223.0, remove o Jaeger high e adiciona prova de traces/métricas/logs. CI #38/#41 verde; CI #42 ainda em execução na última consulta. Audit local na candidata #42: 2 findings Moderate do Next, 0 High/Critical, baseline vazia por intenção. PRs aguardam revisão humana/merge. 320 testes DB-gated foram pulados sem DB; prova OTLP usa stub loopback e não valida collector real.
2. **F12 durable workflow:** PR #39 (`closure/workflow-honesty-20261009`, HEAD `32bde15`) remove a declaração falsa de durabilidade; CI completo verde e review automatizado recebido, revisão humana pendente. Pesquisa em fontes oficiais confirma que o package name e variáveis de ambiente atuais no main estão incompatíveis com SDK TypeScript publicado (`@hatchet-dev/typescript-sdk`, `HATCHET_CLIENT_TOKEN`). PR #39 não corrige wiring/env, não integra producer/worker e não certifica Hatchet. F12 exige integração real conforme ADR-0019 e execução de crash/replay/retry/HITL/idempotência/concurrency/tenant-isolation.
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
- PR #37 contém reconciliação de evidências + matriz/gaps e aguarda revisão/merge humano; HEAD atual `83c1e4b`, com CI runs `38000939821`/`38000943392` verdes nesse SHA.
- PRs abertos adicionais: #38 dependências + audit fail-closed (CI verde), #39 correção do claim de durabilidade (CI verde), #41 Vitest 4 (CI verde), #42 OTel 2.x coerente (CI parcial: security-scans/outbox/adversarial verdes, build em execução na última consulta). Todos aguardam revisão humana e integração; nenhum foi merged.
- A CI da main (`2f181e8`) é anterior ao PR #37 e às correções candidatas de
  segurança; a CI atual da branch #37 (`83c1e4b`, runs `38000939821` e
  `38000943392`) está verde, mas não incorpora os branches #38/#41/#42.
- Issues abertas #1, #4, #7, #27 e #40 existem; não criar duplicatas. Issue #40
  pede alternate-path permission/effect evals; avaliar sua relação com os
  gates P5/F09/F10 e definir um caso estreito antes de tratá-la como requisito
  bloqueador (sem ampliar escopo por referência acadêmica isolada).
  Revisar aplicabilidade/obsolescência após fechar os gates relacionados.

## Próxima sequência curta

1. Obter revisão humana e integrar PRs #37, #38, #39, #41 e #42 somente pelo fluxo normal (sem merge automático); issue #40 segue separada.
2. Executar suites DB-gated em PostgreSQL vazio descartável e validar OTLP contra collector autorizado do ambiente-alvo.
3. Corrigir SDK/env wiring e integrar uma fatia Hatchet real; depois certificar restart/crash, preservando ADRs.
4. Fazer CINEVISION por contrato observado antes de código.
5. Reexecutar suites do sistema em lane descartável; em paralelo seguro, coletar
   somente as evidências externas autorizadas (Asaas, WAHA, MK).
6. Revalidar staging, DR, observabilidade, frontend e performance no candidato;
   atualizar matriz e readiness com evidência direta.

Nenhuma dessas linhas autoriza tráfego real, compra, refund, mensagem a cliente,
ou alteração destrutiva de produção.
