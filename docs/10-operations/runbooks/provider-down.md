# Runbook — Provider / CINEVISION unavailable or degraded

> Status: Baseline  
> Scope: provider/browser automation  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Detection

Use integration health, SLO/alert, reconciliation drift and operator reports. Confirm the failure is systemic before broad customer communication.

## Containment

Pause risky provider actions with kill switch; keep internal Orders/Payments/Entitlements authoritative; queue safe pending fulfillment; notify operators/customers only as appropriate.

## Customer/operator communication

Communicate only verified impact and current workaround/status. Do not promise resolution time not supported by evidence.

## Recovery

After provider recovery, observe external state before replaying each pending mutation; reconcile subscriptions/connections/credits; never blind-replay renewals.

## Verification

Confirm backlog, error rates and reconciliation drift return to acceptable state. Sample real/synthetic end-to-end operation before declaring recovered.

## Post-incident

Create/attach Incident/Problem, record timeline/root cause when known, add missing test/alert/runbook improvement and update Knowledge if a reusable verified procedure emerged.

## Auto-review result

Reviewed to avoid destructive replay and to preserve internal authoritative state during external outages.
