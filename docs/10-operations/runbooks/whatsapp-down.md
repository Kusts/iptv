# Runbook — WhatsApp gateway unavailable

> Status: Baseline  
> Scope: messaging outbound/inbound  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Detection

Use integration health, SLO/alert, reconciliation drift and operator reports. Confirm the failure is systemic before broad customer communication.

## Containment

Mark integration degraded/disconnected; stop repeated sends; preserve queued transactional/support work by policy; surface alternate channel/manual handling for urgent cases.

## Customer/operator communication

Communicate only verified impact and current workaround/status. Do not promise resolution time not supported by evidence.

## Recovery

Reconnect session/provider, dedupe inbound backlog, replay allowed outbound respecting current opt-out/control state and expiration.

## Verification

Confirm backlog, error rates and reconciliation drift return to acceptable state. Sample real/synthetic end-to-end operation before declaring recovered.

## Post-incident

Create/attach Incident/Problem, record timeline/root cause when known, add missing test/alert/runbook improvement and update Knowledge if a reusable verified procedure emerged.

## Auto-review result

Reviewed to avoid destructive replay and to preserve internal authoritative state during external outages.
