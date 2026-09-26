# SPEC — Subscription, Cycles & Entitlements v1.0

> Status: Supporting detail — reconciled under v1.0 implementation baseline

## Purpose

Represent a long-lived customer service relationship separately from economic Orders/Payments and from external provider state.

## Aggregates

### CustomerSubscription

Canonical lifecycle: `PENDING_ACTIVATION | ACTIVE | SUSPENDED | ENDED`.

Normal cancellation is a renewal instruction such as `cancel_at_period_end=true`; the subscription remains ACTIVE while paid entitlement remains valid.

### SubscriptionCycle

Every paid renewal creates a new cycle with start/end, source Order, configuration snapshot and applicable price/policy versions. Renewal does not overwrite the previous cycle and does not create a brand-new Subscription relationship.

Early renewal preserves remaining paid days according to policy.

### Entitlement

Represents rights such as service access, connection quantity, adult preference, app license, promotional entitlement or temporary grant. Provider state is the materialization/observed implementation of those rights, never the canonical right itself.

## Required invariants

- Order != Charge != Payment != Subscription != ProviderOperation.
- financial delinquency remains in Billing; CRM/Analytics may project risk/delinquency.
- additional connections purchased mid-cycle expire with the primary cycle.
- reducing connection quantity is normally effective on next renewal; no fictitious provider proration/refund.
- customer may use multiple devices/apps; simultaneous-stream limit comes from connection entitlement/provider enforcement.
- adult content is a mutable preference/entitlement, not a separate commercial SKU.
- cancel-at-period-end preserves the whole paid period.
- external provider drift does not silently mutate Subscription.

## Trust Renewal

`TrustRenewalGrant` is separate from paid cycles and generic grace. CINEVISION capability is exactly +3 days and only when provider account is ACTIVE with <=3 days remaining. Expired accounts and accounts with >3 days remaining are ineligible. No arbitrary +N capability is exposed.

## Technical Access

`TechnicalAccessGrant` is a support concept for existing/ex-customers and may be materialized with provider test accounts of 1h/3h/6h. It does not consume the one commercial ServiceTrial and does not become a paid SubscriptionCycle.

## Renewal command flow

`RenewSubscription` validates current subscription/configuration → resolves Offer/Order/payment or eligible internal credit → creates new cycle/entitlements → requests provider operation → verifies postcondition → notifies customer.

Unknown provider effect enters reconciliation before retry.

## Core events

- `subscription.created`
- `subscription.cycle.started`
- `subscription.cycle.ended`
- `subscription.entitlement.granted|expired|revoked`
- `subscription.cancel_at_period_end_set`
- `subscription.suspended`
- `subscription.ended`

Event versions use the canonical event envelope: the semantic names above decompose to public IDs as `<domain>.<fact>.v<major>` with `event_type = <domain>.<fact>` plus integer `schema_version = <major>` in the envelope (see `docs/03-architecture/event-contract-conventions.md` and the explicit registry in `docs/02-domain/event-model.md`). The domain-document level keeps semantic names unversioned; only registered public IDs (e.g. renewal facts such as `subscription.renewed.v1`) appear on the wire. No subscription lifecycle state above is altered by this versioning rule.

## Acceptance anchors

See E2E G06, G08, G09, G10 and failure F02/F03/F12 in `docs/15-implementation-baseline/14-e2e-acceptance-matrix.md`.
