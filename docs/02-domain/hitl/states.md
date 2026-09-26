# Human Review & Conversation Control — State Machines v1.0

> Status: FINAL supporting detail.

## HumanReviewRequest

`REQUESTED | QUEUED | ACKNOWLEDGED | IN_REVIEW | GUIDANCE_PROVIDED | ACTION_TAKEN | RESOLVED | EXPIRED | CANCELLED`

`APPROVE`/`REJECT` are auditable actions, not lifecycle statuses. Approval only authorizes continuation. Before sensitive execution the workflow revalidates permissions, policy, resource state and preconditions. Execution may still fail independently.

Classification is two-dimensional:

- `review_mode = APPROVAL | REVIEW | GUIDANCE | MANUAL_EXECUTION`;
- `reason = SECURITY_CHALLENGE | PROVIDER_EXCEPTION | RISK_REVIEW | FINANCIAL_REVIEW | CONTENT_COMPLIANCE | OTHER`.

The mode defines the requested human action; the reason explains why the exception was raised.

Refund execution always requires human decision.

## Conversation control

Separate from conversation lifecycle:

`AI_CONTROL | HUMAN_CONTROL | PAUSED`.

A human takeover never silently times out back to AI. Return to AI requires explicit human/workflow policy and a safe handoff summary.
