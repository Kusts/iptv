# ADR-0020 — OpenAI Agents SDK TypeScript as Agent Harness

- Status: **SUPERSEDED** by ADR-0026 (direction-level: SDK-primary dropped; SDK remains a future alternative with a benchmark adoption criterion)
- Historical decision: use OpenAI Agents SDK TypeScript behind an owned `AgentHarnessPort` for agent loop, specialists-as-tools/handoffs, guardrails, HITL `RunState` and tracing.
- Decision: use OpenAI Agents SDK TypeScript behind an owned `AgentHarnessPort` for agent loop, specialists-as-tools/handoffs, guardrails, HITL `RunState` and tracing.
- Non-delegated authority: Context Builder, Policy Engine, Tool/Capability Registry, Model Gateway, Memory/Knowledge, AgentRelease, business commands and durable workflows remain platform-owned.
- Requirement: Wave 0 benchmark must demonstrate reliability and operational fit; the abstraction permits harness replacement without rewriting domain modules.
