# WhatsApp Gateway Semantic Operation Catalog

> Status: WAHA/GOWS binding; media/audio path software-verified (not certified)
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

Current binding (software implementation; operator certification remains separate):

- `sendMedia` and `sendDocument`: IMPLEMENTED; outbound attachments are validated and resolved from tenant-scoped server-side storage before WAHA send.
- `receiveInbound` (media/audio): IMPLEMENTED; webhook media is fetched, validated and persisted tenant-scoped with an opaque attachment reference.
- Audio transcription: IMPLEMENTED via Groq STT (`whisper-large-v3-turbo`); pending inbound transcription is drained by the scheduler.
- Attachment readback: IMPLEMENTED via `GET /v1/communications/attachments/:ref` for outbound and inbound bytes, tenant-scoped.
- Media limits: enforced in software against actual bytes, MIME allowlist and content sniffing (outbound upload caps 8/16/16/32 MiB by media class; inbound validation also applies byte/MIME checks).
- Retries/idempotency: internal message/idempotency handling and bounded queue/reconciliation behavior are implemented; provider delivery/retry guarantees remain provider-specific.
- Session/media binding: WAHA session and media fetching are wired; exact provider/version behavior and operational recovery remain subject to operator validation.
- Rate/throughput constraints and reconnect/manual intervention: operational/provider-specific constraints still require confirmation.

These are software-verified capabilities only; do not mark them CERTIFIED. Operator gates M1/M2 remain pending.

## Auto-review result

Reviewed to record the implemented WAHA media/audio path without treating software evidence as provider certification or closing operator gates.
