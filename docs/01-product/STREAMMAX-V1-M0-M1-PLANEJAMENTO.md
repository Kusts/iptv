# StreamMax V1 — planejamento M0–M1

> **Data:** 16/11/2026  
> **Natureza:** análise + planejamento; não certifica produção.  
> **Escopo:** processamento da PR #146 e primeiro marco STREAMMAX-V1-M0-M1.

## Homologação operacional (17/11/2026)

### OPS-1 — skill do Atendimento

No baseline, `team apply --dry-run` informou `No changes.`. Foi adicionada a skill `streammax-api` ao Atendimento em `teams/iptv/team.yaml`, sem `--prune`, e aplicada por `openmausbot team apply` no host Contabo `vmi3630510` (CLI 0.1.161). O segundo dry-run também informou `No changes.`. A skill consta ativa em `/api/bots/<id>/skills` (source: team file, sem warnings); os cinco bots IPTV estavam presentes com as skills esperadas.

Um turno sintético via `openmausbot run` (thread `860da5f6...`) percorreu wrapper → CLI real → API local simulada e retornou um plano sintético de R$ 30,00 (3000 minor), explicitamente rotulado como sintético. Não houve envio externo, cobrança ou ativação; a thread não tinha canal externo (`channels: []`) nem resposta duplicada. Wrapper/mock temporários foram removidos do host. Credencial de serviço real não foi provisionada. Este resultado não certifica produção.

### OPS-2 — catálogo e decisões comerciais

Nenhum catálogo comercial oficial vigente foi localizado em fonte versionada/configuração. Existe apenas seed sintético (`db/seeds/001_pilot_baseline.sql`: mensal R$ 30,00 com `synthetic:true`; adicional de conexão com `pricing:TBD`); custos CINEVISION são dados de supplier/discovery. A regra do PRD confirma R$ 30 mensal inicial, mas não constitui cadastro operacional vigente. Planos, preços, trial, benefícios, renovação e aprovação permanecem decisões **HUMANO**. Isso não bloqueou OPS-3/4; nenhum valor foi inventado.

### OPS-3 — staging

Staging Contabo foi verificado pelo alias `contabo-prod` (host `vmi3630510`, usuário deploy). `/home/deploy/iptv-staging` existe e `.staging-revision` contém `main@89b3f3a`, revisão anterior ao merge da PR #146/S2/migration 070. No Compose `iptv-staging`, api, web, outbox-worker e tunnel estavam healthy/up. API `/v1/health` retornou 200 (`scheduler: enabled`), `/v1/health/ready` 200 (`database: ok`) e web 200. Rotas S2 retornaram 404: S2 não está implantado nessa revisão. Não houve modificação no banco compartilhado, deploy ou toque em serviços vizinhos. A implantação de S2 em staging segue pendente de autorização específica de deploy.

### OPS-4 — integrações

- **Asaas:** software-verified: runtime por tenant com hosts allowlisted, `pgsecret://`, ingress de webhook e provisionamento idempotentes, além de testes unitários com fakes. Sandbox observado em 15/11 como `CONNECTED_READ_ONLY/UNKNOWN`. Homologação live/produção segue pendente (conta/autorização, replay amplo e rotação).
- **CINEVISION:** adapter Sigma M2M e probe read-only fail-closed implementados/testados. O caminho live está bloqueado por `CHALLENGE_DETECTED` e falta de token M2M autorizado. Operação vigente é manual supervisionada com readback; nunca automatizar nem contornar challenge.
- Pendências humanas: conta Asaas Produção e credencial/escopo CINEVISION. Nenhuma cobrança, ativação ou mensagem real ocorreu.

**Estado final:** MVP técnico implementado/validado localmente; homologação operacional real (staging com S2, Asaas live e CINEVISION live) continua pendente de autorização/credenciais. Item 5 (piloto) está fora do escopo.

## 1. Análise da PR #146

A PR foi baixada na branch `docs/streammax-v1-plano-produto-unificado` e contém cinco commits em quatro arquivos: `AGENTS.md`, `README.md`, `docs/12-roadmap/README.md` e `docs/01-product/STREAMMAX-V1-PLANO-UNIFICADO.md`. Sua decisão de produto é entregar primeiro a V1 própria da operação StreamMax, deixando SaaS para depois e mantendo OpenMausBot como motor compartilhado, não incorporado como código-base ao monorepo.

