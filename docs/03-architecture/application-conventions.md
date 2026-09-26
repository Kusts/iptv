# Application Conventions

> Status: Canonical implementation baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked against modular-monolith, ports/adapters, event, tenancy and testing principles.

## Goal

Make implementation predictable across modules and agents without turning style choices into business rules.

## Module shape

Recommended internal shape per bounded module:

```text
module/
├ domain/          # entities/value objects/domain rules
├ application/     # commands, queries, orchestration
├ ports/           # interfaces required by the module
├ infrastructure/  # adapter implementations owned by module
├ api/             # transport mapping only
└ tests/
```

Not every module needs every folder. Avoid empty architecture ceremony.

## Dependency direction

```text
API / Worker / Adapter
        ↓
Application
        ↓
Domain
```

Domain must not import HTTP, browser, messaging, billing provider, ORM/database client or LLM SDK concerns.

Cross-module access should use application services/ports/events, not direct mutation of another module’s tables.

## Commands and queries

Commands mutate state and must define:

- actor/tenant context;
- idempotency expectation where externally retryable;
- authorization/policy preconditions;
- expected domain transition;
- emitted events;
- typed outcome/error.

Queries never mutate state and must still enforce tenant scope and authorization.

## Transactions

One transactional boundary should protect one authoritative business mutation plus its outbox/event record where required.

Do not keep database transactions open across network calls, browser operations or LLM calls.

## Time and money

- store timestamps in UTC; convert only at presentation/business-calendar boundaries;
- inject/test time for rules involving expiry, quiet hours and cooldowns;
- monetary values use integer minor units or exact decimal where the domain requires it;
- never use floating point for authoritative money.

## IDs

Use opaque stable IDs. External provider IDs are stored separately and never reused as internal primary keys.

## Tenant context

Every tenant-owned command/query must receive tenant context explicitly or derive it from authenticated execution context. Background jobs/events must carry tenant identity.

## External adapters

Adapters translate between external contracts and semantic ports. Raw provider payloads may be preserved for evidence/audit but must not leak into domain types.

## No hidden side effects

Creating an Order does not silently send a message or call the provider unless the documented workflow explicitly owns those effects.

## Auto-review result

Reviewed to keep domain authority independent of framework/provider details and to make implementation patterns consistent without over-engineering the MVP.
