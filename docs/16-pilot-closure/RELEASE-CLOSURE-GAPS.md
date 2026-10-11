# Release closure gaps — 2026-10-11

Lista deduplicada derivada da [matriz de status](RELEASE-CLOSURE-STATUS.md).
Este arquivo não substitui os detalhes operacionais de P3/P6/P8, a matriz G/F,
ou o baseline.

## Bloqueios de engenharia

1. **Segurança da auditoria/dependências:** PR #38 (HEAD `d17540c`, base `main`) corrige Fastify nested runtime, PostCSS, sharp, source-map-js e endurece parser; PR #41 (HEAD `044be93`, base `main`) migra Vitest 3→4.1.11 e remove `tinypool` criticals; PR #42 (HEAD combinado **`a004c57`**, stacked sobre #41) migra o conjunto OTel coerentemente para SDK 2.x/exporters 0.223.0, remove o Jaeger high e adiciona prova OTLP. Audit local na candidata #42: 2 findings Moderate do Next, 0 High/Critical, baseline vazia por intenção. **Estado de CI (2026-10-11): #38/#41 verificadas; #42 FALHA no HEAD `a004c57`** (runs `38107760190`/`38107758085`, job `build`) por corrida de papel cluster-global na migration 050 — 23505 `pg_authid_rolname_index` (`outbox_worker` já existe) quando tasks de teste concorrentes migram bancos distintos do mesmo cluster; o advisory lock é por banco. **Não é regressão OTel.** O #42 só foi verde no HEAD anterior `d44ea3c` (runs `38009127852`/`38009131299`). PR #49 (issue #47, HEAD `6cb0a0f`, base `main`) corrige a causa-raiz na CI (`pnpm test --concurrency=1` + serialização dos test files de `packages/database`; sem migration/app code); CI verde nos runs `38135113763`/`38135100781` (todos os jobs) — **não integrado**. #42 não é decision-ready até merge-back normal de #41/#49 + CI verde no HEAD resultante. PRs aguardam revisão humana/merge. 320 testes DB-gated foram pulados sem DB; prova OTLP usa stub loopback e não valida collector real.
2. **F12 durable workflow:** PR #39 (HEAD **`26c905a`**, base `main`; HEAD anterior `32bde15` é histórico) remove a declaração falsa de durabilidade e alinha o contrato de resolução do SDK Hatchet na documentação; CI completo verde nos runs `38092235210`/`38092231963`, thread P3 corrigido/resolvido, revisão humana ainda pendente. Pesquisa em fontes oficiais confirma que o package name e variáveis de ambiente atuais no main estão incompatíveis com SDK TypeScript publicado (`@hatchet-dev/typescript-sdk`, `HATCHET_CLIENT_TOKEN`). PR #39 não corrige wiring/env, não integra producer/worker e não certifica Hatchet. F12 exige integração real conforme ADR-0019 e execução de crash/replay/retry/HITL/idempotência/concurrency/tenant-isolation.
3. **CINEVISION writes:** nenhuma operação de criação está implementada. Observar contrato legítimo primeiro, depois adapter, readback, dispatcher, `UNKNOWN`/reconciliation e canário; manter manual até certificação.
4. **Segurança de exposição:** rate limit de login/cadastro e security headers (CSP/frame policy etc.) não estão provados no ingress efetivo. PR #45 (HEAD `c796e6c`, base `main`) adianta a política de anti-framing da web (`frame-ancestors 'none'` + `X-Frame-Options: DENY`) com regressão pelo matcher/rotas do Next (web 129/129; CI verde `38097097482`/`38097083822`); **issue #44 permanece aberta** para abuso de auth pública, resíduo de enumeração de cadastro, validação de IP/proxy/origin e rate limit. Decisão do operador: preservar `201`/`409` no registro e somente conexão peer TCP enquanto não houver prova de proxy confiável; limites numéricos e política multi-réplica indefinidos. Sem prova dos controles do gateway ou restrição privada do piloto, não expor publicamente.
5. **Frontend E2E:** falta browser E2E da versão candidata cobrindo estados, permissões, responsividade e integração backend nos fluxos do escopo.
6. **G01 — perna outbound da jornada única:** nenhum teste determina a cadeia inbound → identity/conversation → manual reply → outbound entregue exatamente 1×; `golden-loop` legs a-b para na persistência inbound e os envios M1 ao vivo foram `sendText` direto, não reply vinculado. Exige teste da cadeia completa + evidência live de reply vinculado antes de fechar G01.
7. **Asaas G3 — reorder:** o teste determinístico de software para eventos fora de ordem/duplicados/atrasados/concorrência/reversal estava ausente; agora existe como **candidata test-only** em PR #48 (issue #46, HEAD `43d7821`, base `main`; CI verde `38135069294`/`38135056127`; focado `commerce-billing` 21/21 contra PostgreSQL 17 fresco; zero chamadas de provider). **Não integrado**: G3 continua BLOCKED até que #48 entre na mainline — rodada de operador não supre o teste e a existência da candidata não o fecha.
8. **WAHA media/audio:** não implementados (`sendText` apenas). O gate canônico WAHA/GOWS MVP exige o caminho de media/audio (`10-integrations-certification.md:17-21`) e a matriz de aceite inclui a fixture de audio — implementação + testes + recertificação, salvo mudança formal do baseline (não é decisão opcional de escopo).
9. **MK G07 — adapter real:** o adapter do Browser Worker para MK não tem implementação (`commands.provider.ts`; apenas echo/manual). Implementar e certificar o adapter autenticado (saldo privado, compra, ativação) é pré-requisito antes de qualquer compra controlada.
10. **Harness de CI — corrida de papel cluster-global (migration 050):** tasks de teste concorrentes migrando bancos distintos do **mesmo cluster** colidem ao criar o papel `outbox_worker` (23505 `pg_authid_rolname_index`); o advisory lock da 050 é por banco e não protege o papel. Foi a causa da falha do job `build` do PR #42 no HEAD `a004c57` (runs `38107760190`/`38107758085`) e **não é regressão de produto**. A correção candidata está em PR #49 (`pnpm test --concurrency=1` + serialização dos test files de `packages/database`; sem mudança de migration/app code; CI verde `38135113763`/`38135100781`), ainda não integrada — #42 só volta a ser decision-ready após merge-back normal e CI verde. A issue #50 (timeout intermitente de teardown PostgreSQL em `outbox-worker`) segue aberta em diagnóstico. Até a integração, vermelho no `build` pode ser corrida de harness: inspecionar o job antes de atribuir regressão ao código.

