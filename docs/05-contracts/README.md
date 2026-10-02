# Contracts — v1.0

Canonical contract rules are in `docs/15-implementation-baseline/04-event-catalog.md` and `21-api-and-contract-blueprint.md`.

`openapi/openapi.yaml` and `asyncapi/asyncapi.yaml` are the **live contract**, implemented against the 46 canonical migrations and enforced on every CI run: `scripts/validate_docs.py` checks cross-references and registry alignment, and `tests/contracts/test_contracts.py` asserts ID/state/schema-version consistency. They are still not permission to introduce stale pre-v1.0 terminology — any change must reconcile the affected paths/events against the v1.0 domain, state, policy and capability registries and keep schema validation green.

Contract invariants:

- tenant scope is derived from authenticated effective context;
- external provider enums/payloads do not become domain contracts;
- idempotency/correlation conventions are explicit;
- commands express intent, events express past facts;
- Agent tools are semantic, narrower contracts that resolve to application commands;
- breaking event changes use explicit event-version evolution.