O plano ordena M0 (auditoria/inventário), M1 (atendimento e lead), M2 (venda e cobrança), M3 (entrega, suporte e renovação), M4 (limpeza e preparação do piloto) e M5 (piloto real controlado).

**Estados não equivalentes:** `MVP_STREAMMAX_OPERATIONAL` com 4/4 gates internos não comprova V1 comercial integrada; simulação sintética não é venda, pagamento ou ativação real; V1 comercial real exige jornada autorizada, evidência verificada e condições comerciais válidas.

## 2. Matriz M0 — inventário de destino

| Área | Decisão | Caminhos reais e justificativa |
|---|---|---|
| WAHA/comunicações | MANTER / INTEGRAR | `apps/api/src/communications/waha-webhook.controller.ts`, `waha-webhook.service.ts` (`WahaWebhookService.processRow`, resolveChannel → `communication.resolve_tenant_channel`, `acceptAtomic`, dedupe inbox, `message.ingest`, hook `AgentPipeline.evaluateInbound`), `waha-normalizer.ts`, `messaging-gateway.ts` (`message.send_manual` auditado; `handleSendManual`), `communications.commands.ts` (`handleIngest`). Já é o caminho oficial aproveitável. |
| Administração de sessão WAHA | CONCLUIR / INTEGRAR | `apps/api/src/integrations/whatsapp-sessions.*`, `apps/api/src/integrations/waha-admin.port.ts`; completar integração de administração sem criar segundo pipeline. |
| Billing/Asaas | MANTER | `apps/api/src/billing/asaas-webhook.controller.ts`, `asaas-webhook.service.ts`, `billing.commands.ts` (`charge.create` com binding; webhook_confirm com match de valor/moeda), `asaas-port.ts`, `ledger.ts`. Endurecimento avançado de refunds/chargeback fica PÓS-V1. |
| Outbox/scheduler | MANTER | `apps/api/src/scheduler/scheduler.service.ts`, `apps/api/src/outbox/outbox-drainer.ts` (claim `FOR UPDATE SKIP LOCKED`), opt-in `API_SCHEDULER_ENABLED`. Hatchet está fora do caminho. |
| CRM, catálogo, commerce, assinatura, renovação, fulfillment, suporte | MANTER base / INTEGRAR subconjunto no M1 | `apps/api/src/crm/crm.commands.ts` (`person.register`, `lead.capture`), `apps/api/src/commerce/catalog.controller.ts` (`GET /v1/catalog/plans`, capability `billing.read`), `commerce.commands.ts` (`offer.quote`, `order.submit`), `apps/api/src/subscription/`, `renewal/`, `fulfillment/`, `support/`. Reusar o mínimo vertical necessário. |
| AI runtime | MANTER; integração OpenMausBot CONCLUIR | `packages/ai-runtime/`, `apps/api/src/agent/pipeline.ts` (SHADOW por padrão; LIVE só com `ai.reply_autonomous`), `apps/api/src/agent/copilot.service.ts`. O wiring ao runtime existe no `WahaWebhookService`, atrás de `STREAMMAX_BOT_ENABLED` (default off); não há código OpenMausBot em `apps/` ou `packages/`. |
| Multi-tenant, RLS e segredos | MANTER | `packages/database/src/tenant-context.ts`, migrations RLS `db/migrations/041`–`059`, `packages/secrets/`, `db/migrations/068_platform_secret_values.sql` (`pgsecret://`). Nenhum valor de segredo foi consultado. |
| Web | MANTER / CONCLUIR; polimento PÓS-V1 | `apps/web/app/{conversations,orders,billing,subscriptions,support,trials,fulfillment,renewals,crm,settings,copilot,provider-operations}`. Reaproveitar as jornadas; polimento visual não bloqueia a fatia. |
| Testes e gates | MANTER | `apps/api/test/**`, `apps/web/test/**`, `tests/contracts/**`. Suítes de integração exigem `TEST_DATABASE_URL` apontando para banco descartável e vazio. |

