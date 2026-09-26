# Agent Tool Failure Taxonomy

> Status: Canonical agent-runtime baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked for no-fabricated-success, retry safety and policy separation.

## Typed outcomes

Semantic tools should normalize failures into categories the runtime can handle deterministically:

- `VALIDATION_FAILED`;
- `NOT_AUTHORIZED`;
- `POLICY_DENIED`;
- `RISK_REVIEW_REQUIRED`;
- `INVALID_STATE`;
- `DEPENDENCY_UNAVAILABLE`;
- `TIMEOUT_NO_SIDE_EFFECT`;
- `TIMEOUT_EFFECT_UNKNOWN`;
- `POSTCONDITION_FAILED`;
- `HUMAN_REQUIRED`;
- `INTERNAL_FAILURE`.

## Runtime behavior

`TIMEOUT_EFFECT_UNKNOWN` is never translated into “failed, retry immediately.” The workflow first verifies external state/postcondition.

Policy/risk/authorization denial is not retried by the LLM with different wording.

## Conversation response

The agent receives a safe structured explanation suitable for next-step reasoning, not raw provider stack traces/secrets.

## Observability

Record tool name/version, run ID, typed outcome, latency, retry count and provider operation correlation where relevant.

## Auto-review result

Reviewed to make tool failure handling deterministic and resistant to LLM improvisation.
