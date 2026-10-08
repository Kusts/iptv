# M2 — fallback manual + capping (evidência + procedimento, 2026-10-08)

> Drill real é ato do operador. Este arquivo registra estado lido + procedimento.

## Estado lido (sessão `ted`, Contabo, ao vivo)

- `status=WORKING`, `cappingStatus=NONE`, quotas ilimitadas (`-1`),
  `reachoutTimelock=null`. Nada a observar: sem restrição ativa e
  **provocar restrição é proibido** (SPEC: timelock/cap nunca como evasão,
  nunca provocar).

## Procedimento de fallback manual (quando automação degradar)

1. Sintoma: `/v1/health` ok mas mensagens não saem/chegam; `cappingStatus`
   diferente de `NONE`, `reachoutTimelock` setado, ou sessão fora de `WORKING`.
2. Diagnóstico (só leitura): `GET /api/sessions/ted` (status/capping),
   logs `docker logs waha`, `drain-state` do outbox/inbox.
3. Degradação: pausar `POST /v1/agent/copilot/execute` e fluxos automáticos
   de outbound (comando do operador); filas `QUEUED/PAUSED` sem retry
   automático (código já faz isso — F05).
4. Manual: operador envia pelo WhatsApp do número piloto; registra
   `support.ticket` com outcome; nenhuma ação automática retoma sozinha.
5. Retomada: só com sessão `WORKING` + capping `NONE` + decisão explícita;
   re-habilitar fluxos um a um, observar `outbox_lease_recovery_idx`/backlog.

## M2 status

Procedimento registrado e estado saudável lido ao vivo. Drill executado por
humano fica para a janela do piloto (ato do operador, fora do código).
