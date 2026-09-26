# EPIC-04 — Subscription & Entitlements

## Outcome

Transformar Order SETTLED em direitos comerciais recorrentes sem confundir entitlement com estado do provider.

## Stories

### SE-01 — Initial subscription creation

**Aceite:** Order SETTLED cria Subscription PENDING_ACTIVATION e Entitlements PENDING; não vira ACTIVE antes do fulfillment mínimo.

### SE-02 — Subscription cycle

**Aceite:** cada período possui cycle próprio, receita/custo base e renewal order reference.

### SE-03 — Recurring add-on

**Aceite:** `subscription_addons` aceita apenas add-on RECURRING; conexão adicional ativa reaparece em cada renewal.

### SE-04 — Add-on cycle economics

**Aceite:** em dois ciclos consecutivos de tela adicional existem dois `subscription_addon_cycle_charges`; reward pode zerar `revenue_minor` sem zerar `provider_cost_minor`.

### SE-05 — Entitlement projection

**Aceite:** SERVICE_ACCESS/CONNECTIONS/APP_LICENSE etc. têm lifecycle independente do ProviderOperation.

### SE-06 — Renewal / cancellation / trust renewal

**Aceite:** renewal usa novo Price Snapshot; cancel-at-period-end não corta acesso antes da data; Trust Renewal (+3d, ACTIVE, <=3d) não corrompe ledger nem simula pagamento. Legacy `GRACE` não é usado para essa capability.

## Epic Gate

Demo obrigatória: base + tela extra no ciclo 1 e novamente no ciclo 2, com COGS do provider nos dois ciclos.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — Epic acceptance corrected to validated Trust Renewal semantics.
