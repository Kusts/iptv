# Human Review & Conversation Control — State Machines v1.0

> Status: FINAL supporting detail.

## HumanReviewRequest

`REQUESTED | QUEUED | ACKNOWLEDGED | IN_REVIEW | GUIDANCE_PROVIDED | ACTION_TAKEN | RESOLVED | EXPIRED | CANCELLED`

`APPROVE`/`REJECT` are auditable actions, not lifecycle statuses. Approval only authorizes continuation. Before sensitive execution the workflow revalidates permissions, policy, resource state and preconditions. Execution may still fail independently.

Types include `APPROVAL | GUIDANCE | SECURITY_CHALLENGE | PROVIDER_EXCEPTION | RISK_REVIEW | FINANCIAL_REVIEW | CONTENT_COMPLIANCE | OTHER`.

Refund execution always requires human decision.

## Conversation control

Separate from conversation lifecycle:

`AI_CONTROL | HUMAN_CONTROL | PAUSED`.

A human takeover never silently times out back to AI. Return to AI requires explicit human/workflow policy and a safe handoff summary.
