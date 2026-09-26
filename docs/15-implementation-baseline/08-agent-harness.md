# Agent Harness — Final Contract

## Decision

**Primary harness: OpenAI Agents SDK for TypeScript**, wrapped behind our own `AgentHarnessPort`.

The SDK is the execution harness, not the product architecture. Domain state, policies, tools, memory, workflows and authorization remain platform-owned.

## Runtime architecture

`Trigger/Message → Task classification → Context Builder → Capability/Skill selection → Model Router → Primary Agent → Specialist(s) → Tool proposal → Authorization/Policy → Semantic Tool → Domain Command/Workflow → Postcondition → Result → Memory/Learning/Eval`

## Roles

External experience remains one coherent persona while runtime may use:

- Primary Agent;
- Commercial Specialist;
- Technical Support Specialist;
- Billing Specialist;
- Provider Operations Specialist;
- Knowledge/Research Specialist;
- Finance Specialist;
- Growth/Retention Specialist.

Default delegation pattern is **Primary → Specialist-as-tool → Primary**. Arbitrary recursive specialist chains are forbidden. Handoff is reserved for cases where control genuinely needs to transfer.

## Four product-facing profiles

- Customer Agent;
- Tenant Copilot;
- Platform Support Agent;
- Engineering Copilot.

Profiles may share runtime code but not unrestricted context/permissions.

## Memory/context

**Long-lived relationship, short-lived model context.** Authoritative data lives in domain stores; memory and knowledge are fetched by a Context Builder. SDK sessions may assist an active run but are not business memory.

Context precedence: authoritative DB/provider-verified facts > structured current state > verified knowledge > recent messages > summaries/inferences.

Context epochs reset/rebuild on topic change, resolution, takeover, inconsistency or context budget pressure.

## HITL and workflows

Sensitive tool interruption may serialize `RunState`; Hatchet owns the durable waiting process and `HumanReviewRequest`. On resume, permissions, policy and resource state are revalidated.

## Guardrails and autonomy

Guardrails must be capability-scoped. A warning or failed capability should degrade only the affected action whenever possible. Refund execution remains always human-required.

## Harness benchmark gate

Before automatic customer operation, compare minimal model/tool-loop baseline against the Synkroo harness using business-weighted evals:

- Task success;
- policy compliance;
- correct tool selection and arguments;
- delegation accuracy;
- recovery/abstention quality;
- hallucinated action rate;
- unnecessary tool calls;
- context efficiency;
- latency and model cost.

Critical invariant suites (cross-tenant, refund, provider constraints, financial duplication) require 100% pass in the deterministic/eval fixtures used for release gating.

## Release pipeline

`AgentRelease → offline evals → shadow → canary → production`.

Model changes run the same benchmark because tool/prompt behavior may change across models.
