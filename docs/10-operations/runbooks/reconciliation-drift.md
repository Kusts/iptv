# Runbook — Reconciliation Drift

> Status: Operational baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked for internal authority, repair policy and external evidence.

## Trigger

Mismatch between internal authoritative expectation and external provider/gateway observation.

Examples:

- Charge internal pending but Asaas reports paid; reconcile before creating/confirming Payment;
- Subscription active but provider expired;
- expected connections differ from provider;
- provider operation marked uncertain.

## Procedure

1. identify which side is authoritative for the specific fact;
2. gather external snapshot/evidence;
3. classify mismatch as stale read, missed event, failed fulfillment, duplicate, manual provider change or unknown;
4. execute documented auto-repair only when deterministic and safe;
5. otherwise create Human Review;
6. record repair event/audit and verify postcondition.

## Rule

Reconciliation may correct synchronization but must not silently rewrite commercial truth solely to match provider state.

## Auto-review result

Reviewed to preserve source-of-truth boundaries while enabling safe repair.