**REMOVER APÓS TESTE:** não há candidato autorizado a remoção nesta etapa. Só remover depois de E2E comprovado, inventário antes/depois e rollback, conforme [critério de remoção da PR](./STREAMMAX-V1-PLANO-UNIFICADO.md#8-critério-rigoroso-para-remoção-de-código-morto).

## 3. Decisões e pendências de arquitetura

1. Deve existir um único pipeline WAHA ativo para a operação.
2. O bot StreamMax local e o `AgentPipeline` coexistem no webhook; M2/M3 ainda não estão ligados a esse caminho.
3. Definir ator de serviço do bot tenant-scoped com permissões mínimas, por exemplo `billing.read`, `crm.lead.write` e `conversation.reply`, conforme aplicável.
4. “Catálogo aprovado” é decisão de produto; não deduzir preço ou condição de fixture.
5. Ao integrar com AgentPipeline, impedir respostas duplicadas entre os dois caminhos.

## 4. Contrato mínimo bot↔API (capacidades desejadas)

Os itens abaixo são capacidades desejadas, **não endpoints existentes**: resolver/criar lead por contato WhatsApp; consultar planos ativos com preço ativo (`listSellablePlans`; catálogo aprovado depende de decisão de produto); criar/consultar pedido; solicitar cobrança/PIX; solicitar/consultar ativação e assinatura; solicitar renovação; criar/consultar ticket de suporte.

Invariantes: toda operação é tenant-scoped; a garantia de idempotência de cadastro depende do adaptador atômico do M1-B (unicidade tenant+wa_id ou chave idempotente), não deste núcleo puro. Bot não acessa SQL diretamente; não afirma pagamento, ativação ou renovação sem resposta verificada. Respostas ao cliente usam a capacidade auditada `message.send_manual`. A API continua fonte de verdade de estados e regras.

## 5. Primeiro caso E2E M1 (sintético)

Fluxo planejado, sem efeitos externos: ingresso `POST /v1/webhooks/waha/:tenantKey` com contato sintético → `message.ingest` vincula conversa → lógica de resolução + contrato (M1-A) solicita ao adaptador atômico do M1-B criar ou reaproveitar Person+Lead → consulta catálogo oficial → compõe resposta apenas com dados oficiais → envio auditado.

Aceite: repetição não duplica cadastro quando o adaptador do M1-B implementa atomicidade; nenhum preço ou prazo é inferido; não há cobrança nem ativação real. O wiring existe no `WahaWebhookService` atrás de `STREAMMAX_BOT_ENABLED` (default off), resolve lead antes de `message.ingest`, envia por `message.send_manual` auditado e exclui o outro pipeline para evitar dupla resposta. **A integração não foi verificada:** o teste de wiring foi pulado por ausência de `TEST_DATABASE_URL`; testes de integração requerem banco descartável vazio.

## 6. Riscos e incógnitas

- Duplicidade de ingestão ou de resposta se mais de um receptor/pipeline ficar ativo.
- Permissões, identidade do ator e vínculo de contato precisam preservar isolamento do tenant.
- Catálogo comercial, trial e direitos de oferta ainda dependem de decisão humana.
- Estado de staging e evidência histórica não certificam esta branch nem a V1 comercial.
- As seis decisões comerciais da [seção 10 da PR](./STREAMMAX-V1-PLANO-UNIFICADO.md#10-decisões-comerciais-ainda-necessárias) são: catálogo/preços e benefícios; política de trial; número/sessão WhatsApp e regras de contato; conta Asaas de produção e autorização; credencial/escopo/uso da API CINEVISION; direitos de comercialização e informações divulgáveis. Não bloqueiam M0/M1 técnico; fixtures devem ser usadas até definição.

## 7. Trabalho iniciado: M1-A

Está **iniciado**, não concluído nem homologado, o slice `M1-A`: contrato mínimo bot↔API e lógica de resolução de lead. O wiring ao webhook existe, mas permanece atrás de flag default off e sem prova de integração (teste de wiring pulado sem `TEST_DATABASE_URL`). A garantia de idempotência depende do adaptador do M1-B. M2/M3 existem apenas em contrato/adapter/queries e não estão ligados ao webhook.

## Decisões técnicas registradas (16/11/2026) — M1-B

1. **Fatia 0 verificada:** `message.ingest` (`communications.commands.ts`, `handleIngest`) registra `UNMATCHED_INBOUND` e retorna `conversationId: null` quando não encontra pessoa/thread; `WahaWebhookService.processRow` então não chama o bot. Com a flag ligada, resolução do lead precede o ingest, após validação da sessão, para criar/vincular a identidade WhatsApp.
2. **M1-B:** adapter in-process na API, sem endpoint HTTP nem service actor HTTP. Evita nova superfície de ataque e credenciais de serviço, reutiliza guards de envio e permite reversão pela flag. Usará ator sintético tenant-scoped no estilo de `agentActor`, com permissões mínimas.
3. **Idempotência:** sem migration nova. `identity.identities` já tem `identities_active_normalized_unique` por tenant/tipo/valor normalizado para identidades ativas (migration 002). Como `crm.leads` não tem unicidade por pessoa, o adapter serializa por `pg_advisory_xact_lock(hashtextextended(tenant||':WHATSAPP:'||wa_normalizado, 0))`, em `withTenantTransaction`, faz SELECT antes do INSERT e reutiliza `normalizeIdentity` de `crm.commands.ts`. Migration append-only para unicidade de leads foi descartada por ora: acrescentaria regra de negócio e poderia falhar com dados reais.
4. **Catálogo:** extrair a query de planos ativos com preço ativo para `apps/api/src/commerce/catalog-queries.ts` (`listActiveSellablePlans`), usada pelo endpoint existente e pelo adapter; mudança move-only, sem alterar comportamento HTTP.
5. **Coexistência:** `STREAMMAX_BOT_ENABLED`, default desligada e carregada por `packages/config` (valor vazio é ausente). Ligada, o bot elegível substitui o pipeline; após tentativa de envio não há fallback, mesmo em recusa, evitando dupla resposta. Desligada, preserva o fluxo atual. Áudio/transcrição (`groq-transcription.service.ts`) fica fora do bot no M1-B. Envio usa `message.send_manual` auditado, com idempotência derivada de `externalMessageId`.
6. **Contrato JSON congelado para consumo futuro, ainda não exposto:** `ResolveLeadRequest { tenantId, waId, name? }` → `ResolveLeadResponse { personId, leadId, isNew }`; `ListPlansRequest { tenantId }` → `ListPlansResponse { plans: [{ planId, name, amountMinor: string, currency }] }`; `ReplyRequest { tenantId, conversationId, inboundMessageId, waId, name? }` → `ReplyResponse { handled, text?, sent, reason?: "flag_off"|"not_eligible"|"takeover"|"paused"|"duplicate"|"error" }`. Valores monetários são strings, não bigint JSON; `tenantId` vem do contexto do canal WAHA, nunca do payload externo.
7. OpenMausBot não é alterado nesta fatia. Consumo externo via endpoint depende da decisão de produto sobre service actor/token e fica para depois do M1-B; o contrato acima evita redesenho.
8. Testes de integração PostgreSQL foram provados: 5/5 com banco real. Isso comprova somente essa integração, não homologa a V1 nem altera os bloqueios comerciais.
9. **M5 permanece BLOCKED:** piloto de produção exige autorização explícita para pagamento e ativação reais, além de número/conta de produção; nada disso foi autorizado nesta missão.

## 9. Auditoria M4-A e decisão M4-B

**M4-A encerrada sem remoções.** A auditoria somente leitura não identificou candidato seguro de remoção no escopo V1; coexistências são intencionais/flag-gated ou ainda não têm substituto provado. Preservar `apps/api/src/bot/*` (inclusive com flag default off), `AgentPipeline` e rotas `/v1/agent/*`, `packages/ai-runtime` e `@iptv/ai-runtime`, webhook/service/gateway/sessão/mídia/transcrição WAHA, webhook/service/commands de billing Asaas, fallbacks echo/local e flags operacionais, todas as migrations append-only, baseline v1.0.1, contratos canônicos, registries de eventos e espelhos exigidos pelos gates.

Investigar em fatias futuras, sem remover: sobreposição de longo prazo entre runtime IA interno e equipe OpenMausBot; capacidades M2/M3 do bot existentes mas não acionadas pelo caminho de resposta do webhook; artefatos versionados `packages/ai-runtime/dist/*`; duplicidade WAHA/Asaas no repositório externo OpenMausBot. Limpeza incorreta pode causar dupla resposta ou silêncio (flag, `sendAttempted`, elegibilidade ou fallback), quebrar HITL/evals/copilot, regredir ingestão/entrega WhatsApp/Asaas ou violar invariantes financeiros. O relatório fundamenta fatias futuras pequenas e testáveis, não declara outras etapas concluídas.

**M4-B:** verificação no repositório OpenMausBot confirmou que não há mecanismo existente para executar o contrato S1; S2 (service actor/autenticação de serviço e menor interface HTTP) é necessário. Como a ponte WAHA do OpenMausBot também envia mensagens, fixar dono único da resposta; recomenda-se OpenMausBot devolver somente texto e StreamMax enviar via WAHA. M5 continua BLOCKED.

## 8. Próximos marcos e fontes

- **M1-B:** wiring implementado, mas não verificado em integração; teste PostgreSQL permanece BLOCKED sem Docker e `TEST_DATABASE_URL` para banco descartável vazio.
- **M2/M3:** capacidades presentes apenas em contrato/adapter/queries; não ligadas ao webhook.
- **M5:** BLOCKED até autorização explícita e confirmação dos recursos reais necessários.

- **M2:** integrar plano, pedido e PIX; validar Asaas Sandbox E2E com callback/replay, sem confundir Sandbox com produção.
- **M3:** ativação CINEVISION inicialmente manual supervisionada, suporte, vencimento e renovação idempotente.
- **M4:** remover apenas duplicações comprovadamente substituídas; validar jornada em staging, documentação, recuperação e rollback.
- **M5:** piloto controlado com condições, autorizações e recursos reais confirmados; evidenciar venda e primeira renovação reais.

O [baseline de implementação v1.0.1](../15-implementation-baseline/README.md) é a referência técnica dos contratos existentes até revisão explícita. O [snapshot operacional de 15/11](../16-pilot-closure/STREAMMAX-MVP-STATUS-2026-11-15.md) e demais snapshots são evidência histórica datada, não autoridade para declarar a V1 pronta nem prova do estado atual. A direção de produto está no [plano unificado](./STREAMMAX-V1-PLANO-UNIFICADO.md); prevalecem os contratos do baseline quando houver conflito técnico até sua revisão formal.

### Consolidação M4 (17/11/2026)

- **M4-A concluído:** auditoria encerrada sem remoções. Preservar bot in-process, AgentPipeline, ai-runtime, WAHA/Asaas, fallbacks e migrations append-only; sobreposições ficam investigar mais.
- **M4-B concluído (S2):** OpenMausBot sem mecanismo de integração. Migration 070 append-only: hash SHA-256 de pepper:token, pepper separado com mínimo 32 caracteres (não pgsecret), escopo bot.streammax.execute, validade máxima 365 dias, resolve_bot_credential; iptv_app somente SELECT. Flags STREAMMAX_BOT_API_ENABLED/BOT_SERVICE_TOKEN_PEPPER; guard 404/503/401/403, tenant derivado da credencial e corpo strict (tenant* → 400). Script emit-bot-credential.mjs; rotas POST /v1/bot/streammax/{list-plans,resolve-lead,reply}. Reply sem envio (sent:false, flag_off quando STREAMMAX_BOT_ENABLED=true); idempotência bot-api:lead:*. Corrigidos reutilização de pessoa, leitura com withTenantTransaction sem derrubar takeover e fallback ao AgentPipeline com bot ligado. Revisão de segurança APPROVED.
- **M4-C concluído:** E2E sintético apps/api/test/streammax-v1-journey.integration.test.ts 6/6: entrada WAHA/identidade/resposta; catálogo ou neutro; pedido+PIX simulado; webhook PAID + redelivery; ativação/fulfillment manual + suporte; consistência final. Gateway/adapters simulados; nada real.
- Evidências informadas: PostgreSQL 17 descartável; lint/typecheck/build exit 0 confirmados pelo Planner; gates Python a validar; re-revisão de segurança APPROVED. Homologação SINTÉTICA, não produção.
- M4-A/B/C CONCLUÍDOS; M5 BLOCKED; S5 (consumo no OpenMausBot em staging) NÃO executado, depende de autorização. Sem promoção à produção.

### Consolidação S5 (17/11/2026)

- **S5 concluído em homologação LOCAL/SINTÉTICA:** CLI real em `D:\projetos\OpenMausBot\bots\streammax\cli\streammax.mjs` (`list-plans`, `resolve-lead`, `reply`), documentação em `bots/streammax/README.md` e skill `teams/iptv/skills/streammax-api/SKILL.md`. Testes próprios da CLI: 5/5 (`node --test`).
- **Integração cross-repo real:** `apps/api/test/streammax-v1-crossrepo.integration.test.ts`, 6/6: CLI real consumiu API real do StreamMax em porta efêmera com banco descartável e credencial sintética. Cobriu list-plans, resolve-lead com reutilização idempotente de identidade, reply seguro (`sent:false`, sem promessa financeira), token inválido rejeitado e API indisponível sem resposta inventada. Dono único da resposta preservado (`STREAMMAX_BOT_ENABLED=false`): o bot externo só compõe texto; a ponte WAHA do bot é quem envia.
- **Correção de contrato:** `replySchema` da API aceita `waId` e `name` opcionais, evitando o 400 que divergiria do contrato congelado.
- Evidências informadas: pacote API 132/132 arquivos, 1523 testes passaram e 1 pulado; CLI 5/5; lint/typecheck/build exit 0. Gates Python devem ser verificados separadamente. Execução toda sintética: nenhum deploy, pagamento, ativação ou mensagem real.
- **Pendências:** associação da skill ao time IPTV requer `openmausbot team apply --dry-run` e autorização; não executado. S5 em staging e M5 (produção) dependem de autorização específica. Não declarar produção homologada.

### Fechamento do catálogo comercial aprovado (17/11/2026)

- O Proprietário do StreamMax aprovou em 17/11/2026 o catálogo V1.0, status `approved`, registrado canonicamente em `docs/01-product/CATALOGO-COMERCIAL.md`.
- Planos: mensal R$ 30 (3000 minor), trimestral R$ 75 (7500), semestral R$ 150 (15000) e anual R$ 300 (30000). O addon único `additional-connection` tem preço por período em `segment_key`: P1M=2000, P3M=6000, P6M=10000, P12M=15000. Total = preço do plano + quantidade de telas × preço por tela no período.
- Trial: 6 horas grátis, uma vez por usuário; retry somente com problema técnico comprovado. Renovação ocorre após pagamento. Desconto antecipado de R$ 5 segue PENDENTE da decisão A (somente plano) ou B (plano + telas), portanto não é regra executável.
- Implementação reportada: `apps/api/src/commerce/approved-catalog.ts` contém cálculo puro; `scripts/seed-approved-catalog.mjs` faz carga idempotente/auditável, com dry-run padrão e `--apply` explícito. `apps/api/src/commerce/commerce.commands.ts` aceita `segmentKey` opcional em `activePrice` e por item em `offer.quote`; `PLAN` com `segmentKey` resulta em `validation_failed`.
- Validação reportada: 13 testes (unitários 11 e integração em 2 arquivos) com PostgreSQL descartável; typecheck, lint e `node --check` verdes. Carga em banco descartável comprovou 4 planos, 1 addon e 4 preços; segunda execução não duplicou registros.
- `listActiveSellablePlans` retorna os quatro planos com preços. `GET /v1/catalog/plans` expõe planos, mas não addon (lacuna registrada); o bot lê planos por `list-plans`.
- Pendências: decidir A/B do desconto; expor addons na API/bot se necessário; identificar ambiente e obter autorização de escrita antes de gravar no catálogo operacional real. Nada disso foi feito. Deploy em staging e M5 permanecem fora do escopo.
