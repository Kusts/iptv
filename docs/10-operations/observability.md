# Observability Specification

> Status: Canonical MVP baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Goals

Make customer-impacting flows traceable across API, workflow, external adapter, ledger and agent without leaking secrets or unnecessary PII.

## Correlation model

Use/carry:

```text
request_id
correlation_id
causation_id
workflow_id
agent_run_id
tool_execution_id
provider_operation_id
tenant_id
```

## Signals

### Logs

Structured, severity-based, tenant-aware. Do not log secret values, browser auth artifacts or full message bodies by default.

### Metrics

Minimum operational groups:

- API latency/error;
- webhook ingest and backlog;
- outbox/inbox lag;
- workflow retry/dead-letter;
- provider operation success/latency/challenge;
- messaging delivery/connection health;
- agent/tool latency/cost/policy denies;
- reconciliation drift;
- database saturation/migration health.

### Traces

Trace critical end-to-end flows such as payment→settlement→subscription→fulfillment and message→agent→tool→domain command. Browser traces are separate sensitive evidence with stricter access.

## SLO candidates

Initial exact targets are pilot-configurable, but SLIs must exist for:

- durable webhook acceptance;
- provider fulfillment completion;
- outbound message handoff/delivery where observable;
- AI first-response processing;
- HITL acknowledgement;
- reconciliation backlog.

## Alert rule

Every alert requires owner, severity, condition, customer impact, link to runbook and clear resolution/acknowledgement path.

## Auto-review result

Reviewed to align technical telemetry with business flows and Data Classification requirements.
