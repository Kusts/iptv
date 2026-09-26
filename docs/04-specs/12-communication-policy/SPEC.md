# SPEC — Communication Policy Engine

> Status: Supporting detail — reconciled under v1.0 implementation baseline
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Purpose

Decide whether a proactive or automated message may be sent before the messaging adapter is called.

## Inputs

Channel, purpose, customer preference/opt-out, quiet hours, recent-contact frequency, active Ticket/Incident, conversation control, campaign suppression and legal/commercial policy.

## Purposes

```text
SUPPORT
TRANSACTIONAL
BILLING
RENEWAL
MARKETING
REFERRAL
INCIDENT_UPDATE
```

Purpose affects allowed timing/frequency and opt-out handling.

## Decision

```text
ALLOW
DEFER(until)
SUPPRESS(reason)
REVIEW(reason)
```

## Mandatory rules

- HUMAN_CONTROL/PAUSED is respected;
- opt-out and suppression cannot be bypassed by the LLM;
- referral asks are suppressed during unresolved negative support context where policy says so;
- frequency caps are evaluated across campaigns/workflows, not individually.

## Audit

Every denied/deferred proactive send stores structured reason without storing unnecessary message body.

## Auto-review result

Reviewed to ensure communication frequency/consent is deterministic and channel adapters remain execution-only.

## Refinamentos v0.14 — continuidade e omnicanal

- `ChannelAccount` permite múltiplos números/contas do mesmo canal por tenant e preserva channel affinity quando saudável.
- Follow-up é `intent + due_at + priority`, não texto estático. No disparo, reavaliar Conversation Focus/context e decidir `SEND/MERGE/RESCHEDULE/SUPPRESS`.
- Prioridade operacional default: security/incident > support > service/payment > trial > renewal > commercial > referral > marketing, configurável.
- IA é default no Inbox; Human Review e Human Takeover permanecem distintos.
- TTS/STT passam por Voice Gateway e preferência `TEXT/AUDIO/AUTO`; custo é metered.
- Contato público e conversa privada são superfícies separadas; nunca expor billing/credentials/MAC/Device ID publicamente.
- `Programadas`, Central de Notificações e Central de Atividade da IA são projeções operacionais obrigatórias no Control Center.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — conversation focus and channel-account rules checked.

