# Pilot Fixtures v0.10

> Status: Proposed  
> Date: 2026-09-20

## Goal

Provide a reproducible, non-production fixture set that exercises the first operational loops without embedding real customer information or unresolved commercial assumptions.

## Fixture design

The seed intentionally creates two synthetic people:

1. **Lead Exemplo** — an engaged Lead with one primary `TRIAL` already `ACTIVE`. This fixture proves that a subsequent primary Trial must be denied and that a later exception must be represented as `RETRIAL`.
2. **Cliente Exemplo** — an active Customer with an open WhatsApp conversation, a new Support Ticket and an active referral to the synthetic lead.

It also creates:

- pilot tenant + owner membership;
- safe feature flags with outbound AI/browser/messaging disabled;
- placeholder CINEVISION provider account without live secret;
- confirmed monthly plan at BRL 30.00;
- recurring additional-connection add-on with price intentionally `TBD`;
- known provider-credit package table;
- referral program and reward definitions without inventing reward economics.

## Why no real data

Development fixtures must be shareable, resettable and safe to use in CI. Real WhatsApp numbers, provider credentials, payment information or customer history would violate that goal and complicate privacy/retention controls.

## Commercial facts versus unresolved policy

Seeded as known:

- monthly plan: BRL 30.00;
- provider credit packages captured during discovery;
- CINEVISION servers include ONE and XTREAM as provider context;
- additional connection is recurring and has recurring provider cost;
- Trust Renewal capability reference: exactly +3 days, only for ACTIVE accounts with remaining_days <= 3; not a generic reward and no invented cooldown.

Not invented:

- price charged for an additional connection;
- quarterly/semiannual/annual prices;
- number of referrals required for each reward;
- monetary value/cost of reward definitions.

## Gate

The seed is considered runtime-validated only after:

1. migrations `001–011` succeed in a clean PostgreSQL database;
2. seed applies successfully;
3. repeated seed application causes no duplicate-domain effects;
4. cross-tenant integration tests remain green;
5. fixture IDs can be queried by the implementation test suite.
