# Screen Spec — Human Review Queue & Detail

> Status: Canonical UX baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — checked against domain/state authority.

## Purpose

Make human intervention fast and evidence-rich.

## Required content/behavior

- Queue sorted by risk/SLA/business impact.
- Detail shows customer summary, problem, agent attempts, tool results, evidence and recommendation.
- Decision options are structured; free-text guidance is supplemental.
- Conversation control status visible separately.
- Resolution can propose candidate knowledge but cannot auto-verify it.

## States

Every screen must define loading, empty, error, permission-denied and degraded-dependency behavior. Domain-specific statuses must come from canonical contracts/state machines.

## Acceptance UX gate

A reviewer must be able to trace every visible critical state/action to a domain rule, API contract or policy; no hidden business logic may exist only in the frontend.
