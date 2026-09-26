# Runbook — AI/model runtime unavailable

> Status: Baseline  
> Scope: agent runtime  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Detection

Use integration health, SLO/alert, reconciliation drift and operator reports. Confirm the failure is systemic before broad customer communication.

## Containment

Disable autonomous AI outbound; deterministic billing/provider workflows continue; route urgent conversations to human/control-center queues; do not fake model responses.

## Customer/operator communication

Communicate only verified impact and current workaround/status. Do not promise resolution time not supported by evidence.

## Recovery

Validate model/tool runtime, restore bounded traffic, then release queued conversations only after current context/control state is re-read.

## Verification

Confirm backlog, error rates and reconciliation drift return to acceptable state. Sample real/synthetic end-to-end operation before declaring recovered.

## Post-incident

Create/attach Incident/Problem, record timeline/root cause when known, add missing test/alert/runbook improvement and update Knowledge if a reusable verified procedure emerged.

## Auto-review result

Reviewed to avoid destructive replay and to preserve internal authoritative state during external outages.
