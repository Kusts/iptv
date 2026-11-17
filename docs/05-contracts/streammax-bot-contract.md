# Contrato JSON do bot StreamMax

- Data: 17/11/2026
- Natureza: contrato S2 implementado para consumo futuro do OpenMausBot.
- Homologação **SINTÉTICA, não produção**; este documento não autoriza produção.
- `STREAMMAX_BOT_API_ENABLED` e `STREAMMAX_BOT_ENABLED` têm default off.

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
