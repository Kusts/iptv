# P3C-WAHA — Certificação sessão/instância (SEM mensagens reais)

- TASK_ID: P3C-WAHA
- Data (UTC): 2026-10-08
- Endpoint de teste/local afirmado: **NENHUM endpoint WAHA configurado neste processo** —
  `WAHA_BASE_URL: ABSENT`, `WAHA_API_KEY: ABSENT`, `WAHA_SESSION: ABSENT`,
  `WAHA_WEBHOOK_SECRET: ABSENT` (leitura in-processo, somente presença; nenhum segredo existe para imprimir).
  Gateway ativo resolvido in-processo: `echo` (`LocalEchoGateway`, default env-gated).
- Regra aplicada: **zero chamadas a qualquer WAHA** (não há para onde chamar);
  nenhum outbound/inbound real, nenhum grupo, nada que um humano receba.
  Itens que exigem sessão live ou destinatário real → `BLOCKED` / `GATE-OPERADOR (M1/M2)`.

## Vereditos por item da matriz C3

| # | Item | Veredito | Evidência (resumida, sem segredos) |
|---|------|----------|-------------------------------------|
| 1 | session | PASS (código) / BLOCKED (live) | `waha-sessions.ts`: `expectedSessionFor`/`bindSession`/`validateSessionForTenant`; teste F06 "resolves the default session and validates explicit bindings" verde. Status live da sessão (`GET /api/sessions`, QR) BLOCKED — sem endpoint configurado. |
| 2 | restart | PASS (código) / BLOCKED (live) | `noteSessionRestart`: match OK, mismatch recusado; teste F06 "keeps routing correct across a session restart" verde (send pós-restart usa sessão vinculada). Persistência de restart contra WAHA real BLOCKED. |
| 3 | outbound (texto) | PASS (código/sintético) / GATE-OPERADOR M1 (real) | `WahaGatewayAdapter.sendText`: sessão esperada ou `SESSION_MISMATCH` sem tocar rede; 429→`CAPPED`, não-2xx→`FAILED`, abort→`GatewayUnknownError`; testes com stub HTTP local 127.0.0.1 verdes (429→CAPPED; mismatch hits=1). Envio a destinatário real NÃO executado — M1. |
| 4 | inbound (texto) | PASS (código/sintético) / BLOCKED (live) | `normalizeWahaPayload` + fixtures (`waha-message`, `-flat`, `-from-me`, `-ack`, `-unknown-event`); `message.ingest` com identity/thread matching e fila `UNMATCHED_INBOUND` (`GET /v1/communications/exceptions` + resolve map/discard); integração webhook 202→message→dedupe registrada no CHANGELOG (Wave 2). Inbound live BLOCKED. |
| 5 | media | N-A (sandbox) | Adapter só implementa `sendText` (`POST /api/sendText`); normalizador extrai `body/text/caption` com fallback texto. Sem path de mídia implementado — nada a certificar, não é falha live. Certificação de mídia exige M1 + implementação. |
| 6 | audio | N-A (sandbox) | Idem item 5 — sem path de áudio implementado. |
| 7 | webhook (auth + ack) | PASS (código/sintético) | `WahaWebhookController.receive`: tenant via `communication.tenant_channels` (nunca payload); secret timing-safe; 404 tenant desconhecido / 401 / 503 `not_configured`; 202 fast ack; `?defer=1` + `drainPending`. Caminhos 401/404 cobertos por testes de integração (CHANGELOG Wave 2). Webhook sintético contra API local NÃO postado nesta run (sem banco descartável verificado) — evidência é código + suíte existente. |
| 8 | dedupe | PASS (código/sintético) | Inbox insert-once por (tenant, `waha`, external id); duplicada → `{accepted:true, deduped:true}`; protocolo de claim (`inbox_claim_by_id`) impede duplo processamento inline×scheduler. Unit (`acceptRaw`+`processRow`) + integração (entrega duplicada sintética) verdes por registro Wave 2. |
| 9 | LID/identidade | PASS com limitação (código) | `normalizeSender`: strip `@c.us`/`@s.whatsapp.net`, dígitos mantidos; ingest casa variantes `[raw, normalized]`; `fromMe` e `message.ack` acked sem mutação. **Limitação**: sem campo LID distinto — resolução LID→PN do WAHA não modelada separadamente. |
| 10 | multi-sessão | PASS (código, só leitura conceitual) | Bindings por tenant; send cross-session recusado sem rede (hits=1); inbound de sessão estrangeira em quarentena (exception, sem `messageId`/`conversationId`). Nenhuma segunda sessão live tocada. |
| 11 | isolamento | PASS (código) | `acceptAtomic` (`communication.accept_waha_delivery`): lock `FOR UPDATE`, revalida ACTIVE + tenant esperado, recusa DISABLE/re-point mid-flight com zero linhas; `SESSION_MISMATCH` no adapter; RLS via `resolve_tenant_channel` (definer). Sem cross-tenant observado em testes. |
| 12 | reconnect | BLOCKED | Exige sessão WAHA live (status/reconnect/QR). Mapeamento `riskForSessionStatus` (WORKING/CONNECTED→HEALTHY, FAILED/STOPPED→DEGRADED) coberto por teste unitário como evidência de código apenas. |
| 13 | restriction/timelock | PASS (código, leitura de estado) / BLOCKED (live) | 429→CAPPED; `TIMELOCKED`→CAPPED; nova prospecção adiada sob CAPPED, conversas existentes continuam enviando, inbound preservado; recusa CAPPED registrada 1× sem retry (`calls=1`); status webhook aplica risco sem mutação de domínio. Comportamento live sob restrição real BLOCKED. |
| 14 | fallback manual | PASS (documentado, não executado) | Runbook `whatsapp-down.md`: marcar degradado, parar reenvios, canal alternativo/atendimento manual; `UNKNOWN_EFFECT`→delivery `QUEUED` + `PAUSED`/`RECONCILE_REQUIRED` sem retry cego. Execução do drill contra destinatário real NÃO realizada — M2. |

