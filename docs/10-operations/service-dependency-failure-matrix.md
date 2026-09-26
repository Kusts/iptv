# Service Dependency & Failure Matrix

> Status: Canonical operational baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked for graceful degradation, queue preservation, fail-open/fail-closed behavior and customer impact.

| Dependency | Example impact | System behavior | Mutations | Recovery path |
|---|---|---|---|---|
| PostgreSQL | authoritative state unavailable | reject authoritative writes; serve only safe cached/static views if designed | fail closed | DB runbook/restore/failover |
| Workflow runtime | delayed async processing | persist durable intent/outbox; surface backlog | no unsafe synchronous substitute | drain after recovery |
| Asaas | charges/status unavailable | preserve Orders; billing operations pending | no fabricated payment | reconciliation/webhook/API recovery |
| CINEVISION | fulfillment unavailable | payment/order remain authoritative; provider op pending | no assumed success | retry/postcondition/HITL |
| WhatsApp gateway | messaging unavailable | queue/suppress according to expiry policy | business state continues | reconnect/retry/alternate channel if allowed |
| LLM provider | AI unavailable | deterministic flows + HITL | high-risk AI actions disabled | fallback model or human |
| Knowledge retrieval | support context unavailable | answer only safe deterministic facts or escalate | no invented solution | restore retrieval/index |
| Secrets manager | credentials unavailable | existing short-lived leases may continue if safe; new protected actions blocked | fail closed | restore secrets access |
| Object storage | evidence/attachment unavailable | core state preserved; evidence operations degraded | avoid losing required audit evidence | retry/storage runbook |

## Principle

Customer/business truth must not be rolled back merely because an external side effect is delayed. Instead represent pending/degraded fulfillment explicitly.

## Auto-review result

Reviewed to prevent dependency outages from creating false success, duplicate side effects or loss of authoritative business state.
