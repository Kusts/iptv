# Low-Fidelity Wireframes

> Status: UX reference, not pixel specification
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — aligned with screen specs and navigation.

## Overview

```text
┌ Navigation ─────────┬─────────────────────────────────────────────┐
│ Home                │ Overview                 Search   Attention │
│ Inbox               ├─────────────────────────────────────────────┤
│ CRM                 │ NEEDS ATTENTION                              │
│ Trials              │ [3 Human Review] [2 Provider] [Low Credits] │
│ Subscriptions       ├─────────────────────────────────────────────┤
│ Support             │ Revenue  Renewal  Trial→Paid  Margin        │
│ Revenue             ├─────────────────────────────────────────────┤
│ Operations          │ Operational health / trends                 │
│ Intelligence        ├────────────────────────┬────────────────────┤
│ Growth              │ Renewal queue          │ Recent activity    │
│ Admin               │                        │                    │
└─────────────────────┴────────────────────────┴────────────────────┘
```

## Inbox

```text
┌ Conversation list ───┬ Conversation ───────────────┬ Context ──────┐
│ João • WhatsApp      │ Customer message            │ Customer      │
│ Ana • Instagram     │ Flow Assist                  │ Trial ACTIVE  │
│ Pedro • WhatsApp    │ [tool status: checking...]  │ Ticket OPEN   │
│ ...                  │ Human takeover banner       │ Payment —     │
│                      │                              │ Quick actions │
└──────────────────────┴──────────────────────────────┴───────────────┘
```

## Customer 360

```text
┌ João Silva | ACTIVE | Health 82 | Exp 20/10 | [Actions] ─────────┐
│ Acquisition | Plan | Server | Device | LTV | Contribution Margin │
├───────────────────────────────────────────────────────────────────┤
│ Overview | Conversations | Trial | Subscription | Billing | ...   │
├──────────────────────────────────────────────┬────────────────────┤
│ Main tab content                             │ Timeline/Evidence  │
│                                              │                    │
└──────────────────────────────────────────────┴────────────────────┘
```

## Human Review

```text
┌ Queue ────────────┬ Review detail ────────────────────────────────┐
│ P1 Payment drift  │ Why escalated                               │
│ P2 Support issue  │ Customer / current states                   │
│ P2 Browser drift  │ What AI tried + outcomes                    │
│                   │ Evidence                                    │
│                   │ Recommendation                              │
│                   │ [Approve action] [Guide] [Take over]        │
└───────────────────┴───────────────────────────────────────────────┘
```

## Provider Operation

```text
Operation: RENEW_CUSTOMER     Status: HUMAN_REQUIRED
Before evidence  →  attempts  →  external state  →  expected state
[Trace] [Screenshot] [Verify again] [Human decision]

WARNING: effect unknown. Retry is blocked until verification.
```

These wireframes define composition and priority only. Final component sizing comes from Design System and usability review.
