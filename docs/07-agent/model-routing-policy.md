# Model Routing Policy

> Status: Canonical capability policy; concrete provider/model pins resolved per release  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked for risk, cost, fallback, privacy and no-model-as-authority constraints.

## Principle

Model selection is an execution optimization, not a source of authorization or business truth.

## Routing inputs

```text
task type
risk class
context size
latency target
cost budget
required modality/tool support
model/provider health
tenant policy where applicable
```

## Suggested tiers

- **fast/default** — routine classification, summarization, low-risk conversation;
- **reasoning** — ambiguous support/sales planning, complex synthesis;
- **specialized coding/research** — internal development workflows, not customer runtime unless explicitly designed;
- **fallback** — safe alternate provider/model when primary unavailable.

## High-risk actions

Changing model tier never increases authorization. High-risk tools still require deterministic policy/RBAC/risk approval/HITL as documented.

## Fallback

Fallback must preserve tool contract compatibility and safety. If no safe compatible fallback exists, degrade to deterministic flow/HITL.

## Cost controls

Track cost per run/conversation and impose token/tool/research budgets. Do not truncate required policy/business context merely to save cost.

## Release pinning

Every Agent Release records the effective model/provider/routing configuration. Silent provider/model changes are treated as release changes when behavior may materially differ.

## Auto-review result

Reviewed to separate intelligence routing from authority and to make model changes observable, testable and reversible.
