# API Versioning & Compatibility

> Status: Canonical contract baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked against OpenAPI authority, internal/external consumers and migration safety.

## Principle

Prefer compatible evolution. Introduce a new major API contract only when meaning/shape cannot be safely evolved.

## Compatible changes

Typically compatible when clients tolerate them:

- add optional response fields;
- add new endpoints;
- add optional request fields with stable defaults;
- add new enum values only when consumers are explicitly written to handle unknown values; otherwise treat as breaking.

## Breaking changes

- removing/renaming fields or endpoints;
- changing field meaning/type;
- changing requiredness without compatibility plan;
- changing command semantics/idempotency;
- reusing an error code for a different condition.

## Internal does not mean disposable

Even internal clients (Control Center, agent tools, workers) are contracts. Breaking them casually creates hidden coupling and unsafe deploy ordering.

## Deprecation

Document deprecated surface, replacement, migration owner and removal condition/date. Observe usage before removal when possible.

## Auto-review result

Reviewed to make API evolution explicit rather than relying on synchronized deploy luck.
