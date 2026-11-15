# Triagem do backlog — 15/11/2026

Base: issues abertas informadas para esta triagem; PRs #142–#144 merged.
Evidências de integração ao vivo/staging são datadas e não constituem autorização
para escrita externa.

| Issue | Título curto | Classe | Evidência objetiva | Ação |
|---|---|---|---|---|
| #136 | OpenAPI pedidos/cobranças | RESOLVIDA | PR #143 integrou OpenAPI e gate de paridade de rotas; CI da main verde. | Fechar. |
| #89 | Painel de integrações | MVP-PILOT | PR #144; testes de componentes verdes; caminhada autenticada ainda não feita. | Manter aberta até operador owner verificar estados no navegador; ver [homologação](INTEGRATIONS-HOMOLOGATION-2026-11-15.md). |
| #88 | CINEVISION | MVP-PILOT | Staging `TESTING/UNAVAILABLE`, `CHALLENGE_DETECTED`; simulação/fail-closed testados. | Manter aberta até operador autorizado obter leitura legítima sem challenge e homologar; ver [homologação](INTEGRATIONS-HOMOLOGATION-2026-11-15.md). |
| #87 | WhatsApp/WAHA | MVP-PILOT | Software testado; staging `NOT_CONFIGURED/UNKNOWN`. | Manter aberta até número autorizado pareado, WAHA acessível e sessão `WORKING`; ver [homologação](INTEGRATIONS-HOMOLOGATION-2026-11-15.md). |
| #86 | Asaas | MVP-PILOT | Staging Sandbox `CONNECTED_READ_ONLY/UNKNOWN`; testes de software verdes. | Manter aberta até conta A/B Sandbox e canal webhook autorizados e evidências de fluxo/reconexão; ver [homologação](INTEGRATIONS-HOMOLOGATION-2026-11-15.md). |
| #74 | Outbox worker | RESOLVIDA | `apps/outbox-worker/test/worker.test.ts` 16 verdes; dispatch durável com fencing/VERIFYING; integração CI verde. | Fechar. |
| #58 | MK Ativador | POST-MVP | Diferido por ADR-0027; fallback manual supervisionado. | Manter diferida; reabrir somente com decisão pós-MVP e requisito operacional autorizado. |
| #51 | Identity gate CINEVISION | RESOLVIDA | Identity gate/reauth bounded em `cinevisionCommand.ts`, coberto por testes. | Fechar. |
| #44 | Abuso de autenticação/borda | MVP-PILOT | Headers implementados/testados; rate-limit proxy default 0; CORS `credentials:false`; register 403. | Manter aberta até evidência de borda antes de tráfego público irrestrito. |
| #43 | Browser ownership/quiescence | RESOLVIDA | Open/quiescence ownership-safe em `browser.ts`; `browser.test.ts` e `cinevisionCommand.test.ts` verdes. | Fechar. |
| #27 | Benchmark runtimes/modelos | POST-MVP | ADR-0028 mantém modo local honesto; decisão Hatchet condicionada por ADR-0019. | Manter diferida; reabrir quando houver necessidade demonstrada e decisão de runtime conforme ADRs. |
| #7 | RLS/global | MVP-PILOT (tracking) | P1 entregue; snapshot registra RLS 139/155 e FORCE RLS 0; job CI de guards verde. | Manter aberta até completar itens residuais de cobertura global e cutover, sem inferir que FORCE RLS esteja ativo. |
| #4 | Benchmark runtimes/modelos | POST-MVP | ADR-0028/ADR-0019 delimitam runtime e certificação externa; não é bloqueio do piloto restrito. | Manter diferida; reabrir com requisito mensurável de produto/runtime pós-MVP. |
| #1 | Ampliação do backlog de workflows | POST-MVP | ADR-0028 mantém modo local honesto; ADR-0019 condiciona adoção Hatchet à certificação. | Manter diferida; reabrir por requisito concreto fora do escopo atual, conforme ADRs. |

## Triagem de confiabilidade

Coberto por testes/inspeção de código: headers e anti-framing (`security-headers.ts`,
`next.config.mjs`), rate-limit com trusted-proxy default 0, CORS sem credentials,
register fechado 403, identity gate, browser ownership/quiescence e dispatch
durável outbox com fencing/VERIFYING. Os testes e seus limites estão descritos
na [homologação](INTEGRATIONS-HOMOLOGATION-2026-11-15.md).

Limitação arquitetural conhecida: rate-limit/store em memória é por processo e
não fornece coordenação multi-réplica. Evidência de configuração e controle real
na borda exige ambiente externo: Cloudflare/WAF, trusted-proxy, exposição/rede e
comportamento multi-réplica. Não inferir segurança de borda a partir dos testes
unitários; #44 segue aberto até essa comprovação.

## MVP-PILOT por área do contrato

