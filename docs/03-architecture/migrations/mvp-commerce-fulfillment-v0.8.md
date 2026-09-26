# MVP Commerce → Fulfillment — Migration Batch v0.8

> Status: Draft auto-revisado  
> Versão: 0.8  
> Data: 2026-09-20

## 1. Objetivo

Materializar a próxima parte do fluxo crítico do MVP:

```text
Lead / Trial
→ Catalog / Offer
→ Order
→ Payment
→ Financial Ledger
→ Subscription
→ Entitlements
→ Provider Fulfillment
→ Provider Credit Inventory
```

Este batch não substitui as SPECs; ele implementa o baseline físico necessário para começar o runtime.

## 2. Migrations incluídas

### 004 — Catalog & Commerce

Cria:

- `catalog.products`;
- `catalog.plans`;
- `catalog.addons`;
- `catalog.prices`;
- `catalog.offers` / `offer_items`;
- `catalog.coupons` / `coupon_redemptions`;
- `commerce.orders`;
- `commerce.order_items`;
- `commerce.price_snapshots`.

Invariantes relevantes:

- Order usa estados canônicos do domínio;
- `net_amount_minor = gross - discount - reward`;
- `SETTLED` não implica Payment externo;
- Price Snapshot é histórico e não depende do preço atual;
- item recorrente é distinguido de item one-time.

### 005 — Billing & Financial Ledger

Cria:

- `billing.payments`;
- provider bindings/attempts;
- `billing.refunds`;
- financial accounts;
- financial transactions;
- immutable ledger entries;
- cost allocations.

O ledger usa double-entry e possui constraint triggers deferidas para exigir no commit que cada transação tenha ao menos dois lançamentos e que débitos/créditos fechem por moeda. A moeda de cada entry também deve coincidir com a moeda da FinancialAccount.

`financial_transactions` e `financial_ledger_entries` são append-only.

### 006 — Subscription & Entitlements

Cria:

- Subscription;
- SubscriptionCycle;
- recurring SubscriptionAddOn;
- SubscriptionAddOnCycleCharge;
- Entitlement;
- EntitlementGrant.

A tabela `subscription_addon_cycle_charges` é deliberadamente explícita para evitar o erro conceitual de tratar conexão adicional como custo único.

```text
Conexão adicional ativa
→ 1 registro por ciclo aplicável
→ revenue_minor do ciclo
→ provider_cost_minor do ciclo
```

Se a conexão for grátis por reward:

```text
revenue_minor = 0
provider_cost_minor >= 0
```

quando existir custo real do provider.

`subscription_addons` só pode apontar para `catalog.addons.billing_type = RECURRING`.

### 007 — Provider Fulfillment

Cria:

- provider catalog;
- tenant provider accounts;
- external bindings;
- ProviderOperation;
- attempts;
- evidence;
- health snapshots.

Também fecha as FKs tenant-safe que estavam deliberadamente pendentes em `trial.trials`.

ProviderOperation usa exatamente:

```text
REQUESTED
QUEUED
RUNNING
VERIFYING
RETRY_WAIT
HUMAN_REQUIRED
SUCCEEDED
FAILED
CANCELLED
```

### 008 — Inventory & Procurement

Cria:

- suppliers tenant-scoped;
- supplier offers;
- provider credit batches;
- append-only provider credit entries.

O consumo de créditos pode apontar para:

- SubscriptionCycle;
- SubscriptionAddOn;
- ProviderOperation.

Isso permite atribuir COGS recorrente de uma tela adicional ao ciclo correto.

## 3. Ordem obrigatória

```text
001 Platform
002 Identity/CRM
003 Trial
004 Catalog/Commerce
005 Billing/Finance
006 Subscription/Entitlements
007 Provider Fulfillment
008 Inventory/Procurement
```

## 4. Gaps deliberados

Ainda não existem migrations físicas para:

- communications;
- support/HITL;
- knowledge;
- referral/reward wallets;
- analytics projections;
- growth/content;
- experiments;
- privacy request operational tables.

Isso é intencional e segue a ordem do MVP.

## 5. Gate de runtime

As migrations deste batch foram revisadas estaticamente, mas **não são consideradas runtime-tested** até serem aplicadas em PostgreSQL real e passarem por:

1. empty database bootstrap;
2. transaction rollback test;
3. financial ledger balanced/unbalanced cases;
4. duplicate webhook/idempotency test;
5. recurring add-on two-cycle test;
6. cross-tenant FK denial;
7. provider operation idempotency test;
8. Trial → Order → Subscription fixture.

## 6. Auto-revisão aplicada

Foram revisados:

- estados contra state machines;
- relações contra Logical Data Model;
- tenant-aware FKs;
- append-only ledgers;
- Price Snapshot history;
- Order SETTLED sem Payment obrigatório;
- recorrência de conexão adicional;
- ProviderOperation SUCCEEDED somente como estado canônico de conclusão.
