# Screen Spec — Tenant Onboarding

> Status: Canonical UX baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — checked against domain/state authority.

## Purpose

Guide setup through safe progressive activation.

## Required content/behavior

- Step status and prerequisites.
- Environment/test mode clearly labeled.
- Integration validation actions are non-destructive where possible.
- Go-live checklist requires critical gates.
- User can leave/re-enter without losing verified progress.

## States

Every screen must define loading, empty, error, permission-denied and degraded-dependency behavior. Domain-specific statuses must come from canonical contracts/state machines.

## Acceptance UX gate

A reviewer must be able to trace every visible critical state/action to a domain rule, API contract or policy; no hidden business logic may exist only in the frontend.
