# SPEC — Inventory & Procurement Intelligence

> Status: Supporting detail — reconciled under v1.0 implementation baseline
> Version: 1.1  
> Review: Auto-reviewed v0.14 — reconciled with credit packages, monthly-plan possibility, MK supplier balance, app trial and residual inventory.

## Purpose

Treat provider credits, supplier balances, licenses and reusable residual capacity as distinct inventory/economic assets; forecast depletion/expiry and support purchasing decisions without granting arbitrary spend authority.

## Core entities

`Supplier`, `SupplierProduct`, `SupplierOffer`, `CommercialAgreement`, `CreditPurchase`, `CreditBatch`, `CreditConsumption`, `SupplierBalanceLedger`, `InventoryReservation`, `AppTrial`, `LicenseAsset`, `ResidualAccess`, `InventoryProjection`.

## Inventory classes

```text
CINEVISION prepaid credits
CINEVISION monthly credit batches (future/conditional)
MK Ativador prepaid monetary balance
App license assets
Residual accesses eligible for reallocation
```

Balances are ledger-derived. Manual adjustments require reason/evidence/actor. Reservations separate `total`, `reserved` and `available`.

## CINEVISION prepaid packages

Known snapshot used for planning:

| Credits | Total | Unit |
|---:|---:|---:|
| 1 | R$10 | R$10.00 |
| 5 | R$40 | R$8.00 |
| 10 | R$70 | R$7.00 |
| 25 | R$175 | R$7.00 |
| 50 | R$325 | R$6.50 |
| 75 | R$487.50 | R$6.50 |
| 100 | R$600 | R$6.00 |
| 150 | R$900 | R$6.00 |
| 200 | R$1,100 | R$5.50 |
| 250 | R$1,375 | R$5.50 |
| 500 | R$2,500 | R$5.00 |
| 750 | R$3,750 | R$5.00 |
| 1000 | R$4,500 | R$4.50 |

Historical purchases retain their cost basis.

## Monthly credit-plan model

The operation may later switch to a supplier monthly plan: pay fixed R$X, receive X credits each cycle, unused credits expire and a fresh batch replaces them. An approximate minimum of 100 credits was reported but remains **LIVE VALIDATION REQUIRED** before implementation.

Each batch must persist `period_start`, `period_end/expiry`, `quantity`, `consumed`, `remaining`, `contract_cost`. Effective unit cost uses credits actually consumed, not only nominal quantity. If monthly and non-expiring prepaid credits coexist, consume expiring economically-equivalent batches first (FEFO).

The analyzer compares prepaid vs monthly using volume, growth, volatility, utilization, expiry waste, cash requirement and future reseller demand. Switching commercial agreement requires human decision initially.

## MK Ativador supplier balance and catalog

MK can hold prepaid monetary balance used for app activations. `SupplierBalanceLedger` records top-ups and debits. Supplier catalog sync updates cost/license/activation metadata without silently changing our retail price.

Observed 2026-09-22 catalog snapshot: 175 apps; 48 annual at R$15, 124 annual at R$20, 2 annual at R$25 and one observed lifetime license (SET IPTV R$80). This is supplier snapshot, not immutable pricing.

Paid apps advertise/provide a 7-day free test. Procurement rule:

```text
recommend compatible app
→ configure free test
→ customer validates
→ Order + payment
→ reserve MK balance
→ purchase/activate license
→ verify postcondition
```

Never buy a paid app merely because it was recommended.

## Residual Access

Residual access is individualized inventory, only when provider permits reassignment and no active subscription conflicts. Store actual remaining period/server/configuration/status and rotate/reconfigure credentials before a new allocation. It cannot be represented as a full monthly plan if fewer days remain.

Residual recovery is an economic workflow independent from refund authorization.

## Required calculations

```text
current balance / supplier balance
weighted average unit cost
burn rate
renewal + new-sale forecast
future reseller forecast
safety stock
days of inventory/reorder point
monthly batch utilization/expiry waste
MK app-demand forecast
residual recovery rate
forecast accuracy
```

## Known provider inactivity rule

Current operational information says a qualifying CINEVISION recharge must occur within roughly 45 days to avoid inactivity risk. Keep as provider configuration/evidence until contractually validated.

## Procurement authority

Progression: Recommend → Prepare/Approval → Auto only inside explicit budget/policy. Spending beyond pre-approved supplier balance/budget is not autonomous by default.

## Future reseller channel

LATER: credits may be sold to resellers as well as consumed by own customers. Inventory/forecast must therefore be compatible with a future reseller-credit ledger without implementing that module now.

## Acceptance

- recurring additional-connection COGS is attributable each cycle;
- Trial and Trust Renewal do not consume credits unless live evidence shows otherwise;
- expiring monthly batches cannot silently carry forward;
- MK purchase occurs only after test + customer payment;
- reservations prevent concurrent overspend;
- supplier balance/credit drift is reconciliable;
- residual inventory cannot merge with an active subscription when provider cannot do so.

## Auto-review result

Reviewed for ledger integrity, expiry semantics, human spend authority, source-of-truth separation and compatibility with future reseller demand.
