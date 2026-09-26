# Screen Spec — Settings & Integrations

> Status: Canonical UX baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — checked against domain/state authority.

## Purpose

Configure tenant safely without exposing secrets.

## Required content/behavior

- Integration health and last successful event.
- Secret values never re-rendered after save.
- Outbound/automation kill switches prominent.
- Role/autonomy settings show impact and risk.
- Provider and messaging validation must pass before enabling production actions.

## States

Every screen must define loading, empty, error, permission-denied and degraded-dependency behavior. Domain-specific statuses must come from canonical contracts/state machines.

## Acceptance UX gate

A reviewer must be able to trace every visible critical state/action to a domain rule, API contract or policy; no hidden business logic may exist only in the frontend.
