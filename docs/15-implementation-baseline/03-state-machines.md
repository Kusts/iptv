# Canonical State Machine Catalog

Only the owning bounded context may transition its aggregate. UI labels may derive friendlier statuses but must not become an alternative state machine.

For aggregates with a physical schema, the sets below must match the SQL `CHECK` constraint and the OpenAPI enum. A state set does not imply every pair of states is a valid transition; each owning command defines its preconditions. The pre-implementation SQL/OpenAPI scaffolds must be reconciled to this catalog before a dependent Wave exits.

## Conversation

`OPEN | AWAITING_CUSTOMER | AWAITING_INTERNAL | RESOLVED | ARCHIVED`

These states describe the conversation lifecycle itself. `AWAITING_CUSTOMER` and `AWAITING_INTERNAL` suppress or reschedule incompatible proactive work through Conversation Focus/Communication Policy. `RESOLVED` preserves the resolved conversation before optional archival.

Separate control plane:

`AI_CONTROL | HUMAN_CONTROL | PAUSED`

## CustomerOrder

`DRAFT | AWAITING_PAYMENT | SETTLED | CANCELLED | EXPIRED`

Typical economic path: `DRAFT → AWAITING_PAYMENT → SETTLED`. Offer acceptance is owned by Offer/Commerce policy before or while the Order is prepared; provider fulfillment is owned by Subscription/Entitlements/Provider Operations and must not be duplicated in Order states.

`SETTLED` means the economic obligation of the Order is satisfied, not provider fulfillment.

## Charge

`PENDING | PROCESSING | PAID | FAILED | CANCELLED | EXPIRED`

A Charge is the external collection obligation/attempt. Provider-specific Asaas states map to this lifecycle. `PAID` on a Charge is external evidence that causes canonical Payment confirmation after validation/idempotency.

## Payment

`CONFIRMED | PARTIALLY_REFUNDED | REFUNDED | CHARGEBACK`

A Payment is a confirmed financial movement, never a pending/failed collection attempt. `Payment.CONFIRMED` does not by itself settle an Order; settlement also accounts for internal credits/rewards and policy. Refund/chargeback facts preserve the original Payment and require append-only adjustments. A `RefundRequest` and a resulting `Refund` remain distinct; executing a refund requires a human decision.

## RefundRequest

`REQUESTED | UNDER_REVIEW | APPROVED | REJECTED | EXPIRED | CANCELLED | EXECUTED`

## Refund

`PROCESSING | RECONCILING | SUCCEEDED | FAILED | CANCELLED`

Refund execution has orthogonal effect certainty `KNOWN_APPLIED | KNOWN_NOT_APPLIED | UNKNOWN`; an unknown external effect reconciles before any retry.

## CustomerSubscription

`PENDING_ACTIVATION | ACTIVE | SUSPENDED | ENDED`

Normal cancellation is `cancel_at_period_end` / renewal policy, not an immediate `CANCELLED` state.

`RENEWAL_DUE`, `OVERDUE` and `GRACE` are billing/policy projections, not Subscription lifecycle states. Keep paid access through the current cycle when `cancel_at_period_end` is set. `ENDED` means no continuing cycle/entitlement; a policy-authorized reactivation creates a new cycle on the existing relationship. Suspension requires an explicit service policy decision, never merely a late payment webhook.

## ServiceTrial

`REQUESTED | PROVISIONING | ACTIVE | ENDED | INVALIDATED | CANCELLED`

Typical lifecycle: `REQUESTED → PROVISIONING → ACTIVE → ENDED`. An unusable trial may be explicitly `INVALIDATED`, enabling policy-reviewed retrial; a provisioning failure is recorded on the provider attempt and may lead to invalidation. Technical failure is an assessment result, not a second lifecycle `FAILED`.

Technical result is separate: `PENDING | PASSED | FAILED | INCONCLUSIVE`.

Persisted Trial kind: `TRIAL | RETRIAL`. `TRIAL` is the one primary free commercial trial per Person; retrial requires `previous_trial_id` + legitimate reason. "Primary" is descriptive wording, not a separate stored enum.

## ProviderOperation

`REQUESTED | QUEUED | RUNNING | VERIFYING | RETRY_WAIT | HUMAN_REQUIRED | SUCCEEDED | FAILED | CANCELLED`

`HUMAN_REQUIRED` is the persisted state for an operation that needs manual handling; `AWAITING_HUMAN` may only be a UI label. A retry wait does not imply permission to repeat an uncertain external write.

Effect certainty is orthogonal: `KNOWN_APPLIED | KNOWN_NOT_APPLIED | UNKNOWN`.

Timeout/transport failure with uncertain effect must go to `VERIFYING`, not blind retry.

## Ticket

`NEW | TRIAGING | IN_PROGRESS | WAITING_CUSTOMER | WAITING_INTERNAL | WAITING_PROVIDER | RESOLVED | CLOSED | CANCELLED`.

## HumanReviewRequest

`REQUESTED | QUEUED | ACKNOWLEDGED | IN_REVIEW | GUIDANCE_PROVIDED | ACTION_TAKEN | RESOLVED | EXPIRED | CANCELLED`.

`APPROVE`/`REJECT` are auditable human actions/decisions on the request, not lifecycle status values. Approval is authorization, not proof of execution success; execution rechecks policy, permissions and resource state.

Classification is orthogonal to lifecycle: `review_mode = APPROVAL | REVIEW | GUIDANCE | MANUAL_EXECUTION`; `reason = SECURITY_CHALLENGE | PROVIDER_EXCEPTION | RISK_REVIEW | FINANCIAL_REVIEW | CONTENT_COMPLIANCE | OTHER`. The mode defines what the human must do; the reason defines why the exception exists.

## Referral

`CREATED | ATTRIBUTED | ENGAGED | QUALIFYING | CONFIRMED | REJECTED | EXPIRED | REVERSED`.

## Reward

`PENDING | APPROVED | ISSUED | AVAILABLE | REDEEMED | EXPIRED | REVOKED | FAILED`.

## Campaign

`DRAFT | SCHEDULED | ACTIVE | PAUSED | COMPLETED | CANCELLED`.

Material edits to active/published campaigns create new versions where historical interpretation would otherwise change.

## KnowledgeItem

`DISCOVERED | CANDIDATE | VALIDATING | VERIFIED | DEGRADED | SUPERSEDED | DEPRECATED | REJECTED`.

## Experiment

`DRAFT | READY | RUNNING | PAUSED | ANALYSIS_PENDING | COMPLETED | CANCELLED`.

Decision is separate: `ADOPT | REJECT | ITERATE | EXTEND | INCONCLUSIVE`.

## ResellerAccount lifecycle

`PROSPECT | ONBOARDING | TRAINING | READY | ACTIVE | AT_RISK | INACTIVE | SUSPENDED | TERMINATED`.

Training status does not automatically prevent sales unless policy explicitly requires it.
