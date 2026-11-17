# Contrato JSON do bot StreamMax

- Data: 17/11/2026
- Natureza: contrato S2 implementado para consumo futuro do OpenMausBot.
- Homologação **SINTÉTICA, não produção**; este documento não autoriza produção.
- `STREAMMAX_BOT_API_ENABLED` e `STREAMMAX_BOT_ENABLED` têm default off.

## Catálogo comercial aprovado

O catálogo comercial V1.0 foi aprovado pelo Proprietário do StreamMax em 17/11/2026 e seu documento canônico é `docs/01-product/CATALOGO-COMERCIAL.md`. Os valores executáveis vêm de `catalog.prices`; o bot nunca inventa nem infere preços. Addons podem ter preço segmentado por periodicidade via `segmentKey`/`segment_key` (por exemplo, o addon `additional-connection`). `segmentKey` em um item `PLAN` é inválido (`validation_failed`). A API/bot ainda não expõe addons; `list-plans` lista planos.

O desconto antecipado foi aprovado pelo proprietário em 17/11/2026 e implementado na API: opção B, R$ 5,00 (500 centavos) fixos por pedido de renovação antecipada sobre plano + telas adicionais. `renewal.quote` usa adicionais ativos persistidos em `subscription.subscription_addons`, consulta preço ADDON vigente por periodicidade (`segment_key`) e calcula plano + Σ(preço da tela × quantidade) − desconto se elegível. Valores verificados: mensal + uma tela antecipado R$ 45 (4500 centavos); trimestral + duas telas R$ 190 (19000); semestral + uma tela R$ 245 (24500); anual + duas telas R$ 595 (59500); mensal + uma tela sem antecipação R$ 50 (5000). Só o backend decide elegibilidade via `decideRenewalQuote(...).early` (`renewal-policy.ts:72-90`), usando relógio do servidor e ciclo persistido sob transação/lock. Requer `early_allowed=true` na política `subscription.renewal` e mais de `window_days` (7 padrão) até o vencimento; dentro da janela (`early:false`) não há desconto, e `early_allowed=false` (padrão) não concede automaticamente. Nenhuma flag do cliente/bot comprova elegibilidade. Não se aplica a `NEW_SUBSCRIPTION`; replay reutiliza a ordem (`renewal_order_id`, `already:true`) sem acumular.

Implementação: `approved-catalog.ts` (constante 500, `earlyRenewalDiscountMinor`, `applyEarlyRenewalDiscount`), `renewal.commands.ts` e `renewal-store.ts` (itens BASE_PLAN + ADDON e snapshots em `context_json`, inclusive `segmentKey`; desconto clampado ao gross). `materializeOrderSubscriptionAddons` materializa os adicionais do pedido liquidado; `reopenEntitlementsForRenewal` reabre também os entitlements `subscription_addon`, preservando quantidade. Quantidade PostgreSQL `numeric(12,3)` é normalizada para inteiro e fração rejeitada fail-closed. API, painel e bot devem consultar valores persistidos, sem recalcular. A exposição dos preços dos adicionais na API/bot permanece pendente funcional. A gravação no catálogo operacional real, deploy e M5 continuam fora do escopo; esta aprovação não autoriza cobrança ou ativação.

## Autenticação e escopo

Credencial de serviço com escopo `bot.streammax.execute`; tenant é sempre derivado da credencial, nunca do corpo. Migration 070 append-only armazena SHA-256 de `pepper:token`; pepper separado, mínimo 32 caracteres e não pgsecret. `resolve_bot_credential`; `iptv_app` tem somente SELECT. Validade máxima 365 dias. Emissão por `scripts/emit-bot-credential.mjs`.

Guard: 404 rota ausente, 503 flag API desabilitada, 401 credencial inválida/ausente, 403 escopo não autorizado. Corpo strict; qualquer campo `tenant*` resulta em 400.

## Rotas implementadas

Todas são `POST` e aceitam somente o corpo contratual estrito sem tenant:

- `/v1/bot/streammax/list-plans`
- `/v1/bot/streammax/resolve-lead`
- `/v1/bot/streammax/reply`

`resolve-lead` resolve/reutiliza pessoa e lead dentro do tenant da credencial. `list-plans` lista planos vendáveis. `reply` não envia mensagem: resposta inclui `sent:false`; com `STREAMMAX_BOT_ENABLED=true`, retorna `flag_off`, sem fallback ao AgentPipeline. Chaves idempotentes de lead usam `bot-api:lead:*`. As demais regras de idempotência seguem os handlers.

## Checklist de decisões

- [x] Service actor/credencial por tenant, escopo e validade: migration 070 e `resolve_bot_credential`.
- [x] Dono da resposta: StreamMax/WAHA; endpoint reply apenas compõe/devolve, nunca envia.
- [x] Hash e segregação de pepper: SHA-256 de `pepper:token`; pepper separado, mínimo 32 caracteres, não pgsecret.
- [x] Tenant confiável: derivado da credencial; campos tenant no request rejeitados (400).
- [ ] Integração de tool/CLI na skill do OpenMausBot: PENDENTE; S5 não executado e exige autorização para staging.

## Segurança e homologação

Três achados corrigidos: reutilização de pessoa, leitura via `withTenantTransaction` sem derrubar takeover, e bloqueio de fallback ao AgentPipeline com bot ligado. Revisão de segurança APPROVED; re-revisão APPROVED. E2E sintético usa gateway/adapters simulados, sem efeitos reais. Não é homologação de produção.

M4-B/S2 concluído. S5 pendente; M5 BLOCKED.
