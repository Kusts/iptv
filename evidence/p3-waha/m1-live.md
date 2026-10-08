# M1-live WAHA — evidência parcial (2026-10-08, sessão `ted`, VPS Contabo)

> Sem segredos neste arquivo (URLs + nomes + status apenas). Raw secrets
> viveram só em `%TEMP%` e foram destruídos; backup do webhook restaurado.

## Provado ao vivo

- Sessão `ted` (engine NOWEB) `WORKING` via `GET /api/sessions`.
- Restart via `POST /api/sessions/ted/restart` → `WORKING` em <10s (2×).
- Outbound: `POST /api/sendText` 201 para o contato de teste (2 envios);
  segundo envio entregue no telefone (confirmado pelo operador) com `ack=1`
  no chat correto (JID canônico de 12 dígitos — nono dígito: `5561995613225`
  não é o JID; o correto é `556195613225`).
- Webhook da sessão reapontado para
  `https://iptv.synkroo.com.br/v1/webhooks/waha/synkroo-iptv` (header
  `x-waha-secret`, canal `communication.tenant_channels` com hash, ACTIVE)
  e **restaurado** ao original (`local-api…/waha/pilot`) após os testes;
  canal de teste marcado `DISABLED` (sem delete, por auditoria).

## Bloqueado por infra (fora do nosso código)

- Inbound não observável: sessão em tempestade `conflict/replaced`
  (~10/min) — outro cliente derruba a conexão continuamente. Sidecar pausado
  durante a janela NÃO removeu o conflito (portanto não é o competidor);
  sidecar religado e ambiente devolvido como encontrado.
- Respostas do operador (`Teste=piloto-ok`, `Teste-piloto-ok-2`, `Funcionou`)
  chegaram na sessão mas eventos se perderam na instabilidade; zero linhas
  `waha` no inbox do piloto (correto: nada a processar sem entrega).
- Próximo: identificar o competidor (Aparelhos conectados no WhatsApp —
  sessão duplicada/antiga) e repetir o inbound; ou sessão dedicada de teste.

## Itens M1 ao vivo: status

- session/restart/outbound: PASS (live). inbound/webhook/dedupe/LID/multi/
  isolamento/reconnect/restriction: PASS em código (P3C), live BLOCKED pelo
  conflito acima. media/audio: N-A (não implementado). fallback: documentado.

## Reteste pós-conflito (2026-10-08, Contabo)

- Causa do loop: duas instâncias WAHA com a mesma sessão (`ted`) — Hostinger
  (removida pelo operador) + Contabo; sidecar inocentado por teste A/B.
- Re-apontamento refeito no Contabo (PUT 200) + canal re-ativado.
- Inbound `TESTE-4` (`Teste-4`, LID `125842558599202@lid` → `556195613225`,
  pushName do operador): recebido + `PROCESSED`; sem identidade vinculada →
  `UNMATCHED_INBOUND` OPEN (fail-closed correto, sem conversa fabricada).
- Dedupe ao vivo: replay byte-idêntico → `202 {accepted:true, deduped:true}`,
  contagens intactas (1 inbox, 0 pagamentos extras, mesmas 2 exceções).
- Nota operacional: Cloudflare 1010 bloqueia clientes HTTP sem User-Agent
  (ex.: `python-urllib` puro) — webhooks reais (WAHA) e `curl` passam;
  usar UA de navegador nos probes.
- Webhook **restaurado** ao original (`local-api…`, verificado via GET) e
  canal de teste `DISABLED`; segredos temporários destruídos.
- M1-live: session/restart/outbound/inbound/auth/dedupe/LID/triage PASS ao
  vivo. Restam em código: multi-sessão (1 sessão), reconnect profundo,
  restriction/timelock (nunca provocar), fallback manual (M2), media/audio.
