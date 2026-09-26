# SPEC — Compatibility Engine

> Status: Supporting detail — reconciled under v1.0 implementation baseline
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Purpose

Turn Trial/support observations into contextual compatibility evidence across Device × OS × App × ISP/network × Server × Playback Mode without treating anecdotal supplier guidance as universal truth.

## Inputs

- Trial technical assessments;
- support solution attempts/outcomes;
- provider/server incidents;
- device/app/network metadata collected lawfully;
- knowledge source/confidence metadata.

## Canonical observation

Each observation records context, outcome, sample provenance and timestamp. Aggregates are projections, not a replacement for raw evidence.

## Outputs

- compatibility success/failure rates by context;
- recommended app/server/procedure candidates;
- confidence/sample size/freshness;
- warning when evidence is too sparse or contradictory.

## Guardrails

- no recommendation from a single observation is labeled proven;
- supplier claims remain source-tagged hypotheses until validated;
- no sensitive network/device identifiers are retained without need;
- recommendations cannot authorize commercial/provider actions.

## Acceptance

A query can answer “what tends to work for this context?” with evidence count, confidence and freshness, and can return `INSUFFICIENT_EVIDENCE` rather than fabricate certainty.

## Auto-review result

Reviewed to keep Compatibility evidence-based and downstream of observed outcomes rather than hard-coded folklore.

## Refinamentos v0.14 — app catalog and recommendation

App catalog distinguishes `PAID`, `FREE` and `PARTNER`. Partner apps can be discovered from authorized playlist metadata; discovery does not make them commercial products.

Recommendation considers device/OS, observed stability, configuration ease, historical outcomes and price. The Agent must explain the value of a paid app while presenting free/partner alternatives when viable. Paid-app trial outcome becomes compatibility evidence. Customer choice remains final.

A Customer may keep different apps/licenses on multiple devices. Compatibility must not equate registered-device count with simultaneous connection allowance.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — paid/free/partner app recommendation and multi-device semantics checked.
