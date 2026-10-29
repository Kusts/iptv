# Runbook — Primeira venda do piloto (via API)

> A criação de pedidos pode ser feita diretamente na UI web (`/orders`) com formulário ("Novo pedido") ou via API. Abaixo constam os endpoints caso a operação seja executada via API/curl, todos reais e cobertos por suítes de integração. Pré-requisito: staging no ar (`/v1/health` e `/v1/health/ready` → 200) e `API_SCHEDULER_ENABLED=1`.

Base: `https://staging-api.synkroo.com.br`. Autenticação: `POST /v1/auth/login`
→ sessão (`iptv_session` ou Bearer). Permissões necessárias:
`commerce.order.write`, `billing.charge.write`, `billing.read`,
`subscription.write` (from-order), `provider.operation.write` (resolve).
Envie `Idempotency-Key` próprio em cada POST.

## 1. Cliente

Criar/ver na UI (`/crm`) ou `POST /v1/crm/persons`. Anote o `personId` (UUID).

## 2. Pedido: quote → submit

```http
POST /v1/orders/quote
{ "personId": "<uuid>", "items": [{ "sellableType": "PLAN", "sellableId": "<uuid-do-catalogo>", "quantity": 1 }], "orderType": "NEW_SUBSCRIPTION" }
→ { "id": "<orderId>", "status": "DRAFT", ... }

POST /v1/orders/<orderId>/submit
→ { "id": "<orderId>", "status": "AWAITING_PAYMENT" }
```

## 3. Cliente no provedor (obrigatório em todos os modos)

```http
POST /v1/billing-customers/provision
{ "personId": "<uuid>" }
→ { "providerCustomerId": "cus_...", "provisioned": true }
```

Sem binding, `charge.create` falha fechado ANTES de criar qualquer cobrança
(`precondition_failed`, sem linha `PENDING` para reconciliar). O provisionamento
também persiste binding em modo echo — não é dispensável em nenhum modo.

## 4. Cobrança PIX

```http
POST /v1/charges
{ "orderId": "<orderId>", "paymentMethod": "PIX", "billingType": "PIX" }
→ { "id": "<chargeId>", "status": ..., "providerChargeId": "..." }
```

Devolva os dados PIX ao cliente. Em sandbox, simule o pagamento no dashboard
Asaas; o webhook `PAID` confirma sozinho (`POST /v1/webhooks/asaas/:tenantKey`,
auth por canal, sem fallback global). Conferir:

```http
GET /v1/charges            → charge PAID
GET /v1/payments           → payment CONFIRMED
GET /v1/orders/<orderId>   → order SETTLED
```

Replays duplicados são no-op (dedupe de inbox). Qualquer divergência cai em
`GET /v1/billing-exceptions` — nunca confirme manualmente sem reconciliar
(`POST /v1/charges/:id/reconcile`).

## 5. Assinatura e fulfillment manual supervisionado (Caminho B)

Com o pedido `SETTLED`, crie a assinatura (permissão `subscription.write`):

```http
POST /v1/subscriptions/from-order
{ "orderId": "<orderId>" }
→ { "id": "<subscriptionId>", ... }   (PENDING_ACTIVATION)
```

O pagamento confirmado NÃO ativa sozinho. O operador:

1. Vê a pendência em `/fulfillment` ou `/provider-operations`.
2. Solicita o trabalho (`POST /v1/fulfillment/subscriptions/<subscriptionId>/request`
   — no adapter manual retorna `HUMAN_REQUIRED`, mantendo pendente por desenho).
3. Ativa o serviço no painel autorizado do fornecedor.
4. Resolve a operação com o resultado verificado (permissão
   `provider.operation.write`):

```http
POST /v1/provider/operations/<operationId>/resolve
{ "outcome": "SUCCEEDED", "note": "<referencia da ativacao no painel>" }
```

(`outcome` também aceita `FAILED`/`UNKNOWN`; `note` é obrigatório na prática
para auditoria.) Só considere entregue após este resolve. Falhas e estados
desconhecidos ficam visíveis em `/provider-operations` para reconciliação
(`reconcile`/`resolve`).

## 6. Reembolsos (política MANUAL)

Reembolsos nunca são automáticos: registre em `POST /v1/refund-requests`,
exija segunda aprovação humana (auto-aprovação é rejeitada) e movimente o
dinheiro pelo dashboard/API do provedor; o sistema reconcilia depois.

## Erros comuns

| Sintoma | Causa provável |
|---|---|
| `409 TENANT_CONTEXT_CONFLICT` | faltou o header `x-tenant-context-revision` da sessão |
| charge rejeitado (`precondition_failed`, sem linha criada) | sem binding (passo 3) — rode `billing.customer_provision` antes |
| `503 UNAVAILABLE` | banco fora / scheduler desligado |
| webhook `401` | segredo de canal errado (`billing.tenant_channels`) |
