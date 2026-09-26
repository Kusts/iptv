# Canonical State Machine Catalog

Only the owning bounded context may transition its aggregate. UI labels may derive friendlier statuses but must not become an alternative state machine.

For aggregates with a physical schema, the sets below must match the SQL `CHECK` constraint and the OpenAPI enum. A state set does not imply every pair of states is a valid transition; each owning command defines its preconditions. The pre-implementation SQL/OpenAPI scaffolds must be reconciled to this catalog before a dependent Wave exits.

## Conversation

`OPEN | CLOSED | ARCHIVED`

Waiting for a customer/internal response is a Conversation Focus/NextAction or Ticket projection, not another Conversation lifecycle state.

Separate control plane:

`AI_CONTROL | HUMAN_CONTROL | PAUSED`

## CustomerOrder

`DRAFT | PENDING_ACCEPTANCE | PENDING_SETTLEMENT | SETTLED | FULFILLING | COMPLETED | CANCELLED | EXPIRED`

Typical economic path: `DRAFT → PENDING_ACCEPTANCE → PENDING_SETTLEMENT → SETTLED`; fulfillment then progresses independently to `FULFILLING → COMPLETED`. Cancellation/expiry are alternatives subject to policy.

`SETTLED` means economic settlement, not provider fulfillment.

## Payment

Canonical: `PENDING | PROCESSING | PAID | FAILED | CANCELLED | EXPIRED | PARTIALLY_REFUNDED | REFUNDED | CHARGEBACK`.
Provider-specific statuses remain in adapters.

`PAID` means an external payment was confirmed; it does not by itself settle an Order. Refund/chargeback facts preserve the original payment and require append-only adjustments. A `RefundRequest` and a resulting `Refund` remain distinct; executing a refund requires a human decision.

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
