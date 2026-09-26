# Release Management

> Status: Baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

Release artifacts include application build, migration set, config/feature flags, agent release, provider adapter revision and contracts.

Promotion requires automated gates, staging smoke/E2E and explicit status of blocked external tests. High-risk features can roll out by tenant/percentage with kill switch.

Production rollback must not assume schema downgrade; prefer compatible application rollback or forward fix. Agent/provider adapter rollback is versioned independently where possible.

## Auto-review result

Reviewed to align release units with database, agent and browser/provider risk rather than treating deploy as one opaque package.
