# Admin Experience Philosophy

> Status: Canonical UX baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — aligned with operations/runbooks.

## Primary objective

An operator should answer three questions immediately:

1. What needs attention?
2. Why does it need attention?
3. What is the safest next action?

## Home pattern

The Overview should prioritize an **Attention Queue** above generic KPIs.

Examples:

- Human Reviews waiting;
- provider operations in `HUMAN_REQUIRED`;
- payment/fulfillment mismatches;
- low credit inventory;
- expiring subscriptions with failed contact;
- active incidents;
- high-risk churn accounts.

## Progressive disclosure

Start with decision context. Raw traces/evidence are one level deeper.

## Action design

Actions must expose:

- what will change;
- which system is authoritative;
- risk level;
- whether approval is required;
- expected postcondition;
- evidence/result after execution.

## Avoid

- dashboards made only of cards;
- hiding failure/retry semantics;
- green success toast before external postcondition;
- action buttons without state eligibility;
- mixing “recommendation” and “executed change” visually.

## Refinamentos de experiência administrativa v0.14

Every automated business capability must expose an understandable manual path where operationally safe. UI should show eligibility and provider restrictions instead of forcing the operator to memorize them (e.g. Trust Renewal disabled with reason; Additional Connection shows current expiration before confirmation).

Key operational surfaces: Saved Views/filters, My Queue, Scheduled Contacts, Notifications, AI Activity, Provider desired-vs-actual reconciliation, Import preview, Inventory coverage/expiry and Human Review.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — manual/automation parity checked.