Referência: [baseline, §MVP-PILOT](../15-implementation-baseline/01-product-and-mvp.md#mvp-pilot).
“Software presente” indica superfície/implementação, não homologação; nenhuma
área abaixo é declarada homologada live.

| Área | Estado do software (evidência de superfície) | Homologado | Lacuna real |
|---|---|---|---|
| Multi-tenancy, identity, RBAC, audit | Presente (`apps/api/src/tenants/`, auth/audit) | Não | Evidência residual RLS global/cutover (#7). |
| CRM | Presente (`apps/web/app/crm`, API CRM) | Não | Caminhada autenticada de ponta a ponta. |
| Inbox e WAHA/GOWS | Presente (`apps/api/src/integrations/`, `apps/web/app/conversations`) | Não | Pairing autorizado WAHA; estado externo. |
| Customer Agent e Tenant Copilot | Presente (copilot) | Não | Maturidade/avaliação G18. |
| Trial, Retrial e Technical Access | Presente (`apps/web/app/trials`, API trials) | Não | Validação operacional do fluxo completo. |
| Product/Plan/Offer/PriceBook/Order | Presente (`apps/web/app/orders`, controllers correspondentes) | Não | Jornada autenticada no staging. |
| Asaas PIX, webhooks, reconciliação | Presente (`apps/api/src/billing/`, `apps/web/app/billing`) | Não | Conta A/B, webhook e evidências externas. |
| Subscription, cycles, entitlements | Presente (`apps/web/app/subscriptions`, API subscriptions) | Não | Primeira venda/renovação autorizada real. |
| CINEVISION browser/reconciliation | Presente (`apps/browser-worker`, provider API) | Não | Challenge impede leitura live; fallback manual. |
| Support/Diagnostics/HITL | Presente (`apps/web/app/support`, `apps/web/app/hitl`) | Não | Caminhada autenticada e evidência operacional. |
| Campaigns, referral, rewards | Presente (`apps/web/app/growth`, `apps/web/app/referrals`) | Não | Homologação de campanha/referral. |
| Reseller core | Presente (`apps/web/app/resellers`) | Não | Homologação operacional. |
| Finance/unit economics/analytics | Presente (`apps/web/app/finance`, `apps/web/app/analytics`) | Não | Primeira venda real e conferência financeira. |
| Ledger posting/reversal | Presente (billing/ledger API) | Não | Prova com evento financeiro externo autorizado. |
| Knowledge/memory core | Presente (`apps/web/app/knowledge`) | Não | Caminhada autenticada. |
| Control Center, Design System, mobile flows | Presente (`apps/web/app/settings`) | Não | Caminhada autenticada e evidência de fluxos críticos/mobile. |

Rotas web existentes usadas como evidência de superfície: `/analytics`,
`/billing`, `/knowledge`, `/conversations`, `/copilot`, `/crm`, `/finance`,
`/fulfillment`, `/growth`, `/hitl`, `/inventory`, `/orders`,
`/provider-operations`, `/referrals`, `/renewals`, `/resellers`, `/settings`,
`/subscriptions`, `/support` e `/trials`. A API correspondente está organizada
em controllers sob `apps/api/src/*`; existência de rota/controller não é
homologação de ponta a ponta.

## MVP-SAAS

Reutilizáveis: tenancy/RLS/RBAC/audit, hub de integrações, billing core, ledger,
analytics e Control Center/settings. `apps/api/src/tenants/tenants.controller.ts`
prova superfície de tenancy, não lifecycle SaaS. Ausentes: Platform Admin UI
para lifecycle de tenant (não há páginas administrativas em
`apps/web/app/settings`), SaaS Plan/PlanVersion/PlatformSubscription,
billing/uso SaaS, onboarding/import/Go-Live, pricing comercial e export/retention.
Antes de clientes externos, implementar e validar estes componentes e definir
seus controles operacionais e comerciais.

## Próximo plano priorizado

1. Fechar evidências externas #86–#89 com operador, sem código: pré-requisito
   das integrações e do painel.
2. Executar primeira venda e renovação real autorizadas no staging: depende de
   canal/provedor disponível e demonstra o ciclo comercial após homologação.
3. Caminhada autenticada no navegador do painel e da jornada, sem adicionar
   framework: valida a experiência real depois de backend e operador habilitados.
4. Produzir evidência de borda #44: necessária antes de exposição pública irrestrita.
5. Fechar itens residuais de RLS global (#7): controle de isolamento/cutover
   antes de ampliar o uso.
6. Evoluir maturidade do Tenant Copilot/G18: depende de operação estável e
   avaliação observável, sem bloquear o caminho manual do piloto.
7. POST-MVP: itens #58/#27/#4/#1 só após requisito e decisão previstos nos ADRs.

Esta ordem respeita dependências externas primeiro, depois prova da jornada,
depois controles de expansão; não é uma estimativa percentual de conclusão.
