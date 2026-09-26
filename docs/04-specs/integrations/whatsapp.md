# Integration SPEC — WhatsApp / WAHA

> Status: FINAL v1.0 implementation direction; capability certification still required.

## Decision

WAHA is the primary gateway behind the owned `MessagingGateway`. GOWS is the preferred engine pending Wave 0 certification. The domain must remain compatible with replacement adapters and a future official Meta Cloud API adapter.

## Pipeline

`MessageIntent → Communication Policy → WhatsApp Risk Controller → priority queue → WAHA adapter`.

## Core requirements

- per-tenant/channel-account session binding;
- inbound/outbound text and required media/audio;
- webhook idempotency and message identity mapping including LID/JID handling;
- channel affinity and no confusing silent number switching;
- text default; outbound audio only after customer request/authorization;
- capping/timelock surfaced as account risk/capability state, not generic session-down state;
- no retry storm, restart/logout or engine rotation to evade account restrictions;
- multiple numbers allowed for legitimate operation/redundancy, never restriction evasion;
- pinned versions, regression tests and canary rollout on upgrades/engine changes.

## Degradation

Restrictions on new outreach must preserve inbound/existing support when the underlying account/engine allows it. UI and Agent consume capability-specific health such as `NEW_OUTREACH=RESTRICTED`, not a single global WhatsApp boolean.
