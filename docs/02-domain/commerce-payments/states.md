# Commerce & Billing — State Machines v1.0

> Status: FINAL supporting detail.

## CustomerOrder

`DRAFT | AWAITING_PAYMENT | SETTLED | CANCELLED | EXPIRED`.

Typical economic path: `DRAFT → AWAITING_PAYMENT → SETTLED`. Fulfillment is owned by Subscription/Entitlements/Provider Operations and is deliberately not an Order state.

SETTLED means the economic order obligation is satisfied; fulfillment may still be pending.

## Charge

`PENDING | PROCESSING | PAID | FAILED | CANCELLED | EXPIRED`.

A Charge represents an external collection obligation/attempt. Provider-specific Asaas statuses map here. A paid Charge is validated evidence used to create exactly one canonical Payment.

## Payment

`CONFIRMED | PARTIALLY_REFUNDED | REFUNDED | CHARGEBACK`.

A Payment exists only after money movement is confirmed. It is not the same fact as Order `SETTLED`. Reversals/reimbursements preserve the original Payment and append ledger adjustments.

## Refund

`RefundRequest` represents review/decision; `Refund` represents the executed financial effect. Customer/Agent request → HumanReview → approved/rejected → execution if approved. Refund is never automatic in the MVP.

## RefundRequest

`REQUESTED | UNDER_REVIEW | APPROVED | REJECTED | EXPIRED | CANCELLED | EXECUTED`

## Refund

`PROCESSING | RECONCILING | SUCCEEDED | FAILED | CANCELLED`

Refund execution has orthogonal effect certainty `KNOWN_APPLIED | KNOWN_NOT_APPLIED | UNKNOWN`; an unknown external effect reconciles before any retry.
