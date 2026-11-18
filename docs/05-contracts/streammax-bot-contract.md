# Contrato JSON do bot StreamMax

- Data: 17/11/2026
- Natureza: contrato S2 implementado para consumo futuro do OpenMausBot.
- Homologação **SINTÉTICA, não produção**; este documento não autoriza produção.
- `STREAMMAX_BOT_API_ENABLED` e `STREAMMAX_BOT_ENABLED` têm default off.

## Catálogo comercial aprovado

O catálogo comercial V1.0 foi aprovado pelo Proprietário do StreamMax em 17/11/2026 e seu documento canônico é `docs/01-product/CATALOGO-COMERCIAL.md`. `list-plans` marca cada adicional `executable:true` somente quando preço, moeda e segmento de `catalog.prices` tenant-scoped coincidem com a referência aprovada. Isso demonstra que `offer.quote` consegue cobrar os mesmos valores/quantidades, e a materialização pós-pagamento em `subscription_addons` preserva quantidade. Sem correspondência, `executable:false`. A API não calcula valores: `offer.quote`/`renewal.quote` consultam preços operacionais; preço ausente falha sem fallback.

O desconto antecipado foi aprovado pelo proprietário em 17/11/2026 e implementado na API: opção B, R$ 5,00 (500 centavos) fixos por pedido de renovação antecipada sobre plano + telas adicionais. `renewal.quote` usa adicionais ativos persistidos em `subscription.subscription_addons`, consulta preço ADDON vigente por periodicidade (`segment_key`) e calcula plano + Σ(preço da tela × quantidade) − desconto se elegível. Valores verificados: mensal + uma tela antecipado R$ 45 (4500 centavos); trimestral + duas telas R$ 190 (19000); semestral + uma tela R$ 245 (24500); anual + duas telas R$ 595 (59500); mensal + uma tela sem antecipação R$ 50 (5000). Só o backend decide elegibilidade via `decideRenewalQuote(...).early` (`renewal-policy.ts:72-90`), usando relógio do servidor e ciclo persistido sob transação/lock. Requer `early_allowed=true` na política `subscription.renewal` e mais de `window_days` (7 padrão) até o vencimento; dentro da janela (`early:false`) não há desconto, e `early_allowed=false` (padrão) não concede automaticamente. Nenhuma flag do cliente/bot comprova elegibilidade. Não se aplica a `NEW_SUBSCRIPTION`; replay reutiliza a ordem (`renewal_order_id`, `already:true`) sem acumular.

Implementação: `approved-catalog.ts` contém referência aprovada e helpers documentais, não preços executáveis; `renewal.commands.ts` e `renewal-store.ts` consultam preços operacionais tenant-scoped, persistem itens BASE_PLAN + ADDON e snapshots em `context_json`, inclusive `segmentKey`; desconto clampado ao gross. `materializeOrderSubscriptionAddons` materializa os adicionais do pedido liquidado; `reopenEntitlementsForRenewal` reabre também os entitlements `subscription_addon`, preservando quantidade. Quantidade PostgreSQL `numeric(12,3)` é normalizada para inteiro e fração rejeitada fail-closed. API, painel e bot consultam valores persistidos, sem recalcular. A gravação no catálogo operacional real, deploy e M5 continuam fora do escopo; esta aprovação não autoriza cobrança ou ativação.

## Autenticação e escopo

Credencial de serviço com escopo `bot.streammax.execute`; tenant é sempre derivado da credencial, nunca do corpo. Migration 070 append-only armazena SHA-256 de `pepper:token`; pepper separado, mínimo 32 caracteres e não pgsecret. `resolve_bot_credential`; `iptv_app` tem somente SELECT. Validade máxima 365 dias. Emissão por `scripts/emit-bot-credential.mjs`.

Guard: 404 rota ausente, 503 flag API desabilitada, 401 credencial inválida/ausente, 403 escopo não autorizado. Corpo strict; qualquer campo `tenant*` resulta em 400.

## Rotas implementadas

Todas as rotas são `POST`, protegidas por `BotServiceGuard`. Todos os corpos incluem `messageId`, `requestedAt`, `idempotencyKey`; os schemas são strict e rejeitam `tenantId`, `tenant_id` e `tenant`. As formas abaixo mostram os campos específicos e todos os campos de resposta:

| Rota | Request específico | Response |
|---|---|---|
| `/v1/bot/streammax/list-plans` | `{}` | `{plans:[{planId,name,amountMinor,currency,periodMonths}], addons:[{sellableId,segmentKey,periodMonths,amountMinor,currency,executable,source}], catalog:{version,approvedAt,source,operationalCatalogLoaded,message}}` |
| `/v1/bot/streammax/resolve-lead` | `{waId,name?}` | `{personId,leadId,isNew}` |
| `/v1/bot/streammax/reply` | `{conversationId,inboundText,waId?,name?}` | `{handled,sent:false,reason?}` ou `{handled:true,sent:false,text}` |
| `/v1/bot/streammax/quote` | `{personId,planId,addonQuantity?,periodicityMonths?}` | `{quoteId,amountMinor,currency,early:false}` |
| `/v1/bot/streammax/create-order` | `{personId,quoteId}` | `{orderId,chargeId,qrCode,effectUncertain,status}` |
| `/v1/bot/streammax/get-charge` | `{personId,orderId}` | `{personId,orderId,order:{orderId,status,netAmountMinor,currency},charge:{chargeId,status}|null,settled,pix:null}` |
| `/v1/bot/streammax/get-subscription` | `{personId}` | `{personId,subscriptionId,status,currentPeriodStart,currentPeriodEnd,projectedState:null}` ou `{personId,subscription:null}` |
| `/v1/bot/streammax/get-trial` | `{personId}` | `{personId,durationHours:6,usesPerUser:1,trials:[{id,trialKind,lifecycleStatus,technicalOutcome,requestedDurationMinutes,activatedAt,expiresAt}],eligibilityComputed,eligible:boolean|null,reason}` |
| `/v1/bot/streammax/open-ticket` | `{personId,kind:"TECHNICAL"|"BILLING"|"GENERAL",summary}` | `{ticketId,status,personId,kind}` |
| `/v1/bot/streammax/get-ticket` | `{personId,ticketId}` | `{personId,ticket:{id,status,priority,category,summary,personId,createdAt,resolvedAt,closedAt}}` |
| `/v1/bot/streammax/renewal-quote` | `{personId}` | `{personId,quoteId,orderId,status,amountMinor,currency,early,already}` |
| `/v1/bot/streammax/renew` | `{personId,quoteId}` | `{personId,orderId,subscriptionId,priorCycleId,cycleId,cycleNo,startsAt,endsAt,already}` |

`resolve-lead` resolve/reutiliza pessoa e lead dentro do tenant da credencial. `quote` chama `offer.quote`; `create-order` usa `order.submit`, provisionamento e `charge.create`. `renewal-quote` chama `renewal.quote`, podendo materializar ou reutilizar a ordem idempotentemente; portanto não é uma leitura pura. `renew` usa `quoteId` como orderId e chama `subscription.renew` somente após validar, dentro do tenant da credencial, titularidade por pessoa, `orderType=RENEWAL` e `status=SETTLED`; essas verificações ocorrem antes de qualquer efeito. Ambos os comandos estão explicitamente na allowlist do `botExecute`. O backend é a fonte do valor monetário e mantém snapshots, adicionais, desconto antecipado e replay `already:true`. `get-trial` é somente leitura: política e trial history são avaliados pelas funções puras existentes; falha de leitura/avaliação retorna `eligible:null` e motivo explícito. Apenas retrial técnico invalidado com outcome `FAILED` e política existente `retrial_mode=allow` permite elegibilidade novamente; `review` fica indeterminado (`null`) e `deny` nega. Nenhum evento, decisão ou review é gravado. `reply` nunca envia mensagem e inclui `sent:false`.

## Checklist de decisões

- [x] Service actor/credencial por tenant, escopo e validade: migration 070 e `resolve_bot_credential`.
- [x] Dono da resposta: StreamMax/WAHA; endpoint reply apenas compõe/devolve, nunca envia.
- [x] Hash e segregação de pepper: SHA-256 de `pepper:token`; pepper separado, mínimo 32 caracteres, não pgsecret.
- [x] Tenant confiável: derivado da credencial; campos tenant no request rejeitados (400).
- [x] Integração de tool/CLI na skill do OpenMausBot: realizada em homologação sintética no staging (CLI real → API → catálogo); produção exige autorização específica.

## Segurança e homologação

Três achados corrigidos: reutilização de pessoa, leitura via `withTenantTransaction` sem derrubar takeover, e bloqueio de fallback ao AgentPipeline com bot ligado. Revisão de segurança APPROVED; re-revisão APPROVED. E2E sintético usa gateway/adapters simulados, sem efeitos reais. Não é homologação de produção.

M4-B/S2 e S5 executados em staging sintético. Sem certificação de produção; M5 permanece pendente.
