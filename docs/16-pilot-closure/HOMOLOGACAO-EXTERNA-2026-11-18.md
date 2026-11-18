# Homologação externa — 18/11/2026 (#86, #89; #87 bloqueado; #88 intocada)

## #86 — Asaas Sandbox: HOMOLOGADO (webhook)

- Tenant: `e2e-tenant-20261115043757` (`01a1dd7f-b8b7-740c-8e49-bc23b9de48b1`), canal ASAAS ativo `asaas-e2e-20261115043757`.
- Conta de teste criada no tenant (`homologacao-e2e@streammax.test`, `tenant_owner`) apenas para autenticação no painel/hub; senha gerada localmente e descartada.
- Credencial Sandbox válida do `.env` local configurada via `POST /v1/integrations/asaas/configure` (`expectedVersion` 1 → versão 2), validada por `/test` → `CONNECTED_READ_ONLY`.
- Webhook provisionado via `POST /v1/integrations/asaas/webhook`: URL `https://staging-api.synkroo.com.br/v1/webhooks/asaas/asaas-e2e-20261115043757`, `providerWebhookId` `2057f79e-2efc-4b63-9604-7a9e3491ffc5`, `hasAuthToken=true`, status `ACTIVE`. Token rotacionado e gravado no cofre; valor nunca exibido.
- Esclarecimento de origem: `evt-sandbox-homolog-001` foi INJETADO DIRETAMENTE no endpoint do webhook com token do cofre; NÃO foi emitido pelo Asaas Sandbox. A configuração do webhook foi confirmada por leitura na API do Asaas Sandbox: id `2057f79e-2efc-4b63-9604-7a9e3491ffc5`, `enabled=true`, URL de staging correta, eventos `PAYMENT_REFUNDED`/`PAYMENT_OVERDUE`/`PAYMENT_RECEIVED`, `apiVersion=3`. Hash do token do cofre confere com `webhook_secret_hash` do canal (verificado em processo, sem exibir valores).
- Evento sintético `PAYMENT_RECEIVED` id `evt-sandbox-homolog-001`, payment `pay_0_ng7ycyivp5ovmk`, value 10.00 BRL: primeira entrega 202 `{"accepted":true,"deduped":false}`; replay idêntico 202 `{"accepted":true,"deduped":true}`.
- Persistência: exatamente 1 linha em `platform.inbox_messages` (`asaas:evt-sandbox-homolog-001`, estado `PROCESSED`); 4 charges `PAID` (inalteradas), 0 exceções em `billing.exceptions`. Sem cobrança real ou produção.
- Limite da evidência: ingress autenticado, deduplicação e ausência de duplicação financeira comprovadas; isso NÃO equivale à jornada financeira completa homologada no Asaas.
- Nota: o token do bot (`asaas-webhook.service`) e o segredo do `.env` (`synkroo-iptv`) **não** correspondiam ao canal e2e; por isso foi necessária a rotação autorizada.

## #89 — Painel: E2E AUTENTICADO (parcial, suficiente para evidência)

- Login real no Control Center de staging com a conta de teste, tenant e2e selecionado.
- Pedidos: 4 pedidos `SETTLED` (R$10/10/10/30) no painel; API `/v1/orders` devolve os mesmos 4 (`SETTLED`, valores 1000/1000/1000/3000 minor).
- Cobrança: "4 de 4 registros", todas `PAID` R$10/10/10/30 - coerente com banco e API. Assinaturas no painel mostram 3 de 3 registros; o banco tem 3 assinaturas `ACTIVE`.
- Integrações: Asaas `CONNECTED_READ_ONLY`, ambiente `SANDBOX`, última verificação 18/11/2026 04:56; WhatsApp `NOT_CONFIGURED` na plataforma (WAHA opera via bot); CINEVISION `TESTING`/`CHALLENGE_DETECTED` (não tocado).
- Token inválido no webhook retorna 401 `UNAUTHORIZED` (tratamento de erro verificado sem mutação). CI do commit `d4bafb9` verde: build (6m7s), `security-scans`, `outbox-050-role-guards` e `adversarial`.
- Permanecem pendentes erro/retry, disable/re-enable e isolamento A/B completos, por exigirem configuração descartável ou autorização específica. Status: PARCIAL COM EVIDÊNCIA; manter issue aberta.

## #87 - WAHA: BLOCKED_TEST_CHANNEL

- Sessão WAHA `ted` `WORKING`; ponte wa-bridge-atendente ativa.
- O número autorizado `556195613225` está em conversa de suporte real e ativa (mensagens “Ok”, “Wi-Fi” e respostas sobre TV/Samsung nos logs da ponte).
- A mensagem sintética não aparece nos eventos do WAHA nem nos logs da ponte (0 ocorrências); portanto foi descartada e não representa risco de entrega posterior. Nenhum novo envio foi feito.
- A sessão `ted` atende conversas reais e não deve ser reutilizada. Necessário número/sessão exclusivos autorizados pelo proprietário.

## #88 - CINEVISION
- Não autorizada nesta rodada; nenhuma ação executada. Estado inalterado (`TESTING`/`CHALLENGE_DETECTED` no painel).

## Rodada final — origem pelo provedor e WAHA (18/11/2026)

### #86 — evento originado pelo Asaas Sandbox (complemento)
- Webhook do Sandbox atualizado via API para incluir PAYMENT_CONFIRMED (além de RECEIVED/OVERDUE/REFUNDED); o normalizador do StreamMax aceita PAYMENT_CONFIRMED como evento pago.
- Cliente sintético `cus_000010025221` e cobrança em cartão de teste aprovado (4444...) criados no Sandbox — sem dinheiro real.
- O Asaas Sandbox emitiu `PAYMENT_CONFIRMED` `evt_15e444ff9b9ab9ec29294aa1abe68025&25429909` (payment `pay_0_h02bkq6bpavaww`, R$10,00): ingress autenticado, 202, 1 linha no inbox PROCESSED.
- Como o payment é externo ao StreamMax, o sistema registrou corretamente 1 exceção `UNKNOWN_CHARGE` (OPEN, reason "no domain mutation") e NÃO alterou nenhuma charge/pedido/ledger. Nenhuma duplicação financeira; total de charges permaneceu 4.
- Conclusão #86: ingresses injetado e originado pelo provedor comprovados, autenticação e idempotência verificadas. Limite: a exceção UNKNOWN_CHARGE é o comportamento correto para pagamento sem contraparte local; não houve liquidação financeira de ponta a ponta no StreamMax (isso exigiria pedido/charge casados com o pagamento Sandbox).

### #87 — homologação com sessão autorizada (complemento)
- Proprietário autorizou reutilizar a sessão `ted` e o número 556195613225.
- Mensagem sintética enviada via WAHA `sendText` para o chat LID `125842558599202@lid` foi entregue (fromMe=true, ack=3). A ponte ignora mensagens fromMe, portanto não houve laço/dupla resposta.
- No inbound real seguinte da mesma sessão, a ponte registrou exatamente 1 job queued e 1 envio=201 (job 21), sem duplicação.
- Conclusão #87: recebimento, processamento e resposta única comprovados na sessão autorizada; nenhuma mensagem adicional a terceiros.

### #88 — continua intocada.

### #89 — inalterada nesta rodada (parcial com evidência).
