# Agent Runtime Documentation — v1.0

Canonical cross-domain Agent contract: `docs/15-implementation-baseline/08-agent-harness.md`.

Supporting files in this directory define context engineering, memory, policies, tools, evals, routing and release governance. Where older implementation suggestions conflict with the v1.0 harness decision, the v1.0 baseline and ADR-0020/0023 are authoritative.

Core path:

`Context → Primary/Specialist harness → semantic capability/tool → Authorization/Policy → Application Command/Workflow → postcondition → result/eval`.

The Agent never owns durable business state, credentials, tenant authorization or provider browser details.
