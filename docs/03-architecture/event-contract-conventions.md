# Event Contract Conventions

> Status: Canonical event implementation guidance  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked against Event Model, AsyncAPI, outbox/inbox and analytics separation.

## Domain events

Domain events are immutable facts about completed authoritative state changes.

Naming:

```text
<domain>.<fact>.v<major>
```

Example: `payment.confirmed.v1`, `trial.technical_passed.v1`.

Public ID identity: the public ID decomposes deterministically into
`event_type = <domain>.<fact>` (stable identity, no version) plus integer
`schema_version = <major>` carried in the envelope. The `.v<major>` suffix is
the transport rendering of the envelope `schema_version`, never a second
independent version. `scripts/validate_docs.py` enforces that AsyncAPI channel
keys match their message `name` and that the suffix major equals the envelope
`schema_version` const.

## Registry authority

The explicit registry block (`<!-- event-registry:start/end -->`) in
`docs/02-domain/event-model.md` — mirrored in
`docs/15-implementation-baseline/04-event-catalog.md` — is the only source of
canonical public IDs. Prose examples never create entries. Every registry row
carries class (`domain` vs `observational`), status (`planned/pre-implementation`
until shipped), declared sources (SPEC operational section and/or AsyncAPI
channel) and its semantic-family correspondence. New IDs require a declared
source plus review; source-less rows fail validation as invented/unreviewed.
Baseline semantic families (unversioned domain language) are never automatic
aliases: renames and splits are documented per row as "renamed, not an alias".

## Required envelope

Every durable domain event contains at minimum:

```text
event_id
event_type
schema_version
occurred_at
tenant_id
aggregate_type
aggregate_id
correlation_id
causation_id
payload
```

Actor/source metadata is added where relevant.

## Publication rule

The business mutation and outbox record must be committed atomically when the event is required for downstream consistency.

## Consumer rule

Consumers must be idempotent. Inbox/dedupe keys are persisted before/with material side effects according to the consumer’s transaction strategy.

## Versioning

- additive optional fields may remain within the same major version when consumers tolerate them;
- semantic meaning changes require a new event version;
- never reuse an old event name with changed meaning;
- old consumers must have a documented migration/deprecation path.

## Domain vs analytics-only events

UI/analytics exposure events do not become domain authority. They may use the analytics tracking plan without entering the domain event model unless business workflows depend on them.

Registered `observational` class events (e.g. `trial.first_playback_observed.v1`, `trial.followup_due.v1`, `risk.assessment_completed.v1`) are contract-stable telemetry: they are versioned and validated like domain events for compatibility, but MUST NOT mutate authoritative aggregates by themselves. Workflows may react only through explicit policy.

## PII

Publish only the minimum identifiers/properties required by consumers. Avoid message bodies, credentials, payment secrets or browser artifacts in event payloads.

## Ordering

Do not assume global ordering. Where aggregate ordering matters, store sequence/version information or make handlers state-aware.

## Replay

Consumers must define whether replay is safe, ignored, or requires a rebuild mode. External actions must never be blindly replayed.

## Auto-review result

Reviewed to preserve event meaning over time and prevent analytics events, retries or replays from mutating authoritative state incorrectly.