## Gates de operador / ambiente

1. **Asaas G1/G2:** liquidação PIX fiel no Sandbox e webhook público entregue à API. Refund `SUCCEEDED` ainda não demonstrado; nada de movimento financeiro sem autorização. (G3 moveu para bloqueios de engenharia — teste de eventos fora de ordem/duplicados/atrasados/concorrência/reversal.)
2. **WAHA M1/M2:** multi-session/deep reconnect e drill de fallback manual/restauração sem duplicidade. Não provocar ban/timelock. Media/audio é bloqueio de engenharia (gate canônico `10-integrations-certification.md`), não decisão de escopo — só o operador não fecha.
3. **MK G07:** conta/termos/teto de gasto e autorização para compra controlada; reconciliação do efeito econômico. Depende também do adapter real (bloqueio de engenharia item 9).
4. **Staging/certificações:** rehearsal após merge do candidato, versão/build, role real (`iptv_app`/worker), TLS/ingress, restart/rollback e secrets por identidade. Não ler ou registrar valores secretos.
5. **DR/observabilidade/performance:** offsite real + restore no ambiente alvo, RPO/RTO medidos (sem PITR claim), alertas comprovados e medições p95/p99 representativas.

## G/F e documentação

- `tests/release/pilot-evidence.yaml`: 32 PASS / G01, G07 e F12 BLOCKED. O
  re-run de software de 2026-10-09 comprovou as citações primárias `test:`
  (184/184), não os arquivos `evidence:` históricos; reexecutar evidência que
  corresponda ao requisito, sem alterar `last_run` por inferência. B2:
  re-run de software concluído; re-run integral (arquivos `evidence:` +
  gates G07/F12 + lane pós-merge) segue **aberto**.
