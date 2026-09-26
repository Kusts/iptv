# Screen Spec — Referral & Rewards

> Status: Canonical UX baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — checked against domain/state authority.

## Purpose

Treat referral as measurable acquisition channel.

## Required content/behavior

- Referral funnel: ask → invite → trial → paid → qualified → reward.
- Referral CAC/LTV/ROI and reward liability.
- Customer reward wallet and Gift Pass state.
- Anti-abuse reviews separated from normal conversion.
- Winback/referral campaigns display economics before activation.

## States

Every screen must define loading, empty, error, permission-denied and degraded-dependency behavior. Domain-specific statuses must come from canonical contracts/state machines.

## Acceptance UX gate

A reviewer must be able to trace every visible critical state/action to a domain rule, API contract or policy; no hidden business logic may exist only in the frontend.
