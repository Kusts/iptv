# Homologação externa — 18/11/2026 (#86, #89; #87 bloqueado; #88 intocada)

## #86 — Asaas Sandbox: HOMOLOGADO (webhook)

- Tenant: `e2e-tenant-20261115043757` (`01a1dd7f-b8b7-740c-8e49-bc23b9de48b1`), canal ASAAS ativo `asaas-e2e-20261115043757`.
- Conta de teste criada no tenant (`homologacao-e2e@streammax.test`, `tenant_owner`) apenas para autenticação no painel/hub; senha gerada localmente e descartada.
- Credencial Sandbox válida do `.env` local configurada via `POST /v1/integrations/asaas/configure` (`expectedVersion` 1 → versão 2), validada por `/test` → `CONNECTED_READ_ONLY`.
- Webhook provisionado via `POST /v1/integrations/asaas/webhook`: URL `https://staging-api.synkroo.com.br/v1/webhooks/asaas/asaas-e2e-20261115043757`, `providerWebhookId` `2057f79e-2efc-4b63-9604-7a9e3491ffc5`, `hasAuthToken=true`, status `ACTIVE`. Token rotacionado e gravado no cofre; valor nunca exibido.
- Evento `PAYMENT_RECEIVED` id `evt-sandbox-homolog-001`, payment `pay_0_ng7ycyivp5ovmk`, value 10.00 BRL: primeira entrega 202 `{"accepted":true,"deduped":false}`; replay idêntico 202 `{"accepted":true,"deduped":true}`.
- Persistência: exatamente 1 linha em `platform.inbox_messages` (`asaas:evt-sandbox-homolog-001`, estado `PROCESSED`); 4 charges `PAID` (inalteradas), 0 exceções em `billing.exceptions`. Sem cobrança real ou produção.
- Nota: o token do bot (`asaas-webhook.service`) e o segredo do `.env` (`synkroo-iptv`) **não** correspondiam ao canal e2e; por isso foi necessária a rotação autorizada.

## #89 — Painel: E2E AUTENTICADO (parcial, suficiente para evidência)

- Login real no Control Center de staging com a conta de teste, tenant e2e selecionado.
- Pedidos: 4 pedidos `SETTLED` (R$10/10/10/30) no painel; API `/v1/orders` devolve os mesmos 4 (`SETTLED`, valores 1000/1000/1000/3000 minor).
- Cobrança: “4 de 4 registros”, todas `PAID` R$10/10/10/30 — coerente com banco e API.
- Integrações: Asaas `CONNECTED_READ_ONLY`, ambiente `SANDBOX`, última verificação 18/11/2026 04:56; WhatsApp `NOT_CONFIGURED` na plataforma (WAHA opera via bot); CINEVISION `TESTING`/`CHALLENGE_DETECTED` (não tocado).
- Limitação: não foi executada a jornada completa com erro/retry, segredo inválido, disable/re-enable e isolamento A/B; manter issue aberta com a evidência parcial.

## #87 — WAHA: BLOQUEADO (número não é seguro para teste)

- Sessão WAHA `ted` `WORKING`; ponte wa-bridge-atendente ativa.
- O número autorizado `556195613225` está em conversa de suporte real e ativa (mensagens “Ok”, “Wi-Fi” e respostas sobre TV/Samsung nos logs da ponte).
- A mensagem sintética enviada via WAHA ficou `PENDING` e **não** foi entregue/processada pela ponte; nenhuma mensagem externa adicional foi enviada.
- Não prosseguir sem número/sessão isolada de teste; não há evidência de duplicação causada por nossa ação, mas também não há homologação.

## #88 — CINEVISION

- Não autorizada nesta rodada; nenhuma ação executada. Estado inalterado (`TESTING`/`CHALLENGE_DETECTED` no painel).
