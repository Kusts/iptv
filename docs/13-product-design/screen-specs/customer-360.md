# Screen Spec — Customer 360

> Status: Canonical UX baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — checked against domain/state authority.

## Purpose

Primary cross-domain customer workspace.

## Required content/behavior

- Header: relationship state, subscription, expiry, health score, acquisition source.
- Quick actions only if allowed by state/RBAC/policy.
- Tabs: Overview, Conversations, Trial, Subscription, Billing, Support, Referral/Rewards, Provider, Activity.
- Profitability summary separates revenue from contribution margin.
- Provider state clearly labeled external/fulfillment rather than source of truth.

## States

Every screen must define loading, empty, error, permission-denied and degraded-dependency behavior. Domain-specific statuses must come from canonical contracts/state machines.

## Acceptance UX gate

A reviewer must be able to trace every visible critical state/action to a domain rule, API contract or policy; no hidden business logic may exist only in the frontend.
