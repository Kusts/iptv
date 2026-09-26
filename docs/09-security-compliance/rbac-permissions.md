# RBAC & Permission Matrix

> Status: Canonical baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Principle

Authentication proves identity; tenant membership establishes tenant context; permission checks authorize the specific action. Tenant isolation is not achieved by RBAC alone and must also exist in database/query boundaries.

## Initial roles

| Role | Purpose |
|---|---|
| OWNER | tenant ownership, billing/config/security-critical administration |
| ADMIN | broad operational administration except ownership-only actions |
| SALES | leads, Trial, offers/orders within policy |
| SUPPORT | conversations, tickets, allowed troubleshooting/HITL |
| FINANCE | payments, ledger views, reconciliation/refund workflow |
| OPERATIONS | provider operations, inventory, incidents |
| ANALYST | read analytics, limited operational PII |
| VIEWER | read-only permitted areas |

Roles are tenant-scoped.

## High-risk permissions

Use explicit permissions rather than role-name checks for actions such as:

```text
customer.merge
trial.override
payment.refund
reward.manual_grant
provider.delete/block
provider.change_connections
provider.trust_renewal
secrets.manage
agent.autonomy.change
ads.budget.change
```

## Approval rule

R3/R4 actions may require approval even if the actor has base permission, depending on policy/autonomy.

## Service identities

Workers/agents use service principals or equivalent scoped credentials with only required permissions. Browser Worker has no generic finance/admin permission.

## Break-glass

Emergency elevation, if implemented, requires short expiry, reason, strong authentication and audit. It is not a normal operational shortcut.

## Tests

Every protected resource needs allow/deny tests across tenant and role boundaries. Cross-tenant denial must not leak resource existence.

## Auto-review result

Reviewed to separate role convenience from explicit high-risk permission and to avoid treating successful login as authorization.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — provider permission renamed to Trust Renewal.
