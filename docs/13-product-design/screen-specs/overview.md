# Screen Spec — Overview / Home

> Status: Canonical UX baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — checked against domain/state authority.

## Purpose

Surface what needs attention before showing generic reporting.

## Required content/behavior

- Attention Queue with Human Reviews, provider failures, mismatches, incidents, low inventory and renewal risk.
- Core business KPIs with comparison period.
- Operational health strip: messaging, billing, provider, workflows, AI.
- Recent high-impact activity.
- No action may be triggered solely from a chart without opening relevant context.

## States

Every screen must define loading, empty, error, permission-denied and degraded-dependency behavior. Domain-specific statuses must come from canonical contracts/state machines.

## Acceptance UX gate

A reviewer must be able to trace every visible critical state/action to a domain rule, API contract or policy; no hidden business logic may exist only in the frontend.
