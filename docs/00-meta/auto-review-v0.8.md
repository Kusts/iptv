# Auto-review v0.8

> Data: 2026-09-20  
> Escopo: migrations 004–008, migration docs, MVP Epics/Stories, backlog e validator.

## 1. Arquivos revisados

### Novas migrations

- 004 Catalog/Commerce;
- 005 Billing/Finance;
- 006 Subscription/Entitlements;
- 007 Provider Fulfillment;
- 008 Inventory/Procurement.

### Novos documentos

- migration batch v0.8;
- runtime test plan v0.8;
- Epics 00–08;
- MVP Backlog Matrix.

### Alterados

- README;
- CHANGELOG;
- Logical Data Model;
- Physical Database Schema;
- Migration README;
- MVP Implementation Sequence;
- static validator.

## 2. Findings encontrados e corrigidos

### F-01 — FinancialTransaction sem entries poderia existir

A primeira versão validava balanceamento apenas quando LedgerEntries existiam. Uma FinancialTransaction sem lançamentos não dispararia esse check.

**Correção:** `financial_transaction_complete_at_commit`, deferred constraint trigger exigindo no mínimo dois entries no commit.

### F-02 — Currency da entry não estava ligada à FinancialAccount

**Correção:** FK composta `(tenant_id, financial_account_id, currency)` → FinancialAccount.

### F-03 — Supplier global/tenant-specific estava ambíguo

O Logical Data Model permitia `supplier.tenant_id nullable`, mas SupplierOffer usa ownership tenant-scoped. Isso criava uma modelagem que permitiria Supplier global no catálogo mas não conseguiria referenciá-lo corretamente pela FK composta.

**Correção:** Supplier é tenant-scoped no MVP. Catálogo global, se necessário, será conceito separado no futuro.

### F-04 — Recurring add-on precisava de enforcement físico

**Correção:** trigger impede `subscription_addons` apontar para Catalog AddOn `ONE_TIME`.

### F-05 — COGS de tela adicional precisava permanecer visível quando reward zera preço

**Correção:** `subscription_addon_cycle_charges` exige `provider_cost_minor` por ciclo e permite `revenue_minor = 0`.

### F-06 — Provider credit precisava de trilha independente

**Correção:** append-only `provider_credit_entries`, idempotency key e referências a Cycle/AddOn/ProviderOperation.

## 3. Validações automatizadas

O validator v0.8 verifica:

- Markdown links;
- SPEC events contra Event Model;
- OpenAPI local `$ref`;
- AsyncAPI events contra Event Model;
- migrations com BEGIN/COMMIT e parênteses balanceados;
- sequência numérica das migrations;
- duplicate CREATE TABLE;
- FK target tables presentes;
- lifecycle states críticos contra listas canônicas;
- presença dos invariantes físicos de Trial, recurring add-on, financial ledger e provider credit ledger.

## 4. Invariantes rechecados

- uma Person tem no máximo um `TRIAL` primário;
- RETRIAL continua sendo exceção explícita;
- Order `SETTLED` continua diferente de Payment `PAID`;
- Order net=0 não requer Payment fictício;
- conexão/tela adicional é recorrente;
- conexão adicional ativa gera economia por ciclo;
- reward pode zerar preço mas não custo real;
- Financial Ledger é append-only e double-entry;
- ProviderOperation usa `SUCCEEDED`, não `SUCCESS`;
- provider execution permanece separada de Entitlement truth;
- provider credit consumption é append-only e idempotente.

## 5. Limitação atual

PostgreSQL, Docker e Podman não estão disponíveis no ambiente atual. Por isso, as migrations 001–008 ainda **não foram executadas contra PostgreSQL real**.

O gate obrigatório está especificado em [`../03-architecture/migrations/runtime-test-plan-v0.8.md`](../03-architecture/migrations/runtime-test-plan-v0.8.md).

## 6. Resultado

A v0.8 está semanticamente e estaticamente consistente para seguir à implementação/testes de runtime, sem promover o schema para `runtime-tested` prematuramente.
