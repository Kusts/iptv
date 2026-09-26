# API & Error Conventions

> Status: Canonical MVP convention  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked for contract stability, security, idempotency, correlation and agent/tool consumption.

## API principles

- transport is not domain authority;
- APIs expose semantic resources/commands, not raw database tables;
- tenant is derived from authenticated context unless a control-plane endpoint explicitly requires tenant selection;
- mutating endpoints support idempotency where clients/providers can retry;
- all failures use a stable machine-readable error code.

## Error envelope

Recommended shape:

```json
{
  "error": {
    "code": "TRIAL_ALREADY_USED",
    "message": "Primary trial is not available for this person.",
    "category": "BUSINESS_RULE",
    "retryable": false,
    "correlationId": "...",
    "details": {}
  }
}
```

`message` is for operators/clients and must not expose secrets or internal stack traces.

## Error categories

- `VALIDATION` — malformed/missing input;
- `AUTHENTICATION` — caller identity missing/invalid;
- `AUTHORIZATION` — caller authenticated but not allowed;
- `BUSINESS_RULE` — domain precondition/transition denied;
- `CONFLICT` — idempotency/version/state conflict;
- `EXTERNAL_DEPENDENCY` — provider/gateway unavailable or rejected;
- `RATE_LIMIT` — quota/frequency control;
- `INTERNAL` — unexpected internal failure.

## HTTP mapping baseline

- 400 validation;
- 401 authentication;
- 403 authorization/policy;
- 404 resource not visible in caller tenant/context;
- 409 domain/idempotency/version conflict;
- 422 well-formed request rejected by business rule when clearer than 409;
- 429 rate limit;
- 502/503 dependency/system unavailable;
- 500 unexpected internal failure.

Exact mapping is secondary to stable `error.code` semantics.

## Retry semantics

Errors must explicitly indicate retryability. A timeout after an external mutation is **ambiguous**, not safe-to-retry by default. Provider workflows must verify postcondition before retry.

## Idempotency

For supported commands, duplicate idempotency keys with identical semantic request return the prior result. Reuse with conflicting input returns a conflict error.

## Correlation

Every response and error should expose/propagate a correlation ID usable across API, workflow, event, provider operation and agent traces.

## Agent/tool errors

Semantic tools consume typed domain outcomes. The LLM must not parse arbitrary stack traces to determine whether an action succeeded.

## Auto-review result

Reviewed to keep error semantics safe for humans, automation and LLM tools while preserving ambiguity for uncertain external side effects.
