# Homologação externa — 18/11/2026 (#86, #87, #89; #88 intocada)

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

## #87 - WAHA: HOMOLOGADO NO CANAL DE TESTE

- Sessão WAHA `ted` `WORKING`; ponte wa-bridge-atendente ativa.
- A sessão WAHA `ted` e o número `556195613225` são um canal de teste do próprio IPTV, com o bot Atendimento ativo; não há cliente real nessa conversa.`r`n


## #88 - CINEVISION
- Não autorizada nesta rodada; nenhuma ação executada. Estado inalterado (`TESTING`/`CHALLENGE_DETECTED` no painel).

## Rodada final — origem pelo provedor e WAHA (18/11/2026)

### #86 — jornada financeira completa (18/11/2026)
- Descoberta: a API do Asaas Sandbox oferece o endpoint oficial `POST /v3/sandbox/payment/{id}/confirm` (somente Sandbox, sem dinheiro real), documentado em [Confirmar pagamento](https://docs.asaas.com/reference/confirmar-pagamento). Isso eliminou a dependência do dashboard.
- Jornada executada pela API autenticada do StreamMax no tenant e2e, usando a conta de teste `homologacao-e2e@streammax.test`:
  1. Pessoa sintética criada (`01a1ee4d-333d-7049-af21-4cd34a9f031b`).
  2. Plano "E2E Mensal" (`c75c79ec-...`) e quote DRAFT no valor de 3000 minor.
  3. Pedido `01a1ee4d-3643-729a-991f-e451d04cea77` submetido e transicionado para AWAITING_PAYMENT.
  4. Cliente Asaas provisionado (`cus_000010025702`).
  5. Cobrança local `01a1ee4d-3d5e-71a2-b610-3bd1da1e6ef5` criada por PIX, com `providerChargeId` `pay_0_9z4uwwwfbqwj1h`, sem efeito incerto.
  6. `POST /v3/sandbox/payment/pay_0_9z4uwwwfbqwj1h/confirm` confirmou no Asaas o pagamento RECEIVED no valor de R$ 30,00.
- O próprio Asaas emitiu `PAYMENT_RECEIVED` (`evt_d26e303b238e509335ac9ba210e51b0f&25433203`); o ingress autenticado foi processado (`inbox PROCESSED`). O pedido ficou **SETTLED** (`settled_amount_minor=3000`), a cobrança **PAID** e o pagamento local `01a1ee4e-6742-77c9-bc14-5a9283fc81c5` **CONFIRMED** por 3000 minor.
- Não surgiu nova exceção. A única exceção OPEN no tenant é a anterior, referente a pagamento externo sem contraparte local.
- Replay do mesmo payload no endpoint do webhook retornou 202 `{"accepted":true,"deduped":true}`. Após o replay, havia 1 linha no inbox para o evento, 1 pagamento para a cobrança e o pedido permanecia SETTLED: sem duplicação.
- Conclusão: jornada financeira ponta a ponta homologada em Sandbox — pedido local → cobrança Asaas → evento originado pelo provedor → liquidação e conciliação, sem dinheiro real. A ressalva anterior de "evento injetado" foi superada por esta execução originada pelo Asaas.
- Nota: a CLI Asaas do OpenMausBot e o receiver local `/asaas/webhook` são caminhos distintos do ingress StreamMax (`/v1/webhooks/asaas/:tenantKey`). O webhook Sandbox configurado aponta apenas para o StreamMax, sem dupla ação.

### #86 — evento originado pelo Asaas Sandbox (complemento)
- Webhook do Sandbox atualizado via API para incluir PAYMENT_CONFIRMED (além de RECEIVED/OVERDUE/REFUNDED); o normalizador do StreamMax aceita PAYMENT_CONFIRMED como evento pago.
- Cliente sintético `cus_000010025221` e cobrança em cartão de teste aprovado (4444...) criados no Sandbox — sem dinheiro real.
- O Asaas Sandbox emitiu `PAYMENT_CONFIRMED` `evt_15e444ff9b9ab9ec29294aa1abe68025&25429909` (payment `pay_0_h02bkq6bpavaww`, R$10,00): ingress autenticado, 202, 1 linha no inbox PROCESSED.
- Como o payment é externo ao StreamMax, o sistema registrou corretamente 1 exceção `UNKNOWN_CHARGE` (OPEN, reason "no domain mutation") e NÃO alterou nenhuma charge/pedido/ledger. Nenhuma duplicação financeira; total de charges permaneceu 4.
- Conclusão #86: ingresses injetado e originado pelo provedor comprovados, autenticação e idempotência verificadas. Limite: a exceção UNKNOWN_CHARGE é o comportamento correto para pagamento sem contraparte local; não houve liquidação financeira de ponta a ponta no StreamMax (isso exigiria pedido/charge casados com o pagamento Sandbox).

### #87 — homologação com sessão autorizada (complemento)
- Proprietário autorizou reutilizar a sessão `ted` e o número 556195613225.
- Mensagem sintética enviada via WAHA `sendText` para o chat LID `125842558599202@lid` foi entregue (fromMe=true, ack=3). A ponte ignora mensagens fromMe, portanto não houve laço/dupla resposta.
- O inbound seguinte da mesma sessão gerou exatamente 1 job queued e 1 envio=201 (job 21), sem duplicação.
- Conclusão #87: transporte WAHA integralmente validado no canal de teste autorizado, sem impacto a clientes reais. A mensagem sintética foi entregue (fromMe=true, ack=3); a ponte ignora fromMe, sem laço. O inbound seguinte gerou exatamente 1 job queued e 1 envio=201 (job 21), sem duplicação, e não houve envio extra.
- `communication.tenant_channels` não possui linha WHATSAPP ativa e `resolve_waha_session_owner('ted')` retorna vazio: não existe binding S3a para a sessão externa `ted`.
- O hub mostra `WhatsApp: NOT_CONFIGURED` porque lê `provider.provider_accounts`, e o fluxo de escrita do hub recusa whatsapp como `CAPABILITY_UNCERTIFIED`. Isso é uma representação fiel da arquitetura vigente, não uma falha de tráfego WAHA.
- A associação operacional existe por outra via, comprovada em leitura: sessão WAHA `ted` → ponte wa-bridge-atendente → bot Atendimento do OpenMausBot → credencial de serviço ativa `openmausbot-staging` (id `1c6038a7-f7bd-4c08-bab8-d76200009e5e`) vinculada ao tenant StreamMax `01a1a15d-6e23-74dd-9435-dcbb468544f9`.
- Reutilizar S3a (`whatsapp.session_ensure`) criaria uma sessão derivada `tenant-<hex>`, diferente de `ted`, duplicando a integração — contrário à diretriz de não duplicar. Portanto, registrar a arquitetura externa é a correção adequada; não criar binding novo.
- Conclusão: transporte homologado e associação funcional ao tenant comprovada pela credencial; ausência de binding em `communication.tenant_channels` é característica da topologia atual, documentada, sem risco de respostas duplicadas (canal único, dono da resposta = WAHA/ponte).

### #88 — homologação da operação do fornecedor (18/11/2026)

#### CINEVISION-1 — bloqueio externo classificado
- Pré-condições: pedido `01a1ee4d-3643-729a-991f-e451d04cea77` SETTLED; assinatura `01a1ee4e-f532-74e5-8e01-a14f5ca3ffa8` PENDING_ACTIVATION; entitlement `plan:e2e-monthly` PENDING; operação `01a1ee4e-f57a-7069-b14e-02de504634ad` `subscription.provision` HUMAN_REQUIRED/UNKNOWN — sem ativação prévia.
- Validação somente leitura no painel ("Validar acesso") em 18/11 às 11:59 UTC: `connection_status=TESTING`, `last_error_code=CHALLENGE_DETECTED`. Automação interrompida, sem bypass; assinatura preservada como PENDING_ACTIVATION.

#### CINEVISION-2 — operação no fornecedor (autorização específica do proprietário)
- O proprietário autorizou usar aba autenticada no Orca e renovar UMA vez a linha pessoal `986093817` em CINEVISION de PRODUÇÃO (não há Sandbox CINEVISION), com no máximo 1 crédito.
- Antes: linha `986093817`, plano "1- PLANO COMPLETO 1 MÊS" (R$25), vencimento 30/11/2026 23:59:59, status Ativo, 1 conexão, titular "junio campos", 8 créditos na conta.
- Renovação executada uma única vez no painel oficial: 1 crédito deduzido (8 → 7); readback no painel confirmou novo vencimento 30/12/2026 23:59:59, status Ativo, mesmo plano e 1 conexão. Nenhuma segunda renovação; nenhum pedido criado no fornecedor.
- Limite ético/contratual: a linha é pessoal do proprietário e NÃO pertence à pessoa sintética da assinatura E2E; portanto NÃO há associação legítima para promover a assinatura `01a1ee4e-...` a ACTIVE. O StreamMax permanece com assinatura PENDING_ACTIVATION e operação HUMAN_REQUIRED.
- Conclusão parcial: homologada a operação de renovação no fornecedor com readback independente; NÃO homologada a jornada completa "pagamento → ativação de nova assinatura" por falta de linha de teste vinculável à assinatura E2E. Issue #88 permanece ABERTA.

### #89 — fechamento da validação operacional do painel (18/11/2026)

#### Erros e retry (tenant E2E)
- Login inválido retornou `401 INVALID_CREDENTIALS`; requisição sem token retornou `401`; corpo inválido retornou `400 VALIDATION_FAILED`; revisão de contexto obsoleta retornou `409 TENANT_CONTEXT_CONFLICT`.
- A criação de pessoa repetida com a mesma `Idempotency-Key` retornou o mesmo ID, sem duplicação.
- Após criar um pedido via API, a UI mostrava 4 de 4 até a ação “Recarregar”; depois, passou a mostrar 5 de 5, em concordância com a API e o banco.

#### Isolamento A/B
- Tenant A E2E (`01a1dd7f…`): `/v1/me` identificou `tenant_owner`; havia 5 pedidos e Asaas `CONNECTED_READ_ONLY`.
- Tenant B descartável criado por `POST /v1/tenants` (`01a1ee63-fd36-7033-bdaf-cdbdea734310`); troca realizada por `POST /v1/tenants/{id}/switch` com revisão de contexto.
- Tenant B: 0 pedidos e Asaas `NOT_CONFIGURED`. A leitura de pedido do tenant A a partir de B retornou `404 NOT_FOUND`; ao voltar para A, os 5 pedidos estavam presentes.
- Na UI, tenant B apareceu no seletor após reload; a troca por teclado (setas + Enter) funcionou; Pedidos mostrou “Nenhum pedido” e Integrações refletiu o estado do tenant ativo.

#### Disable/re-enable isolado
- No tenant B: configure → `DRAFT` v1; test → `CONNECTED_READ_ONLY` v1; disable (`expectedVersion` 1) → `DISABLED` v2 (leitura `NOT_CONFIGURED`); configure → `DRAFT` v1; test → `CONNECTED_READ_ONLY` v1.
- Tenant A permaneceu `CONNECTED_READ_ONLY` durante todo o ciclo.
- Teardown: binding de B desabilitado e segredos, binding, sessões, membro, pessoa e identidade de B removidos. O registro do tenant B permanece vazio porque `platform.audit_log` é append-only e impede a remoção do registro por FK; não restaram membro, segredo, binding ou dados. Tenant A permaneceu intacto (2 memberships, 2 bindings ativos, 5 pedidos).

#### Conclusão
- Critérios de #89 atendidos: autenticação, erro/retry, isolamento A/B, disable/re-enable isolado, consistência UI/API/banco e regressão de #86/#87 preservada.
