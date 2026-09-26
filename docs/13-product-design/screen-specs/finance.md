# Screen Spec — Finance & Unit Economics

> Status: Canonical UX baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — checked against domain/state authority.

## Purpose

Explain where money comes from and where margin goes.

## Required content/behavior

- Revenue, COGS, payment fees, acquisition, rewards, AI/messaging/infra allocations.
- Contribution margin by customer/plan/channel/cohort.
- Cash vs recognized managerial revenue clearly separated.
- Additional connection revenue and recurring provider COGS visible per cycle.
- Ledger drilldown available from summarized numbers.

## States

Every screen must define loading, empty, error, permission-denied and degraded-dependency behavior. Domain-specific statuses must come from canonical contracts/state machines.

## Acceptance UX gate

A reviewer must be able to trace every visible critical state/action to a domain rule, API contract or policy; no hidden business logic may exist only in the frontend.
