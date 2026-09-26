# SLO & Error Budget Baseline

> Status: Proposed for pilot calibration  
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

Define SLOs around user/business outcomes, not infrastructure vanity metrics. Initial SLIs: durable Asaas webhook acceptance, provider fulfillment success/latency, messaging delivery/connection health, AI processing latency, HITL acknowledgement and reconciliation backlog age.

Exact numeric targets are calibrated in staging/pilot and versioned. Breaching error budget reduces rollout/autonomy/change velocity for the affected capability until reliability recovers.

Every SLO has owner, measurement query, exclusions, alert policy and runbook.

## Auto-review result

Reviewed to avoid inventing arbitrary SLA numbers before pilot evidence exists.
