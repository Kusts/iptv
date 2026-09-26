# SPEC — Next Best Action Engine

> Status: Supporting detail — reconciled under v1.0 implementation baseline
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Purpose

Select an allowed next commercial/service action using current customer state, economics, policy, experiments and risk; the LLM decides wording, not eligibility.

## Candidate actions

```text
DO_NOTHING
ASK_REFERRAL
SEND_RENEWAL
OFFER_APP
OFFER_LONGER_PLAN
GRANT_TRUST_RENEWAL_IF_ELIGIBLE
WINBACK
OFFER_GIFT_PASS
RESOLVE_SUPPORT_FIRST
```

## Decision contract

Return action, reason, eligibility evidence, expected economic impact range and required approval. `DO_NOTHING` is a valid outcome.

## Guardrails

No action may bypass Communication Policy, Risk, entitlement/provider capability or experiment assignment. Support problems can suppress commercial actions.

## Auto-review result

Reviewed to ensure the engine chooses only policy-allowed actions and does not become a second uncontrolled agent.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — candidate action now reflects fixed provider capability.
