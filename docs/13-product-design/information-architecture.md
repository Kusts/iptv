# Control Center Information Architecture

> Status: Canonical UX baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — mapped against Domain Map and existing dashboard catalog.

## Principle

Navigation must follow operator intent, not database tables.

Primary mental model:

`Work → Revenue → Operations → Intelligence → Growth → Admin`.

## Areas

### Home

- Overview
- Attention Queue
- Business health

### Work

- Inbox
- CRM
- Trials
- Subscriptions
- Support

### Revenue

- Orders
- Billing
- Catalog
- Finance
- Inventory

### Operations

- Provider Operations
- Incidents
- Human Reviews
- Automations
- Reconciliation

### Intelligence

- Knowledge
- Agent
- Analytics
- Experiments

### Growth

- Referrals
- Campaigns
- Content
- Audiences

### Admin

- Integrations
- Users & Roles
- Tenant Settings
- Feature/Autonomy Controls
- Audit

## Cross-cutting entry points

Global search must find Person, Customer, Lead, Trial, Order, Subscription, Ticket and ProviderOperation.

Global command/quick action can expose only actions allowed by current role/policy.

## Customer 360

Customer 360 is the primary cross-domain workspace. It is not a dumping ground; information is grouped by relationship, service, money, support and activity.
