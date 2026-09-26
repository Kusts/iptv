# Architecture Overview — v1.0

Canonical architecture is defined by `docs/15-implementation-baseline/07-architecture-stack.md`.

High-level flow:

`Web/Channel/Event → Application Command/Query → Domain + Policy → Outbox/Workflow → Integration Adapter → Postcondition/Reconciliation → Events/Projections`.

Agent path:

`Trigger → Context Builder → Agent Harness → semantic tool → authorization/policy → same Application Command → verified outcome`.

Architecture style: multi-tenant modular monolith + isolated background/integration workers. PostgreSQL is authoritative. External systems are replaceable adapters.
