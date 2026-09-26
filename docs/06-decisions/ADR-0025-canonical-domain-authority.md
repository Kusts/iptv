# ADR-0025 — Canonical domain authority over pre-implementation scaffolds

- Status: **ACCEPTED**
- Date: 2026-09-26
- Supersedes: ADR-0024 where it aligned canonical semantics to older physical/API scaffolds

## Context

The documentation hardening after v1.0 correctly detected drift between state machines, SQL, OpenAPI/AsyncAPI and tests, but in a few cases resolved that drift by promoting older scaffolds into canonical business rules. No production application or certified database contract exists yet, so implementation artifacts must follow the approved domain model rather than the reverse.

## Decision

1. **Authority direction:** canonical domain/state/policy decisions drive migrations and API/event contracts until a real deployed compatibility constraint exists. Green consistency tests cannot legitimize a semantically wrong model.
2. **Conversation:** lifecycle is `OPEN | AWAITING_CUSTOMER | AWAITING_INTERNAL | RESOLVED | ARCHIVED`; control remains orthogonal as `AI_CONTROL | HUMAN_CONTROL | PAUSED`.
3. **CustomerOrder:** lifecycle is `DRAFT | AWAITING_PAYMENT | SETTLED | CANCELLED | EXPIRED`. Provider fulfillment belongs to Subscription/Entitlements/Provider Operations, not Order. Offer acceptance is not an Order fulfillment state.
4. **Charge vs Payment:** `Charge` owns pending/processing/failed/expired/cancelled collection; `Payment` is created only after confirmed money movement and owns `CONFIRMED | PARTIALLY_REFUNDED | REFUNDED | CHARGEBACK`. `Order ≠ Charge ≠ Payment ≠ Subscription`. Zero-value settlement never creates a fake Payment.
5. **HumanReview:** classification is two-dimensional: `review_mode = APPROVAL | REVIEW | GUIDANCE | MANUAL_EXECUTION`; `reason = SECURITY_CHALLENGE | PROVIDER_EXCEPTION | RISK_REVIEW | FINANCIAL_REVIEW | CONTENT_COMPLIANCE | OTHER`. Lifecycle status remains independent.
6. **Tenant Copilot:** dogfooding starts with read/navigation/context in Wave 3, gains commands incrementally as domains are implemented, and matures into the full analytics/workspace experience in Wave 14/17. It never bypasses user RBAC/policy.
7. **Contract gate:** SQL/OpenAPI/AsyncAPI and executable contract tests are changed to match these decisions before dependent Waves exit.

## Consequences

- Draft migrations and contracts are intentionally rewritten before implementation. If a future environment has already applied a migration or exposed a contract to real consumers, use additive migrations/versioned compatibility instead.
- Billing gains an explicit `Charge` aggregate/table and keeps `Payment` as confirmed financial fact.
- Event vocabulary uses `charge.*` for collection lifecycle and `payment.confirmed.v1` for the canonical payment fact.
- Consistency tests must assert both structural alignment and the key semantic separations above.

## Reopen conditions

Reopen only with concrete evidence from an implemented workflow/integration showing the canonical model cannot represent required behavior without violating ownership or auditability. Existing scaffold shape alone is not sufficient.