## Comandos + resultados (sanitizados)

1. `node -e <presence-check WAHA_*>` → `WAHA_BASE_URL: ABSENT`, `WAHA_API_KEY: ABSENT`,
   `WAHA_SESSION: ABSENT`, `WAHA_WEBHOOK_SECRET: ABSENT` (só presença; sem valores).
2. `pnpm --filter @iptv/api exec vitest run test/waha-f05-f06.unit.test.ts test/crm-comms.unit.test.ts`
   → **2 arquivos, 37 testes, todos PASS** (12 F05/F06 + 25 crm-comms; stubs HTTP só em 127.0.0.1; sem provider real).
3. `pnpm --filter @iptv/api exec tsx -e gatewayFromEnv({})` → `gateway name=echo`
   (default env-gated confirmado in-processo; WAHA só com `WAHA_BASE_URL`+`WAHA_API_KEY` setados).

## Referências de contrato (leitura, sem alteração)

- `apps/api/src/communications/messaging-gateway.ts` (env-gate + `WahaGatewayAdapter` + `LocalEchoGateway`)
- `apps/api/src/communications/waha-sessions.ts`, `waha-risk-state.ts`, `waha-normalizer.ts`
- `apps/api/src/communications/waha-webhook.{controller,service}.ts`
- `docs/15-implementation-baseline/10-integrations-certification.md` (WAHA/GOWS MVP gate)
- `docs/10-operations/runbooks/whatsapp-down.md` (fallback), `docs/10-operations/integrations-capability-status.md` (status IMPLEMENTED, live pendente)
- `docs/06-decisions/ADR-0018-whatsapp-waha-first-spike.md`

## BLOCKERS — pedidos explícitos ao operador (M1/M2)

- **M1 (milestone live — sessão/outbound/inbound/media/reconnect):** pede-se ao operador
  autorizar explicitamente: (a) endpoint WAHA sandbox/teste designado (URL + sessão de teste,
  conta NÃO produtiva); (b) destinatário de teste com opt-in documentado (número de teste,
  sem grupos); (c) janela para executar: status da sessão, QR se aplicável, restart/reconnect,
  1× outbound texto sintético (`P3C-WAHA probe <timestamp>`, sem conteúdo sensível),
  1× inbound de retorno, webhook de dedupe duplicado, e — se implementado até lá — 1× mídia/áudio.
  Sem M1, os itens 1–4/12 (live) e 5–6 permanecem BLOCKED/N-A e nada é promovido.
- **M2 (restriction/fallback drill):** pede-se autorizar explicitamente a observação de
  timelock/capping contra a sessão sandbox (leitura de estado + 1× envio que receba 429,
  confirmando adiamento sem retry storm) e o drill de fallback manual documentado
  (contato manual ao destinatário de teste pelo operador humano, fora do código).
  Sem M2, o item 14 permanece documentação-não-executada e o item 13 (live) BLOCKED.

## Riscos

- Sem endpoint configurado, NENHUMA afirmação live é feita — todo PASS acima é
  código/sintético; promover capacidade com base neste relatório seria overstatement
  (cf. `integrations-capability-status.md`: só evidência do operador promove status).
- `normalizeSender` sem LID distinto: se o WAHA entregar identidades `@lid` sem número,
  o matching pode cair em `UNMATCHED_INBOUND` (fail-closed para a fila de exceções — seguro, mas ruidoso).
- Media/áudio não implementados: qualquer jornada que dependa deles falha fechada hoje.

## Recomendação

Manter WAHA como `IMPLEMENTED` (código) / `LIVE VALIDATION REQUIRED`; executar M1+M2
no sandbox designado antes de qualquer certificação; ao implementar mídia/áudio,
requerer recertificação do gate (engine/contrato novo). Nenhum commit/push realizado
nesta tarefa; único arquivo escrito: este relatório.
