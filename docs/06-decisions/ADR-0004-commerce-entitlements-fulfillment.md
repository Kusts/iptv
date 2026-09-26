# ADR-0004 — Separar Commerce, Entitlements e Fulfillment

- **Status:** Accepted
- **Data:** 2026-09-20

## Context

O Customer pode comprar um produto, adquirir direito de uso e ainda aguardar execução externa.

Misturar esses conceitos produz estados impossíveis, especialmente quando provider falha após Payment.

## Decision

Separar:

- Commerce: acordo econômico/Order;
- Entitlement: direito concedido;
- Fulfillment: execução externa verificada.

## Consequences

Permite representar corretamente:

```text
Order SETTLED
Entitlement ACTIVE/READY
Fulfillment PENDING
```

sem perder a verdade comercial.
