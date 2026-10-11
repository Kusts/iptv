# Release closure gaps — 2026-10-11 (evening refresh, post-mainline-merges)

> **Atualização verificada 2026-10-11 (~20:29Z):** `origin/main` = `8ee77e7`
> (CI verde run `38172455461`). **MERGED:** #38/#39/#41/#45/#48/#49 (merges
> `fc372b7`, `01e978f`, `4850992`, `5bd7d7f`, `8ee77e7`); issues #46/#47
> CLOSED; **#42 CLOSED as integrated** (`b5066d6` contido em `main`,
> `6113526199`); **#37 ABERTO** no HEAD `5e8ced7`, CI verde
> (`38173356554`/`38173353428`), CLEAN/MERGEABLE, aguardando humano
> (`6113829042`). Trechos que listavam esses PRs como "abertos/não
> integrados" ficam como **histórico rotulado**. SEC-AUDIT-01:
> **CHANGES_REQUIRED** (P1 saturation-eviction em `rate-limit.store.ts`;
> #44 OPEN; SEC-FIX-01 em voo). F12/G01/PROV com trabalho em voo nos
> branches paralelos — **seguem BLOCKED**. Classificação: **ENGINEERING
> BLOCKED**.

Lista deduplicada derivada da [matriz de status](RELEASE-CLOSURE-STATUS.md).
Este arquivo não substitui os detalhes operacionais de P3/P6/P8, a matriz G/F,
ou o baseline.

## Bloqueios de engenharia

1. **Segurança da auditoria/dependências — CONTEÚDO MAINLINE 2026-10-11:** PR #38 (HEAD `d17540c`) Fastify nested runtime, PostCSS, sharp, source-map-js + parser fail-closed; PR #41 (HEAD `044be93`) Vitest 3→4.1.11 sem `tinypool` criticals (cadeia #38→#41 via merge `b0e80d5`); PR #42 (HEAD `b5066d6`, stack sobre #41 + fix #49 via merge `930ca44`) OTel 2.x/exporters 0.223.0 coerentes, Jaeger high removido por resolução real, prova OTLP automatizada; audit local 2 Moderate Next, 0 High/Critical, baseline vazia por intenção. **#38/#41/#49 MERGED** (conteúdo via merge mainline `fc372b7`; issue #47 CLOSED); **#42 CLOSED as integrated** (contenção de `b5066d6` em `main` verificada; CI verde `38141372169`/`38141369926`; fechamento `6113526199`) — sem revisão humana distinta registrada. **Histórico rotulado:** CI verde de #42 no HEAD `b5066d6`, vermelho anterior de `a004c57` (`38107760190`/`38107758085`, corrida de role cluster-global 050, nunca regressão OTel) e verde de `d44ea3c` como histórico; #49 (issue #47, `6cb0a0f`, `pnpm test --concurrency=1` + serialização `packages/database`) com CI verde `38135113763`/`38135100781`. Restam: gates DB-gated em PostgreSQL descartável pós-merge e collector OTLP real do ambiente-alvo. 320 testes DB-gated foram pulados sem DB na validação local; prova OTLP usa stub loopback e não valida collector real.
2. **F12 durable workflow — segue BLOCKED:** PR #39 (HEAD **`26c905a`**; anterior `32bde15` histórico) remove a declaração falsa de durabilidade e alinha o contrato de resolução do SDK Hatchet na documentação; CI verde `38092235210`/`38092231963`; thread P3 resolvido. **MERGED 2026-10-11** (merge mainline `8ee77e7`; honest-stub agora mainline) — sem revisão humana distinta registrada. Pesquisa em fontes oficiais confirma incompatibilidade do antigo main (`@hatchet-dev/hatchet`, `HATCHET_API_TOKEN/HATCHET_SERVER_URL` vs `@hatchet-dev/typescript-sdk`, `HATCHET_CLIENT_TOKEN`). **Fatia vertical candidata em voo** (`closure/f12-hatchet-wiring-20261011`, commit `0cd8223`: SDK `@hatchet-dev/typescript-sdk@1.37.0` registry/tarball-verificado, 28/28 testes de pacote segundo o autor) — código presente, **certificação real do engine (W0-04) ainda gateada**. F12 exige certificação W0-04 real + crash/replay/retry/HITL/idempotência/concurrency/tenant-isolation; sem certificação, sem reclassificação.
3. **CINEVISION writes:** nenhuma operação de criação está implementada na mainline. Observar contrato legítimo primeiro, depois adapter, readback, dispatcher, `UNKNOWN`/reconciliation e canário; manter manual até certificação. **Seams simulados em voo** (`closure/prov-mk-cine-20261011`) — sem efeito live; Fase 6 Steps 3/6–9 intactos como gates de operador/ambiente.
4. **Segurança de exposição:** PR #45 (anti-framing web `frame-ancestors 'none'` + `X-Frame-Options: DENY`, regressão Next web 129/129, CI `38097097482`/`38097083822`) **MERGED 2026-10-11** (merge `01e978f`; framing agora mainline) e ratelimit local de auth **MERGED** (merge `4850992`) — sem revisão humana distinta registrada. **Issue #44 segue OPEN** como gate remanescente (abuso de auth pública, enumeração de cadastro, validação IP/proxy/origin, rate limit distribuído): auditoria SEC-AUDIT-01 com veredito **CHANGES_REQUIRED** — bypass P1 saturation-eviction confirmado (`rate-limit.store.ts:120-142`), tradeoff P2 login-lockout registrado, proxy default seguro (`hops=0`), multi-réplica incoerente por construção; fix P1 em voo (SEC-FIX-01). Decisão do operador (histórico): preservar `201`/`409` no registro e somente conexão peer TCP enquanto não houver prova de proxy confiável; limites numéricos e política multi-réplica indefinidos. Sem prova dos controles do gateway ou restrição privada do piloto, não expor publicamente. Detalhe de superfície em P6-SECURITY (fora deste slice).
5. **Frontend E2E:** falta browser E2E da versão candidata cobrindo estados, permissões, responsividade e integração backend nos fluxos do escopo.
6. **G01 — perna outbound da jornada única — segue BLOCKED:** nenhum teste na mainline determina a cadeia inbound → identity/conversation → manual reply → outbound entregue exatamente 1×; `golden-loop` legs a-b para na persistência inbound e os envios M1 ao vivo foram `sendText` direto, não reply vinculado. **Implementação/validação em voo** (`closure/g01-waha-media-20261011`) — exige teste da cadeia completa + evidência live de reply vinculado antes de fechar G01; sem reclassificação neste slice.
7. **Asaas G3 — reorder: condição de mainline satisfeita 2026-10-11:** o teste determinístico de software para eventos fora de ordem/duplicados/atrasados/concorrência/reversal (PR #48, issue #46, HEAD `43d7821`, CI verde `38135069294`/`38135056127`; focado `commerce-billing` 21/21 contra PostgreSQL 17 fresco; zero chamadas de provider) **foi MERGED** (merge mainline `5bd7d7f`; issues #46/#47 CLOSED) — evidência test-only agora mainline. Bookkeeping formal de fechamento (re-run B2/lane pós-merge) segue pendente; **sem promoção de readiness neste slice docs-only**. G1/G2 e refund `SUCCEEDED` seguem gates de operador (item Gates 1).
8. **WAHA media/audio — segue BLOCKED:** não validados na mainline (`sendText` apenas). O gate canônico WAHA/GOWS MVP exige o caminho de media/audio (`10-integrations-certification.md:17-21`) e a matriz de aceite inclui a fixture de audio — **implementação/validação em voo** (`closure/g01-waha-media-20261011`); fechamento só com testes + recertificação, salvo mudança formal do baseline (não é decisão opcional de escopo).
9. **MK G07 — adapter real — segue BLOCKED:** o adapter do Browser Worker para MK não tem implementação na mainline (`commands.provider.ts`; apenas echo/manual). **Seams simulados em voo** (`closure/prov-mk-cine-20261011`) — sem compra/efeito econômico. Implementar e certificar o adapter autenticado (saldo privado, compra, ativação) continua pré-requisito de engenharia antes de qualquer compra controlada.
10. **Harness de CI — corrida de papel cluster-global (migration 050) — CORREÇÃO MAINLINE 2026-10-11:** tasks de teste concorrentes migrando bancos distintos do **mesmo cluster** colidiam ao criar o papel `outbox_worker` (23505 `pg_authid_rolname_index`); o advisory lock da 050 é por banco e não protege o papel. Foi a causa da falha do job `build` do PR #42 no HEAD `a004c57` (runs `38107760190`/`38107758085`) e **nunca foi regressão de produto**. O fix seguiu em PR #49 (`pnpm test --concurrency=1` + serialização dos test files de `packages/database`; sem mudança de migration/app code; CI verde `38135113763`/`38135100781`), levado ao branch do #42 pelo merge `930ca44` (CI do HEAD `b5066d6` verde `38141372169`/`38141369926`) e **MERGED à mainline** via stack `fc372b7` (issue #47 CLOSED). O vermelho histórico do #37 em `34008b7` (check `38140006569`, job `build` `114471743171`; push `38140003643` verde no mesmo HEAD) está superado no HEAD `5e8ced7` (CI verde). A issue #50 (timeout intermitente de teardown PostgreSQL em `outbox-worker`; histórico deste arquivo, sem verificação nova neste slice) segue em diagnóstico. Vermelho em `build` de stacks baseados em `main` anterior a `fc372b7` ainda pode ser a corrida: inspecionar o job antes de atribuir regressão ao código.

## Gates de operador / ambiente

1. **Asaas G1/G2:** liquidação PIX fiel no Sandbox e webhook público entregue à API. Refund `SUCCEEDED` ainda não demonstrado; nada de movimento financeiro sem autorização. (G3 moveu para bloqueios de engenharia — teste de eventos fora de ordem/duplicados/atrasados/concorrência/reversal.)
2. **WAHA M1/M2:** multi-session/deep reconnect e drill de fallback manual/restauração sem duplicidade. Não provocar ban/timelock. Media/audio é bloqueio de engenharia (gate canônico `10-integrations-certification.md`), não decisão de escopo — só o operador não fecha.
3. **MK G07:** conta/termos/teto de gasto e autorização para compra controlada; reconciliação do efeito econômico. Depende também do adapter real (bloqueio de engenharia item 9).
4. **Staging/certificações:** rehearsal após merge do candidato, versão/build, role real (`iptv_app`/worker), TLS/ingress, restart/rollback e secrets por identidade. Não ler ou registrar valores secretos.
5. **DR/observabilidade/performance:** offsite real + restore no ambiente alvo, RPO/RTO medidos (sem PITR claim), alertas comprovados e medições p95/p99 representativas.

## G/F e documentação

- `tests/release/pilot-evidence.yaml` — **nota de árvore 2026-10-11 (sem reclassificação neste slice docs-only):** o YAML do branch #37 registra 32 PASS / G01, G07 e F12 BLOCKED (G01→BLOCKED só existe no branch não mergeado); o YAML da mainline `8ee77e7` registra **33 PASS / G07 e F12 BLOCKED** (G01 PASS). **G01 segue BLOCKED como gap de engenharia** (validação em voo em `closure/g01-waha-media-20261011`) até evidência; este slice não altera `last_run` nem reclassifica. O
  re-run de software de 2026-10-09 comprovou as citações primárias `test:`
  (184/184), não os arquivos `evidence:` históricos; reexecutar evidência que
  corresponda ao requisito, sem alterar `last_run` por inferência. B2:
  re-run de software concluído; re-run integral (arquivos `evidence:` +
  gates G07/F12 + lane pós-merge) segue **aberto**.
- PR #37 — **HEAD atual `5e8ced7`** (merge de `origin/main`, 2026-10-11 17:42 -0300): **CI VERDE** nos runs `38173356554`/`38173353428`, `MERGEABLE` + `mergeStateStatus: CLEAN`, aguardando revisão/merge humano (`6113829042`; sem merges por agente). **HEADs verificados em sequência (histórico):** `51c81ee` CI verde (`38091653864`/`38091650697`); snapshot docs `7acbb10` verde em todos os jobs (`38138230248`/`38138227415`, CLEAN); 6/6 threads resolvidos, sem aprovação humana distinta. Follow-up docs-only `34008b7` teve **CI divergente no MESMO HEAD** (push `38140003643` verde; check do PR `38140006569` com job `build` `114471743171` FAILURE 12:40:11Z — 23505 `pg_authid_rolname_index` na migration 050, corrida de harness, não regressão e não o timing do browser-worker de `1c98a05`; demais jobs SUCCESS; `mergeStateStatus: UNSTABLE`) — **superado**: a causa (#49) está mainline e o HEAD atual é verde. Runs `83c1e4b` (`38000939821`/`38000943392`) e os de `463f1a8`/`a4b5acf` são históricos.
- **Merges mainline 2026-10-11 (~20:29Z; `origin/main` = `8ee77e7`, CI verde run `38172455461`):** #38 dependências + audit fail-closed (`d17540c`, conteúdo via `fc372b7`), #39 honest-stub (`26c905a`, via `8ee77e7`), #41 Vitest 4 (`044be93`, via `fc372b7`), #42 OTel 2.x (HEAD `b5066d6` — **CLOSED as integrated**, contenção em `main` verificada, CI verde `38141372169`/`38141369926`, fechamento `6113526199`; vermelhos/verdes anteriores como histórico), #45 anti-framing web (`c796e6c`, via `01e978f`), #48 cobertura G3 test-only (`43d7821`, via `5bd7d7f`), #49 fix corrida CI 050 (`6cb0a0f`, conteúdo via `fc372b7`; issues #46/#47 CLOSED). Sem revisão humana distinta registrada além de comentários.
- A CI da mainline (`8ee77e7`, run `38172455461` verde) é posterior a todos os merges do dia; CI verde de um PR não incorpora outros PRs por inferência (histórico: #41 incluía #38 via merge `b0e80d5`; #42 empilhado sobre #41 via `d0c5b8f`; #49 levado ao #42 via `930ca44` — cadeia preservada nos merges).
- Issues: **#46/#47 CLOSED** 2026-10-11; **#44 OPEN** (gate abuso de auth/rate limit; SEC-AUDIT-01 CHANGES_REQUIRED; SEC-FIX-01 em voo). Histórico deste arquivo (sem verificação nova neste slice): #1, #4, #7, #27, #40, #43 e #50 abertas; não criar duplicatas. Issue #40
  pede alternate-path permission/effect evals; avaliar sua relação com os
  gates P5/F09/F10 e definir um caso estreito antes de tratá-la como requisito
  bloqueador (sem ampliar escopo por referência acadêmica isolada).
  Revisar aplicabilidade/obsolescência após fechar os gates relacionados.

## Próxima sequência curta

1. Obter revisão/merge humano do PR #37 (HEAD `5e8ced7`, CI verde, CLEAN/MERGEABLE; sem merge automático por agente). #38/#39/#41/#45/#48/#49 já mainline; #42 fechado como integrado; issues #46/#47 closed. Issues #40/#43/#44/#50 seguem separadas (#44 OPEN com SEC-FIX-01 em voo).
2. Executar suites DB-gated em PostgreSQL vazio descartável pós-merge e validar OTLP contra collector autorizado do ambiente-alvo.
3. Certificar a fatia Hatchet candidata (gate W0-04 real); depois certificar restart/crash, preservando ADRs. F12 segue BLOCKED.
5. Fazer CINEVISION por contrato observado antes de código.
6. Reexecutar suites do sistema em lane descartável; em paralelo seguro, coletar
   somente as evidências externas autorizadas (Asaas, WAHA, MK).
7. Revalidar staging, DR, observabilidade, frontend e performance no candidato;
   atualizar matriz e readiness com evidência direta.

Nenhuma dessas linhas autoriza tráfego real, compra, refund, mensagem a cliente,
ou alteração destrutiva de produção.
