# Runbook — HITL / Human Review Backlog

> Status: Operational baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked for customer safety, SLA triage and no autonomous bypass.

## Trigger

Human Review queue age/volume exceeds normal capacity or SLA target.

## Triage

Prioritize by:

1. customer access/payment impact;
2. financial/security risk;
3. waiting customer with active conversation;
4. provider ambiguity/destructive action;
5. routine knowledge/commercial guidance.

## Response

- pause or suppress automation that repeatedly generates the same invalid review;
- use incident/problem correlation for systemic causes;
- provide customer standby communication according to communication policy;
- never auto-approve high-risk actions merely to reduce queue size;
- capture reusable human guidance as Candidate Knowledge only after outcome evidence.

## Exit criteria

Queue age normalized, systemic source corrected, no unresolved high-severity review beyond target.

## Auto-review result

Reviewed to make human capacity a managed operational dependency without weakening safety gates.
