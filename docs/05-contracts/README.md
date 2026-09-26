# Contracts — v1.0

Canonical contract rules are in `docs/15-implementation-baseline/04-event-catalog.md` and `21-api-and-contract-blueprint.md`.

`openapi/openapi.yaml` and `asyncapi/asyncapi.yaml` are **pre-implementation scaffolds**, not permission to implement stale pre-v1.0 terminology. Each implementation Wave must reconcile/generate the relevant paths/events against the v1.0 domain, state, policy and capability registries and run schema validation.

Contract invariants:

- tenant scope is derived from authenticated effective context;
- external provider enums/payloads do not become domain contracts;
- idempotency/correlation conventions are explicit;
- commands express intent, events express past facts;
- Agent tools are semantic, narrower contracts that resolve to application commands;
- breaking event changes use explicit event-version evolution.
