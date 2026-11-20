# STREAMMAX-BOTS-OPERATIONAL-V2 — status (20/11/2026)

Missão: refinar a equipe de bots (OpenMausBot) e integrá-la ao StreamMax, com o Operador Android como executor visual das operações CINEVISION. Execução híbrida (Claude coordena, Orca supervisiona, OpenCode executa). Esta página registra o que está **comprovado** e o que **continua pendente**; não substitui o baseline nem fecha a issue #88.

## Entregas (branches locais, sem push, sem deploy)

| Marco | Repo / branch | Commit | Evidência |
|---|---|---|---|
| R1 — Operador Android só por MCP direto | OpenMausBot `feat/bots-operational-v2-r1` | `09db7a0` | skill `android-pilot-guardrails` removida; grep de CLI antiga vazio; `node --test` 6/6 |
| R2 — Gestor CINEVISION → Operador Android (`coordinate_bots`) + contrato de resultado | idem | `4868da0` | `node --test` 7/7; contrato definido uma vez na skill do Operador |
| R4 — refinamento da equipe IPTV + CLI `get-fulfillment` | idem | `c581098` | `node --test` 19/19 |
| R3 — auditoria da API e idempotência | iptv `feat/bots-operational-v2-r3` | `6e4470e` | `STREAMMAX-BOTS-API-AUDIT-2026-11-20.md`; `subscription-fulfillment.integration` 9/9 em PostgreSQL isolado |
| R3 — rota somente leitura `POST /v1/bot/streammax/get-fulfillment` | idem | `f59fd95` | 26/26 testes, lint, typecheck e 3 gates Python verdes |

## Decisões

1. **Nenhum bot escreve em PostgreSQL nem termina operações de provider.** O backend continua a fonte de verdade; assinatura só vira `ACTIVE` por `provider.resolve_operation`/`reconcile` com entrega vinculada ao pedido (já coberto por teste).
2. **O readback do Android não ativa assinatura.** O bot entrega o resultado estruturado (`operation_id`, `subscription_id`, `tipo_operacao`, `estado`, `referencia_externa`, `resultado_observado`, `readback_confirmado`) ao operador autorizado, que resolve pela API humana. Aceitar prova enviada pelo bot seria ampliação de autoridade com risco de prova falsificada e exige decisão de segurança (ver pendências).
3. Ampliação mínima da API: apenas leitura (`get-fulfillment`), sem permissão nova no ator sintético.
4. Disputa pelo aparelho: o lock do `remote-android` é só reserva de porta TCP local; a regra mínima (uma tarefa por vez, reportar ocupado e parar) está na SOUL do Operador. Sem serviço novo.
5. Credenciais CINEVISION: viável evitar a senha no contexto do modelo (sessão existente ou preenchimento protegido por ferramenta MCP); não implementado — pendente de decisão.

## Pendências reais (não comprovadas)

- Aplicar R1/R2/R4 na VPS via `openmausbot team apply` (`--dry-run` antes) e deploy da rota `get-fulfillment`: **não executado**, exige autorização de produção/staging. A CLI `openmausbot` não existe localmente.
- R5: jornadas com os bots reais (planos, venda, pagamento, ativação, trial, renovação, suporte, falha) **não executadas**; só a camada de API foi provada por teste sintético. Sequência autorizada: (1) jornada sintética com fornecedor simulado; (2) teste grátis CINEVISION pelo Operador Android com parâmetros e readback autorizados; (3) ativação real vinculada a um pedido legítimo.
- Decidir o modelo de autoridade do readback antes de qualquer escrita de bot em operações de provider.
- Prova de delegação funcional Gestor → Operador Android no runtime (a mudança é de instruções e testes de configuração).
- Regressões #86, #87 e #89: nenhuma alteração tocou seus fluxos; revalidação no runtime pendente.
- **Issue #88 permanece aberta**: só fecha com entrega comprovada e vinculada a uma assinatura legítima.
