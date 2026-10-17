# M1 pontual + leitura M2 — 2026-10-13 (BACKEND-WAHA-M1LIVE-20261013)

> Sem segredos, sem PII completa, sem bodies neste arquivo.
> Segredos (`WAHA_*`) viveram só em processo/`%TEMP%` e foram destruídos.
> Destinatário mascarado como `55***25`. Nenhum código alterado, nenhum `.env` tocado.

## Pré-voo (leitura, sem provocar 429) — 2026-10-13

- `WAHA_BASE_URL`: SET / `WAHA_API_KEY`: SET / `WAHA_SESSION`: SET (só presença + tamanho, sem valores).
- `GET /api/sessions/ted` → HTTP 200: `status=WORKING`, `engine=NOWEB`,
  `cappingStatus=null`, `reachoutTimelock=null`, quotas `null`.
- `GET /api/sessions` → HTTP 200: 1 sessão (`ted=WORKING`). Nenhum competidor
  visível no endpoint configurado (sem tempestade `conflict/replaced` observável
  nesta leitura).
- Webhook da sessão (só host + path mascarado): 1 webhook →
  `local-api.synkroo.com.br/v1/webhooks/waha/pilot`, `events=["message"]`.
  É o original restaurado (cf. `m1-live.md`) — **nada a restaurar nesta run**.
- M2 (leitura): sem restrição ativa; provocar 429 segue proibido. Estado
  consistente com `m2-drill.md` (saudável, drill humano pendente).

## M1 pontual — BLOCKED (não executado, sem promoção)

- Motivo: (a) número completo do destinatário opt-in (`55***25`) não chegou a
  este executor por canal seguro nesta run — só o prefixo/máscara da delegação;
  (b) janela com webhook público observável inativa (aponta ao original
  `local-api…/pilot`); re-apontar + reativar canal de teste é mutação
  operador-gated fora deste escopo sem confirmação viva do operador;
  (c) confirmação de entrega/ack no aparelho + inbound de retorno exigem o
  operador ao telefone.
- Nada foi enviado: zero `POST /api/sendText`, zero inbound, zero replay.
  Nenhum item M1 muda de status por esta run.

## Procedimento do drill manual (para o operador, quando autorizar a janela)

1. Operador derruba duplicadas da sessão `ted` (outras instâncias WAHA) e
   confirma `GET /api/sessions` com 1 sessão `WORKING`.
2. Operador reaponta o webhook da sessão para o endpoint público observável e
   reativa o canal de teste (`ACTIVE`); anota o alvo prévio
   (`local-api…/waha/pilot`) como ponto de restore.
3. Executor: 1× `POST /api/sendText` texto `P3C-probe <ISO-ts>` ao opt-in
   `55***25` (número completo só em processo); registra HTTP status + provider
   id (sem body/PII). Operador confirma entrega/ack no aparelho + readback.
4. Operador envia 1× inbound de retorno; executor confirma `PROCESSED`;
   replay byte-idêntico deve retornar `deduped:true` com contagens intactas.
5. M2: ler `cappingStatus`/`reachoutTimelock` (NÃO provocar 429). Drill manual:
   operador envia pelo número piloto e registra `support.ticket`.
6. Cleanup: webhook de volta ao original, canal de teste `DISABLED` (sem
   delete), segredos temporários destruídos. `WAHA_*` nunca em repo/log.

## Status honesto

- M1-live: sem mudança — `session/restart/outbound/inbound/auth/dedupe/LID/triage`
  seguem no estado de `m1-live.md` + `m1-send-20261012.md`; esta run adiciona
  apenas a leitura de estado 2026-10-13 acima.
- M2: leitura saudável + procedimento; drill humano segue com o operador.
