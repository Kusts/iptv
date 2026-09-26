# Commerce & Billing — State Machines v1.0

> Status: FINAL supporting detail.

## CustomerOrder

`DRAFT | PENDING_ACCEPTANCE | PENDING_SETTLEMENT | SETTLED | FULFILLING | COMPLETED | CANCELLED | EXPIRED`.

Typical economic path: `DRAFT → PENDING_ACCEPTANCE → PENDING_SETTLEMENT → SETTLED`; fulfillment follows independently.

SETTLED means the economic order obligation is satisfied; fulfillment may still be pending.

## Payment

`PENDING | PROCESSING | PAID | FAILED | CANCELLED | EXPIRED | PARTIALLY_REFUNDED | REFUNDED | CHARGEBACK`.

Provider-specific Asaas statuses are mapped in the adapter and are not canonical domain enums.
`PAID` is not the same fact as Order `SETTLED`. Reversals/reimbursements preserve the original payment and append ledger adjustments.

## Refund

`RefundRequest` represents review/decision; `Refund` represents the executed financial effect. Customer/Agent request → HumanReview → approved/rejected → execution if approved. Refund is never automatic in the MVP.
