# Webhook Ingress Conventions

> Status: Canonical integration baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked for authentication, at-least-once delivery, replay and tenant routing.

## Ingress pipeline

```text
HTTP receive
→ authenticate/verify provider
→ identify integration/tenant
→ minimally validate envelope
→ durable inbox/raw event persistence
→ respond according to provider contract
→ asynchronous normalization/processing
→ domain command/event
```

## Rules

- never perform slow provider/business work before durable acceptance when provider contract supports async processing;
- dedupe by provider event ID or stable derived key;
- raw payload retention follows data classification and should be minimized/redacted where possible;
- signature/token verification failure is rejected and audited without exposing verification secret;
- unknown event types are stored/observed according to policy but do not mutate domain state;
- event reprocessing is explicit and idempotent.

## Tenant routing

Tenant/integration context comes from the registered webhook endpoint/credential/integration mapping, never from trusting an arbitrary tenant ID inside the payload.

## Provider differences

Exact success status, retry behavior and signature/token scheme are provider-specific and belong in each integration SPEC.

## Auto-review result

Reviewed to prevent webhook retry storms, spoofing and duplicate domain side effects.
