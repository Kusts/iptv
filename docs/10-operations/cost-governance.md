# Cost Governance & FinOps Baseline

> Status: Canonical MVP baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked against tenant metering, agent cost, provider COGS, profitability and budget controls.

## Goal

Track and control operational cost without allowing cost optimization to compromise correctness or customer safety.

## Cost dimensions

At minimum attribute where practical:

```text
tenant
customer
conversation
agent_run
workflow
provider_operation
campaign
subscription/order
```

## Metered technical costs

- LLM input/output/cache/tool costs;
- transcription;
- messaging provider usage;
- browser-worker compute/minutes;
- web research;
- storage;
- database/compute allocation;
- observability volume where material.

## Business COGS

Technical cost is separate from provider credits, app licenses, payment fees, referral rewards, discounts and other contribution-margin inputs.

## Guardrails

- per-run agent/tool budgets;
- loop/tool-call ceilings;
- tenant usage alerts;
- rate limits for expensive research/transcription;
- budget approval for growth actions;
- no automatic cost-saving fallback that bypasses security/policy or degrades authoritative validation.

## Cost anomaly

Detect abnormal increases by tenant/provider/model/tool and correlate with releases/incidents.

## Auto-review result

Reviewed to keep FinOps aligned with unit economics while preserving correctness as a higher-order constraint.
