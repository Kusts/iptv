# Runbook — Primeira venda do piloto (via API)

> A UI web ainda não cria pedidos (`/orders` é somente leitura). Até a UI
> existir, a venda do piloto é feita por estes endpoints, todos reais e
> cobertos por suítes de integração. Pré-requisito: staging no ar
> (`/v1/health` e `/v1/health/ready` → 200) e `API_SCHEDULER_ENABLED=1`.

Base: `https://staging-api.synkroo.com.br`. Autenticação: `POST /v1/auth/login`
→ sessão (`iptv_session` ou Bearer). Permissões necessárias:
`commerce.order.write`, `billing.charge.write`, `billing.read`,
`subscription.read/write`. Envie `Idempotency-Key` próprio em cada POST.

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

## 3. Cliente no provedor (somente modo Asaas real/sandbox)

```http
POST /v1/billing-customers/provision
{ "personId": "<uuid>" }
→ { "providerCustomerId": "cus_...", "provisioned": true }
```

Sem binding, o provider recusa e a cobrança fica `PENDING` (`KNOWN_NOT_APPLIED`).
Em modo echo este passo é no-op.

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

## 5. Fulfillment manual supervisionado (Caminho B)

O pagamento confirmado NÃO ativa sozinho. O operador:

1. Vê a pendência em `/fulfillment` ou `/provider-operations`.
2. Ativa o serviço no painel autorizado do fornecedor.
3. Registra a referência:

```http
POST /v1/fulfillment/subscriptions/<subscriptionId>/request
```

4. Confere em `GET /v1/subscriptions/<id>` (ciclos + direitos) — só marque
   entregue após verificação. Falhas/estados desconhecidos ficam visíveis em
   `/provider-operations` para reconciliação (`reconcile`/`resolve`).

## 6. Reembolsos (política MANUAL)

Reembolsos nunca são automáticos: registre em `POST /v1/refund-requests`,
exija segunda aprovação humana (auto-aprovação é rejeitada) e movimente o
dinheiro pelo dashboard/API do provedor; o sistema reconcilia depois.

## Erros comuns

| Sintoma | Causa provável |
|---|---|
| `409 TENANT_CONTEXT_CONFLICT` | faltou o header `x-tenant-context-revision` da sessão |
| charge `PENDING` sem `providerChargeId` | sem binding (passo 3) ou adapter echo |
| `503 UNAVAILABLE` | banco fora / scheduler desligado |
| webhook `401` | segredo de canal errado (`billing.tenant_channels`) |
