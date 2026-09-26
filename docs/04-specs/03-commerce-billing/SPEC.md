# SPEC — Commerce & Billing Core

> Status: Supporting detail — reconciled under v1.0 implementation baseline
> Versão: 1.0  
> Slice: MVP-03  
> Dependências: Identity/CRM, Catalog/Offer rules, Financial Ledger baseline

## 1. Objetivo

Transformar uma oferta válida em `Order`, liquidar sua obrigação financeira com pagamentos e/ou créditos internos e produzir fatos confiáveis para assinatura/entitlements sem confundir dinheiro recebido com settlement comercial.

## 2. Conceito central

```text
Order SETTLED
≠
Payment CONFIRMED
```

Uma Order pode ser `SETTLED` por:

- pagamento externo confirmado;
- combinação de pagamento + reward/referral credit;
- valor líquido zero por benefício válido;
- outra forma explicitamente suportada pelo ledger/policy.

Nunca criar pagamento fictício para uma Order de valor zero.

## 3. Order Lifecycle

```text
DRAFT
AWAITING_PAYMENT
SETTLED
CANCELLED
EXPIRED
```

Offer acceptance is represented by Offer/Commerce policy. Fulfillment is intentionally outside the Order lifecycle and belongs to Subscription/Entitlements/Provider Operations.

## 4. Charge Lifecycle

```text
PENDING
PROCESSING
PAID
FAILED
CANCELLED
EXPIRED
```

A Charge is an external collection obligation/attempt.

## 5. Payment Lifecycle

```text
CONFIRMED
PARTIALLY_REFUNDED
REFUNDED
CHARGEBACK
```

A Payment exists only after confirmed money movement. Pending/failed/expired collection belongs to Charge, not Payment.

## 6. Price snapshot

Ao criar Order, congelar no mínimo:

- product/plan/add-on identifiers;
- unit sale price;
- quantity;
- discount/reward applied;
- supplier/provider cost basis conhecido no momento quando aplicável;
- currency;
- tax/fee assumptions quando relevantes;
- offer/coupon/referral references.

Mudança futura de catálogo não altera Order histórica.

## 7. API

```text
POST /v1/offers/resolve
POST /v1/orders
GET  /v1/orders/{orderId}
POST /v1/orders/{orderId}/charges
POST /v1/webhooks/asaas
```

## 8. Fluxo de compra

```text
resolve allowed offer
↓
create Order + items + price snapshots
↓
AWAITING_PAYMENT
↓
create Charge if net > 0
↓
external provider confirms Charge payment
↓
validate + dedupe webhook
↓
create Payment CONFIRMED exactly once
↓
ledger transaction
↓
recompute settlement
↓
Order SETTLED
↓
order.settled.v1
```

Se net == 0 após benefícios válidos:

```text
ledger/reward consumption
↓
Order SETTLED
```

sem `Payment` falso.

## 9. Webhook intake

Entrada externa é apenas evidência até ser validada.

Obrigatório:

- autenticar/validar conforme capacidade do provider;
- persistir external event ID;
- deduplicar;
- responder rapidamente quando recomendado;
- processar efeito de forma idempotente;
- reconciliar periodicamente.

## 10. Ledger

Toda liquidação relevante gera lançamentos append-only.

Exemplo simplificado:

```text
Dr Cash/Receivable
Cr Subscription Revenue / Deferred Revenue account
```

Rewards/referral credits devem reduzir obrigação por entries próprias, não por overwrite de saldo.

O detalhamento contábil fiscal não é definido por esta SPEC; o ledger aqui é operacional/gerencial e precisa permitir reconciliação completa.

## 10. Recurring additional connection

Tela/conexão adicional é um **recurring add-on**, mas é opcional em cada renovação. Quando ativada no meio de um ciclo, acompanha o mesmo vencimento da assinatura principal.

Cada ciclo em que estiver selecionada precisa gerar:

```text
recurring add-on revenue
+
recurring provider COGS
```

Não existe compra permanente. Remoção solicitada durante ciclo já pago é agendada para o próximo ciclo; não há redução/reembolso proporcional automático.

## 11. Idempotência

Chaves distintas por efeito:

- create Order;
- create payment;
- webhook external event;
- reward/referral redemption;
- ledger posting.

Replay não pode:

- duplicar receita;
- duplicar reward consumption;
- liquidar Order duas vezes;
- criar duas renovações.

## 12. Refund/chargeback

Refund e chargeback não apagam fatos anteriores.

Fluxo:

```text
Payment CONFIRMED
↓
refund/chargeback fact
↓
ledger reversal/adjustment
↓
policy evaluates downstream entitlement/subscription consequences
```

## 13. Eventos

```text
offer.created.v1
offer.presented.v1
offer.accepted.v1
offer.expired.v1
coupon.applied.v1
coupon.rejected.v1
order.created.v1
order.settled.v1
order.cancelled.v1
order.expired.v1
charge.created.v1
charge.processing.v1
charge.paid.v1
charge.failed.v1
charge.expired.v1
charge.cancelled.v1
payment.confirmed.v1
payment.partially_refunded.v1
payment.refunded.v1
payment.chargeback.v1
```

## 14. Critérios de aceitação

- CA-01: alterações futuras de price não mudam histórico.
- CA-02: webhook duplicado não duplica ledger/effects.
- CA-03: Order zero-value pode ser SETTLED sem Payment CONFIRMED.
- CA-04: Payment CONFIRMED sozinho não pula regras de settlement/reconciliation.
- CA-05: reward/referral consumption é ledgered/auditável.
- CA-06: additional connection recorrente reaparece em renewal order enquanto ativa.
- CA-07: refund não apaga pagamento original.
- CA-08: cross-tenant order access é bloqueado.

## 15. Testes mínimos

- normal paid order;
- duplicate webhook;
- zero-value rewarded order;
- partial discount + payment;
- payment failed then retry;
- refund;
- chargeback;
- recurring add-on inclusion in renewal;
- price changed after historical order;
- outbox atomicity.
## 16. Billing e negociação v0.14

- mensal baseline confirmado: R$30; demais pacotes e campanhas usam Price Version/Offer Snapshot.
- Agent pode negociar somente entre Target/Floor/benefícios definidos em Commercial Policy; cupom é instrumento estratégico.
- Referral pode beneficiar **quem indica e quem é indicado**, com qualification distinta.
- PIX é default, cartão é alternativa, boleto é exceção com compensação/follow-up.
- cada cobrança externa do MVP exige o valor líquido integral; pagamentos parciais externos arbitrários ficam fora de escopo.
- renovação antecipada pode aplicar desconto imediato configurável (piloto pode testar R$30 → R$25) e deve gerar snapshot próprio.
- refund é operação R4/HITL: IA prepara evidências e impacto, humano autoriza/nega.
- eventual `ResidualAccess` recupera custo operacional em workflow separado; nunca é condição para o direito do cliente ao refund.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — payment, refund, offer and connection economics checked.

