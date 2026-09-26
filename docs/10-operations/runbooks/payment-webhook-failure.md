# Runbook — Asaas webhook failures or queue drift

> Status: Baseline  
> Scope: billing webhook  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Detection

Use integration health, SLO/alert, reconciliation drift and operator reports. Confirm the failure is systemic before broad customer communication.

## Containment

Keep receiver durable; if authentication/processing broken, activate alert and stop unsafe settlement assumptions. Use reconciliation/polling only through billing adapter.

## Customer/operator communication

Communicate only verified impact and current workaround/status. Do not promise resolution time not supported by evidence.

## Recovery

Fix receiver/queue, replay stored inbox events idempotently, reconcile Asaas vs internal Payment/Order/Ledger and investigate missed side effects.

## Verification

Confirm backlog, error rates and reconciliation drift return to acceptable state. Sample real/synthetic end-to-end operation before declaring recovered.

## Post-incident

Create/attach Incident/Problem, record timeline/root cause when known, add missing test/alert/runbook improvement and update Knowledge if a reusable verified procedure emerged.

## Auto-review result

Reviewed to avoid destructive replay and to preserve internal authoritative state during external outages.
