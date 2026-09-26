# EPIC-03 — Commerce, Billing & Ledger

## Outcome

Converter uma oferta em obrigação comercial auditável e liquidá-la sem confundir Order settlement, Payment e Ledger.

## Stories

### CB-01 — Catalog/Plan/Add-on/Price

**Aceite:** preços são versionados; add-on de conexão adicional é `RECURRING`; alteração de preço não muda histórico.

### CB-02 — Offer resolution

**Aceite:** Policy resolve preço/cupom/reward permitido; Agent não define desconto arbitrário.

### CB-03 — Order + Price Snapshot

**Aceite:** Order Items congelam preço/contexto; matemática gross-discount-reward=net é validada.

### CB-04 — Asaas Payment adapter

**Aceite:** criação de cobrança gera Payment; webhook entra pelo Inbox; duplicata não duplica efeitos.

### CB-05 — Financial Ledger

**Aceite:** Payment/discount/reward/provider cost geram transações balanceadas; transação desbalanceada falha no commit; ledger não aceita update/delete.

### CB-06 — Settlement Engine

**Aceite:** Order paga externamente pode SETTLE; Order net=0 por reward também pode SETTLE sem Payment fictício.

### CB-07 — Refund/Chargeback

**Aceite:** refund preserva pagamento original e gera reversões/workflows separados.

## Epic Gate

Demo: Offer → Order → Asaas → webhook → Ledger → SETTLED, mais cenário zero-value sem Payment.
