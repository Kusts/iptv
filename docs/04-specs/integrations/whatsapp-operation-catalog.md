# WhatsApp Gateway Semantic Operation Catalog

> Status: Provider-agnostic canonical catalog; concrete provider/version pending selection  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked to separate semantic messaging from unofficial-provider-specific contracts and risk.

## Required semantic capabilities

```text
sendText
sendMedia
sendDocument
markRead (optional)
receiveInbound
receiveDeliveryUpdate
resolveContactMetadata (optional)
getSessionHealth
reconnectSession / requestRecovery
```

## Message authority

Our `Message` record is authoritative for intent/content/history. Provider delivery receipts update delivery state; they do not own conversation/customer identity.

## Idempotency

Outbound messages require an internal message ID/idempotency strategy so workflow retries do not produce duplicate sends when provider semantics allow dedupe/reconciliation.

## Session health

Normalize provider-specific states into a small internal health model such as:

```text
HEALTHY
DEGRADED
DISCONNECTED
REQUIRES_HUMAN
```

The concrete mapping is provider/version specific and remains unresolved until selection.

## Security/risk

Because the initial integration may use an unofficial API, treat session/auth breakage and upstream protocol changes as operational risks. No anti-ban/evasion logic is part of the platform design.

## Provider binding checklist

When the concrete gateway/version is selected, capture:

- base API/version;
- authentication;
- webhook signature/token model;
- inbound schema;
- send response/delivery IDs;
- retry/idempotency guarantees;
- session lifecycle;
- media limits;
- rate/throughput constraints;
- reconnect/manual intervention behavior.

## Auto-review result

Reviewed to keep the core replaceable and avoid hard-coding assumptions about an unofficial gateway before the exact provider/version is pinned.
