# Agent Memory Architecture

> Status: Canonical MVP design  
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Principle

Do not use one generic "memory" bucket. The platform distinguishes four classes:

1. **Operational facts** — authoritative database state, never LLM memory.
2. **Customer memory** — useful durable preferences/context about one Person.
3. **Canonical shared knowledge** — validated reusable support/business knowledge.
4. **Candidate learning** — observations/hypotheses awaiting validation.

## Customer memory examples

Allowed when useful and proportionate:

- preferred communication style;
- previously confirmed device/app setup;
- non-sensitive support context;
- explicit preference relevant to service.

Not memory:

- payment status;
- expiry date;
- entitlement quantity;
- balance;
- Trial eligibility;
- provider server state.

Those must be queried from authoritative services.

## Write policy

Memory writes pass a policy that evaluates:

```text
source
purpose
sensitivity
confidence
expiry/freshness
customer scope
```

The model may propose a memory candidate; a deterministic layer persists only allowed fields.

## Read policy

Context Builder retrieves the minimum relevant memories by Person and purpose. Memory must not override a newer operational fact or policy.

## Freshness and correction

Memories have source/timestamp and can be corrected/deprecated. If a user corrects a preference, preserve audit where needed but stop surfacing stale value.

## Privacy

Sensitive categories should not be stored in agent memory merely because they appeared in conversation. Follow Data Classification/Privacy policy and minimize retention.

## Auto-review result

Reviewed specifically to prevent financial/provider facts from drifting into probabilistic memory and to keep candidate learning separate from canonical knowledge.