- PR #37 (HEAD `51c81ee`) contém reconciliação de evidências + matriz/gaps e aguarda revisão/merge humano. **CI verde nos runs `38091653864`/`38091650697` em todos os jobs** (`build`, `security-scans`, `adversarial`, `outbox-050-role-guards`); os 6 threads de review estão resolvidos e não há aprovação humana distinta. Runs `83c1e4b` (`38000939821`/`38000943392`) e os de `463f1a8`/`a4b5acf` são históricos, não validam HEADs atuais.
- PRs abertos adicionais (verificado 2026-10-11): #38 dependências + audit fail-closed (`d17540c`), #39 correção do claim de durabilidade (`26c905a`), #41 Vitest 4 (`044be93`), #42 OTel 2.x coerente (**HEAD combinado `a004c57` com `build` vermelho** por corrida de role 050 — histórico verde em `d44ea3c`, runs `38009127852`/`38009131299`), #45 anti-framing web (`c796e6c`, CI verde `38097097482`/`38097083822`), #48 cobertura G3 Asaas test-only (`43d7821`, CI verde `38135069294`/`38135056127`), #49 correção da corrida de CI da 050 (`6cb0a0f`, CI verde `38135113763`/`38135100781`). Todos aguardam revisão humana e integração; **nenhum foi merged**.
- A CI da main (`2f181e8`) é anterior ao PR #37 e a todas as candidatas; CI verde de um PR não valida a main nem incorpora outros PRs por inferência. #41 tem base declarada `main`, mas sua ancestralidade inclui todo #38 via merge `b0e80d5`; #42 é empilhado sobre #41 e herda #38/#41. #38/#41/#45/#48/#49 têm base declarada `main`; como #49 ainda não foi integrado nem levado por merge-back a #42, o vermelho de #42 permanece válido para o HEAD `a004c57` e não é apagado por CI verde de #49.
- Issues abertas: #1, #4, #7, #27, #40, #43, #44, #46, #47 e #50; não criar duplicatas. Issue #44
  é o gate remanescente de abuso de auth pública/enumeração de cadastro/validação
  IP-proxy-origin/rate limit (com a fatia de framing da #45 pendente de merge); #46
  (G3 Asaas) e #47 (corrida de role na CI) têm candidatas #48 e #49 respectivamente,
  ainda não integradas; #50 é diagnóstico de teardown intermitente. Issue #40
  pede alternate-path permission/effect evals; avaliar sua relação com os
  gates P5/F09/F10 e definir um caso estreito antes de tratá-la como requisito
  bloqueador (sem ampliar escopo por referência acadêmica isolada).
  Revisar aplicabilidade/obsolescência após fechar os gates relacionados.

## Próxima sequência curta

1. Obter revisão humana e integrar PRs #37, #38, #39, #41, #42, #45, #48 e #49 somente pelo fluxo normal (sem merge automático); issues #40/#43/#44/#46/#47/#50 seguem separadas.
2. Integrar primeiro a correção de harness #49 (e #41) e só então atualizar o stack #42; revalidar CI no HEAD resultante antes de qualquer decisão de merge — o vermelho atual de #42 é histórico em `a004c57`.
3. Executar suites DB-gated em PostgreSQL vazio descartável e validar OTLP contra collector autorizado do ambiente-alvo.
4. Corrigir SDK/env wiring e integrar uma fatia Hatchet real; depois certificar restart/crash, preservando ADRs.
5. Fazer CINEVISION por contrato observado antes de código.
6. Reexecutar suites do sistema em lane descartável; em paralelo seguro, coletar
   somente as evidências externas autorizadas (Asaas, WAHA, MK).
7. Revalidar staging, DR, observabilidade, frontend e performance no candidato;
   atualizar matriz e readiness com evidência direta.

Nenhuma dessas linhas autoriza tráfego real, compra, refund, mensagem a cliente,
ou alteração destrutiva de produção.
