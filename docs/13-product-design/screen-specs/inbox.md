# Screen Spec — Inbox

> Status: Canonical UX baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — checked against domain/state authority.

## Purpose

Operate conversations while preserving AI/human control and customer context.

## Required content/behavior

- Conversation list with channel, customer, lifecycle, SLA and control mode.
- Conversation pane with messages and tool-status summaries.
- Context rail: Person, Lead/Customer, Trial/Subscription, open Ticket, payment state.
- AI/Human takeover controls explicit and auditable.
- Outbound action respects Communication Policy and suppressions.

## States

Every screen must define loading, empty, error, permission-denied and degraded-dependency behavior. Domain-specific statuses must come from canonical contracts/state machines.

## Acceptance UX gate

A reviewer must be able to trace every visible critical state/action to a domain rule, API contract or policy; no hidden business logic may exist only in the frontend.
