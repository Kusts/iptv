# Screen Spec — Provider Operations

> Status: Canonical UX baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — checked against domain/state authority.

## Purpose

Operate external fulfillment safely and visibly.

## Required content/behavior

- Provider/server health.
- Operation queue with PENDING/RUNNING/RETRYING/HUMAN_REQUIRED/SUCCEEDED/FAILED.
- Before/after evidence and browser trace link.
- Unknown-effect operations block blind retry.
- Adapter revision and drift status visible.

## States

Every screen must define loading, empty, error, permission-denied and degraded-dependency behavior. Domain-specific statuses must come from canonical contracts/state machines.

## Acceptance UX gate

A reviewer must be able to trace every visible critical state/action to a domain rule, API contract or policy; no hidden business logic may exist only in the frontend.
