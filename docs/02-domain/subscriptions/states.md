# Subscription — State Machine v1.0

> Status: FINAL supporting detail. Canonical catalog: `docs/15-implementation-baseline/03-state-machines.md`.

`CustomerSubscription` represents the recurring relationship. Renewal history belongs to `SubscriptionCycle`.

## States

`PENDING_ACTIVATION | ACTIVE | SUSPENDED | ENDED`

Normal cancellation does not create an immediate cancellation state. Use `cancel_at_period_end` / renewal policy while the subscription remains ACTIVE through the paid cycle.

Financial delinquency is owned by Billing (`Order/Charge/Payment/PromiseToPay`) and may be projected into CRM/Analytics; it is not the canonical Subscription state machine.

## Core transitions

- create after valid commercial settlement/relationship setup → `PENDING_ACTIVATION`;
- required activation/entitlements fulfilled → `ACTIVE`;
- policy-driven temporary suspension → `SUSPENDED`;
- restoration/recovery → `ACTIVE`;
- paid period ends with no continuing entitlement → `ENDED`;
- reactivation creates a new cycle on the existing relationship as policy allows.

## Renewal

Every paid renewal creates `SubscriptionCycle`. Early renewal preserves remaining paid days according to policy; it never silently restarts the cycle at payment time and loses customer value.

## Trust Renewal

CINEVISION Trust Renewal is a separate temporary grant/provider capability: exactly +3 days, account ACTIVE and remaining days <= 3. It is not Payment, Order settlement, generic GRACE or a paid SubscriptionCycle.

## Connections/adult/cancellation

- additional connections share the current primary expiration;
- removing a connection mid-cycle schedules lower quantity for the next cycle rather than creating a fictitious prorated provider refund;
- adult content is a mutable preference/entitlement, not a plan SKU;
- cancel-at-period-end preserves the full paid period.
