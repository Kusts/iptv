# Repository & Module Boundaries

> Status: Canonical repository baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked against modular-monolith, worker isolation and bounded-context ownership.

## Recommended repository shape

```text
apps/
├ web/
├ api/
├ worker/
└ browser-worker/

packages/
├ domain-*/
├ database/
├ events/
├ policy/
├ observability/
├ integrations-*/
└ test-support/
```

The exact package names can evolve; ownership rules cannot.

## Ownership

A module owns:

- its domain rules;
- its authoritative tables/write paths;
- commands/queries exposed to other modules;
- domain events it emits;
- migrations affecting its owned schema, coordinated with shared DB policy.

## Forbidden coupling

- module A updating module B’s tables directly;
- UI writing database state directly;
- agent/browser/provider adapter bypassing application/domain commands;
- provider SDK types becoming canonical domain types;
- shared “utils” package accumulating business logic with no owner.

## Shared packages

Only genuinely cross-cutting primitives belong in shared packages: IDs, result/error envelopes, time abstractions, observability context, event envelope, testing helpers.

Do not centralize domain-specific concepts merely to reduce imports.

## Browser Worker

Browser Worker is process/container isolated from the main API. It receives semantic provider operations, not arbitrary browsing prompts, and has no broad database ownership.

## Background Worker

Background workflows call the same application/domain commands as synchronous paths; they do not implement duplicate business logic.

## Auto-review result

Reviewed to prevent the modular monolith from degrading into shared-table coupling and to preserve future extractability without premature microservices.
