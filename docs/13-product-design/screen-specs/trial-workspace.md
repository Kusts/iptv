# Screen Spec — Trial Workspace

> Status: Canonical UX baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — checked against domain/state authority.

## Purpose

Manage eligibility, provisioning and technical qualification without enabling abuse.

## Required content/behavior

- Eligibility result with reason and historical primary Trial.
- Retrial action hidden unless exception path is available.
- Device/app/ISP/server context.
- Technical checklist and attempts/outcomes.
- Trial access state separated from technical assessment PASSED/FAILED.
- Conversion CTA enabled after appropriate technical state.

## States

Every screen must define loading, empty, error, permission-denied and degraded-dependency behavior. Domain-specific statuses must come from canonical contracts/state machines.

## Acceptance UX gate

A reviewer must be able to trace every visible critical state/action to a domain rule, API contract or policy; no hidden business logic may exist only in the frontend.
