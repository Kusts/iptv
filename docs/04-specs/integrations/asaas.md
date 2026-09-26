# Integration SPEC — Asaas Billing Adapter

> Status: Proposed for MVP implementation  
> Version: 1.0  
> Research checkpoint: official Asaas documentation reviewed on 2026-09-20.  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Purpose

Use Asaas as the initial external billing/payment provider while keeping Order, Charge, Payment, Ledger and Subscription states authoritative inside our platform.

## Boundary

Asaas is responsible for external charge/payment processing. It is **not** the authority for:

- Order pricing;
- internal rewards/referral credits;
- subscription entitlement rules;
- provider fulfillment;
- contribution margin.

## Required adapter capabilities

```text
createCustomerBinding (only if required by Asaas flow)
createCharge
getCharge
cancelCharge when allowed
requestRefund when allowed
receiveWebhook
reconcileChargeAndPayment
```

Exact endpoint/version mapping must be pinned during implementation against the active Asaas API version.

## Webhook contract

Official Asaas documentation currently states:

- delivery is **at least once**;
- the same event keeps the same event `id` across duplicate deliveries;
- application should persist the event before business processing;
- after durable persistence, reply HTTP 200 and process asynchronously;
- webhook origin is validated using the configured authentication token sent in `asaas-access-token`;
- the webhook payload may gain new fields, so parsing must tolerate unknown attributes.

Our receiver therefore follows:

```text
POST webhook
→ validate auth token
→ persist inbox event with unique external event id
→ HTTP 200
→ async canonicalization
→ Charge transition
→ create/reconcile canonical Payment when confirmed
→ Ledger/Settlement workflow
```

## Idempotency

Unique external webhook event id is persisted in Inbox. A replay can update receipt metadata but cannot repeat settlement, ledger posting or fulfillment.

Charge creation must also use an internal idempotency/effect key. If request outcome is unknown after timeout, reconcile/query before creating another external charge.

## Mapping rule

Provider collection statuses/events map into canonical Charge states/events. A validated paid Charge creates or reconciles one canonical `Payment.CONFIRMED`. Application code must not expose Asaas event names as internal domain states.

Mapping is versioned in adapter code and covered by contract tests.

## Reconciliation

Reconciliation compares:

```text
Internal Charge + confirmed Payment
↕
External Asaas charge/payment observation
```

External evidence can identify drift; it does not blindly overwrite ledger/order history.

## Security

- API keys and webhook auth token in secret manager;
- never reuse Asaas API key as webhook auth token;
- no secret in audit/event payload;
- webhook endpoint has rate/size limits and JSON validation;
- log event id/type, not full sensitive payload by default.

## Failure behavior

| Failure | Behavior |
|---|---|
| duplicate webhook | acknowledge, no duplicate side effect |
| invalid auth token | reject, security metric |
| unknown extra field | tolerate |
| unknown event type | persist/classify; do not mutate domain until mapped |
| provider timeout after charge create | reconcile before retry |
| webhook processing error after durable receipt | retry async processing |
| queue/webhook interruption | alert + reconciliation/backfill |

## Minimum tests

- authenticated webhook;
- invalid token;
- duplicate event id;
- unknown payload fields;
- PAYMENT-like success mapping;
- overdue mapping;
- refund mapping;
- create timeout + reconcile;
- repeated settlement event does not duplicate ledger.

## Auto-review result

Reviewed to ensure Asaas remains an adapter, at-least-once delivery is explicitly handled and external events cannot directly authorize fulfillment without canonical internal transitions.
