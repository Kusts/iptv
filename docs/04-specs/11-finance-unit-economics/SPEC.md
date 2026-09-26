# SPEC — Financial Intelligence & Unit Economics

> Status: Supporting detail — reconciled under v1.0 implementation baseline
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Purpose

Calculate economic performance from immutable commercial/ledger facts rather than dashboard-only formulas.

## Core equation

```text
Contribution Profit =
Revenue
- provider COGS
- payment fees
- acquisition cost allocation
- discounts/rewards
- app/license subsidy
- support allocation
- AI/messaging/infra allocation
```

## Required dimensions

Customer, Plan, Product/Add-on, Channel, Campaign, Creative, Coupon, Referral, Server, Device/App, Cohort and Period.

## Cash vs economics

Keep cash received, recognized/managerial revenue, COGS, gross profit and contribution profit distinct. Long-duration plans must not be interpreted as one-month MRR simply because cash arrived upfront.

## Reward economics

Store perceived value separately from actual cost. A free additional screen/month can have zero customer revenue but non-zero recurring provider cost.

## Attribution

CAC/paid media cost allocations use canonical attribution model; provider-reported ROAS is never substituted for internal contribution profit.

## Acceptance

For a customer/cycle the system can explain every major revenue/cost component back to an authoritative source/ledger reference.

## Auto-review result

Reviewed to prevent revenue-only optimization and to keep recurring add-on/provider costs visible.
