# Canonical Event Catalog (implementation baseline mirror)

> Baseline mirror of docs/02-domain/event-model.md registry. The registry block below is kept identical to the Event Model; drift fails validation. Semantic states and roadmap remain owned by the baseline track.

## Semantic families (domain language, unversioned)

These names are the stable domain vocabulary used in SPEC prose. They are NOT public contract IDs and MUST NOT be treated as automatic aliases of the versioned IDs below. Explicit correspondence is listed per registered event; where semantics were renamed or split, the mapping says so instead of inventing an alias.

### CRM
- `crm.lead.created`
- `crm.customer.created`
- `crm.next_action.created|completed|cancelled`

### Communications
- `communications.message.received`
- `communications.message.sent`
- `communications.conversation.control_changed`
- `communications.message_intent.deferred|suppressed|sent`

### Trials
- `trial.service.requested|activated|ended|failed`
- `trial.retrial.approved|denied`
- `support.technical_access.granted|ended`

### Commerce
- `commerce.order.created`
- `commerce.order.awaiting_payment`
- `commerce.order.settled`
- `commerce.order.cancelled|expired`

### Billing
- `billing.charge.created`
- `billing.payment.confirmed|failed|refunded`
- `billing.refund.requested|approved|rejected|executed`

### Subscriptions
- `subscription.created`
- `subscription.cycle.started|ended`
- `subscription.entitlement.granted|expired|revoked`
- `subscription.cancel_at_period_end_set`

### Provider
- `provider.operation.requested|started|verification_required|succeeded|failed`
- `provider.drift.detected|resolved`

### Inventory
- `inventory.credit_batch.received`
- `inventory.credit.reserved|consumed|released`
- `inventory.license.activated`

### Support
- `support.ticket.opened|resolved|closed`
- `support.incident.opened|resolved`
- `support.solution_attempt.recorded`

### Content
- `content.item.observed|removed`
- `content.request.created|submitted|available`

### Referral/Rewards
- `referral.referral.confirmed|reversed`
- `reward.reward.available|redeemed|revoked`

### Growth
- `growth.campaign.activated|paused|completed`
- `growth.attribution_touch.recorded`

### Partners
- `partner.reseller.created|activated|at_risk|inactive`
- `partner.relationship.created|ended`
- `partner.reseller_order.settled`

### AI/HITL
- `ai.agent_run.started|completed|failed`
- `human_review.requested|decided`
- `ai.autonomy.downgraded`

### Platform
- `platform.tenant.created|suspended|closed`
- `platform.subscription.activated|past_due|suspended|cancelled`
- `platform.release.deployed`

## Registered public events (provisional pre-implementation v1 contract)

Class `domain` = authoritative fact that may mutate an aggregate or drive a workflow. Class `observational` = registered signal/telemetry that MUST NOT mutate authoritative aggregates by itself; workflows may react to it only through explicit policy. Status `planned/pre-implementation` applies to every row: the IDs are frozen as declared intent so `scripts/validate_docs.py` can verify SPEC and AsyncAPI references, not as a claim of shipped implementation.

<!-- event-registry:start -->
| Public ID | Class | Status | Declared in | Semantic correspondence |
|---|---|---|---|---|
| `communication.opted_out.v1` | domain | planned/pre-implementation | AsyncAPI | `communications.message_intent.suppressed` family; new explicit opt-out outcome, no alias |
| `communication.preference_changed.v1` | domain | planned/pre-implementation | AsyncAPI | `communications.message_intent.*` family; new explicit preference outcome, no alias |
| `communication.suppressed.v1` | domain | planned/pre-implementation | AsyncAPI | `communications.message_intent.suppressed` |
| `conversation.human_takeover_started.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `communications.conversation.control_changed` split into explicit transitions |
| `conversation.paused.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `communications.conversation.control_changed` split into explicit transitions |
| `conversation.resumed_by_ai.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `communications.conversation.control_changed` split into explicit transitions |
| `conversation.resumed_by_human.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `communications.conversation.control_changed` split into explicit transitions |
| `conversation.returned_to_ai.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `communications.conversation.control_changed` split into explicit transitions |
| `conversation.started.v1` | domain | planned/pre-implementation | AsyncAPI | `communications.conversation.control_changed` family; new explicit start transition, no alias |
| `coupon.applied.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | no legacy family; new commerce policy fact, no alias |
| `coupon.rejected.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | no legacy family; new commerce policy fact, no alias |
| `customer.created.v1` | domain | planned/pre-implementation | SPEC 01-identity-crm | `crm.customer.created` (prefix dropped in public ID) |
| `customer.reactivated.v1` | domain | planned/pre-implementation | SPEC 08-referral-core | `crm.customer.created` family; new explicit reactivation transition, no alias |
| `gift_pass.expired.v1` | domain | planned/pre-implementation | AsyncAPI | no legacy family; gift extension of referral/reward baseline, no alias |
| `gift_pass.issued.v1` | domain | planned/pre-implementation | AsyncAPI | no legacy family; gift extension of referral/reward baseline, no alias |
| `gift_pass.redeemed.v1` | domain | planned/pre-implementation | AsyncAPI | no legacy family; gift extension of referral/reward baseline, no alias |
| `hitl.action_taken.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `human_review.requested\|decided` split into explicit lifecycle |
| `hitl.guidance_provided.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `human_review.requested\|decided` split into explicit lifecycle |
| `hitl.review_acknowledged.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `human_review.requested\|decided` split into explicit lifecycle |
| `hitl.review_cancelled.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `human_review.requested\|decided` split into explicit lifecycle |
| `hitl.review_expired.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `human_review.requested\|decided` split into explicit lifecycle |
| `hitl.review_queued.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `human_review.requested\|decided` split into explicit lifecycle |
| `hitl.review_requested.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `human_review.requested\|decided` split into explicit lifecycle |
| `hitl.review_resolved.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `human_review.requested\|decided` split into explicit lifecycle |
| `hitl.review_sla_breached.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `human_review.requested\|decided` split into explicit lifecycle |
| `hitl.review_started.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `human_review.requested\|decided` split into explicit lifecycle |
| `identity.created.v1` | domain | planned/pre-implementation | SPEC 01-identity-crm | no legacy family; new canonical identity fact, no alias |
| `identity.detached.v1` | domain | planned/pre-implementation | SPEC 01-identity-crm | no legacy family; new canonical identity fact, no alias |
| `identity.linked.v1` | domain | planned/pre-implementation | SPEC 01-identity-crm | no legacy family; new canonical identity fact, no alias |
| `identity.merge_review_requested.v1` | domain | planned/pre-implementation | SPEC 01-identity-crm | no legacy family; new canonical identity fact, no alias |
| `identity.verified.v1` | domain | planned/pre-implementation | SPEC 01-identity-crm | no legacy family; new canonical identity fact, no alias |
| `incident.confirmed.v1` | domain | planned/pre-implementation | AsyncAPI | `support.incident.opened\|resolved` renamed to `incident.*`; opened splits into detected/confirmed |
| `incident.detected.v1` | domain | planned/pre-implementation | AsyncAPI | `support.incident.opened\|resolved` renamed to `incident.*`; opened splits into detected/confirmed |
| `incident.resolved.v1` | domain | planned/pre-implementation | AsyncAPI | `support.incident.opened\|resolved` renamed to `incident.*` |
| `incident.updated.v1` | domain | planned/pre-implementation | AsyncAPI | `support.incident.opened\|resolved` family; new explicit update transition, no alias |
| `inventory.provider_credit_consumed.v1` | domain | planned/pre-implementation | AsyncAPI | `inventory.credit.reserved\|consumed\|released` partial; provider-credit scoped, no alias |
| `knowledge.candidate_created.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | no legacy family; new knowledge lifecycle, no alias |
| `knowledge.degraded.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | no legacy family; new knowledge lifecycle, no alias |
| `knowledge.deprecated.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | no legacy family; new knowledge lifecycle, no alias |
| `knowledge.rejected.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | no legacy family; new knowledge lifecycle, no alias |
| `knowledge.reverified.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | no legacy family; new knowledge lifecycle, no alias |
| `knowledge.solution_outcome_recorded.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | relates to `support.solution_attempt.recorded` as observed outcome; moved to knowledge domain, not an alias |
| `knowledge.source_discovered.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | no legacy family; new knowledge lifecycle, no alias |
| `knowledge.superseded.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | no legacy family; new knowledge lifecycle, no alias |
| `knowledge.validation_started.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | no legacy family; new knowledge lifecycle, no alias |
| `knowledge.verified.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | no legacy family; new knowledge lifecycle, no alias |
| `lead.created.v1` | domain | planned/pre-implementation | SPEC 01-identity-crm | `crm.lead.created` (prefix dropped in public ID) |
| `message.delivered.v1` | domain | planned/pre-implementation | AsyncAPI | `communications.message.sent` family; new explicit delivery transition, no alias |
| `message.failed.v1` | domain | planned/pre-implementation | AsyncAPI | `communications.message.sent` family; new explicit delivery transition, no alias |
| `message.queued.v1` | domain | planned/pre-implementation | AsyncAPI | `communications.message.sent` family; new explicit delivery transition, no alias |
| `message.read.v1` | domain | planned/pre-implementation | AsyncAPI | `communications.message.sent` family; new explicit read receipt transition, no alias |
| `message.received.v1` | domain | planned/pre-implementation | AsyncAPI | `communications.message.received` (prefix shortened in public ID) |
| `message.sent.v1` | domain | planned/pre-implementation | AsyncAPI | `communications.message.sent` (prefix shortened in public ID) |
| `offer.accepted.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | no legacy family; new offer lifecycle, no alias |
| `offer.created.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | no legacy family; new offer lifecycle, no alias |
| `offer.expired.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | no legacy family; new offer lifecycle, no alias |
| `offer.presented.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | no legacy family; new offer lifecycle, no alias |
| `order.accepted.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | `commerce.order.*` family; new explicit acceptance transition, no alias |
| `order.cancelled.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | `commerce.order.cancelled\|expired` |
| `order.completed.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | `commerce.order.*` family; new explicit completion transition, no alias |
| `order.created.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | `commerce.order.created` |
| `order.expired.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | `commerce.order.cancelled\|expired` |
| `order.fulfillment_started.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | `commerce.order.*` family; new explicit fulfillment transition, no alias |
| `order.settled.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing; SPEC 08-referral-core; AsyncAPI | `commerce.order.settled` |
| `order.submitted.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | `commerce.order.*` family; new explicit submission transition, no alias |
| `payment.cancelled.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | `billing.payment.*` family; new explicit cancellation transition, no alias |
| `payment.chargeback.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing; SPEC 08-referral-core | distinct issuer dispute fact; not a RefundRequest or refund execution |
| `payment.created.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | `billing.charge.created` renamed to payment obligation; not an alias |
| `payment.expired.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | `billing.payment.*` family; new explicit expiry transition, no alias |
| `payment.failed.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | `billing.payment.confirmed\|failed\|refunded` |
| `payment.paid.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing; SPEC 08-referral-core; AsyncAPI | `billing.payment.confirmed\|failed\|refunded`; confirmed renamed to paid, not an alias |
| `payment.partially_refunded.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | result of a partial Refund, distinct from a RefundRequest and its human approval |
| `payment.processing.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing | `billing.charge.created` family; new explicit processing transition, no alias |
| `payment.refunded.v1` | domain | planned/pre-implementation | SPEC 03-commerce-billing; SPEC 08-referral-core | `billing.payment.confirmed\|failed\|refunded` and `billing.refund.*` |
| `person.created.v1` | domain | planned/pre-implementation | SPEC 01-identity-crm; AsyncAPI | no legacy family; new canonical identity fact (`crm.*` does not cover person), no alias |
| `problem.created.v1` | domain | planned/pre-implementation | AsyncAPI | no legacy family; new problem lifecycle, no alias |
| `problem.resolved.v1` | domain | planned/pre-implementation | AsyncAPI | no legacy family; new problem lifecycle, no alias |
| `problem.root_cause_confirmed.v1` | domain | planned/pre-implementation | AsyncAPI | no legacy family; new problem lifecycle, no alias |
| `problem.workaround_added.v1` | domain | planned/pre-implementation | AsyncAPI | no legacy family; new problem lifecycle, no alias |
| `provider.operation_failed.v1` | domain | planned/pre-implementation | AsyncAPI | `provider.operation.requested\|started\|verification_required\|succeeded\|failed` |
| `provider.operation_requested.v1` | domain | planned/pre-implementation | AsyncAPI | `provider.operation.requested\|started\|verification_required\|succeeded\|failed` |
| `provider.operation_succeeded.v1` | domain | planned/pre-implementation | AsyncAPI | `provider.operation.requested\|started\|verification_required\|succeeded\|failed` |
| `referral.attributed.v1` | domain | planned/pre-implementation | SPEC 08-referral-core; AsyncAPI | `referral.referral.confirmed\|reversed` family; new explicit lifecycle, no alias |
| `referral.confirmed.v1` | domain | planned/pre-implementation | SPEC 08-referral-core; AsyncAPI | `referral.referral.confirmed\|reversed` |
| `referral.created.v1` | domain | planned/pre-implementation | SPEC 08-referral-core; AsyncAPI | `referral.referral.confirmed\|reversed` family; new explicit lifecycle, no alias |
| `referral.engaged.v1` | domain | planned/pre-implementation | SPEC 08-referral-core; AsyncAPI | `referral.referral.confirmed\|reversed` family; new explicit lifecycle, no alias |
| `referral.expired.v1` | domain | planned/pre-implementation | SPEC 08-referral-core; AsyncAPI | `referral.referral.confirmed\|reversed` family; new explicit lifecycle, no alias |
| `referral.qualification_started.v1` | domain | planned/pre-implementation | SPEC 08-referral-core; AsyncAPI | `referral.referral.confirmed\|reversed` family; new explicit lifecycle, no alias |
| `referral.rejected.v1` | domain | planned/pre-implementation | SPEC 08-referral-core; AsyncAPI | `referral.referral.confirmed\|reversed` family; new explicit lifecycle, no alias |
| `referral.reversed.v1` | domain | planned/pre-implementation | SPEC 08-referral-core; AsyncAPI | `referral.referral.confirmed\|reversed` |
| `reward.approved.v1` | domain | planned/pre-implementation | SPEC 08-referral-core; AsyncAPI | `reward.reward.available\|redeemed\|revoked` family; new explicit lifecycle, no alias |
| `reward.available.v1` | domain | planned/pre-implementation | SPEC 08-referral-core; AsyncAPI | `reward.reward.available\|redeemed\|revoked` |
| `reward.expired.v1` | domain | planned/pre-implementation | SPEC 08-referral-core; AsyncAPI | `reward.reward.available\|redeemed\|revoked` family; new explicit lifecycle, no alias |
| `reward.fulfillment_failed.v1` | domain | planned/pre-implementation | SPEC 08-referral-core; AsyncAPI | `reward.reward.available\|redeemed\|revoked` family; new explicit lifecycle, no alias |
| `reward.issued.v1` | domain | planned/pre-implementation | SPEC 08-referral-core; AsyncAPI | `reward.reward.available\|redeemed\|revoked` family; new explicit lifecycle, no alias |
| `reward.pending_created.v1` | domain | planned/pre-implementation | SPEC 08-referral-core; AsyncAPI | `reward.reward.available\|redeemed\|revoked` family; new explicit lifecycle, no alias |
| `reward.redeemed.v1` | domain | planned/pre-implementation | SPEC 08-referral-core; AsyncAPI | `reward.reward.available\|redeemed\|revoked` |
| `reward.revoked.v1` | domain | planned/pre-implementation | SPEC 08-referral-core; AsyncAPI | `reward.reward.available\|redeemed\|revoked` |
| `risk.assessment_completed.v1` | observational | planned/pre-implementation | AsyncAPI | no legacy family; risk decision signal only, never an aggregate mutation |
| `subscription.addon_activated.v1` | domain | planned/pre-implementation | AsyncAPI | `subscription.*` families remain unversioned; new explicit renewal/add-on fact, no alias to cycle.started/ended |
| `subscription.renewed.v1` | domain | planned/pre-implementation | SPEC 08-referral-core; AsyncAPI | `subscription.*` families remain unversioned; new explicit renewal fact, no alias to cycle.started/ended |
| `support.cancelled.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `support.ticket.opened\|resolved\|closed` family; new explicit cancellation transition, no alias |
| `support.closed.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `support.ticket.opened\|resolved\|closed` |
| `support.reopened.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `support.ticket.opened\|resolved\|closed` family; new explicit reopen transition, no alias |
| `support.resolved.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; SPEC 08-referral-core; AsyncAPI | `support.ticket.opened\|resolved\|closed` |
| `support.ticket_created.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `support.ticket.opened\|resolved\|closed`; opened renamed to ticket_created, not an alias |
| `support.ticket_linked_to_incident.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `support.ticket.opened\|resolved\|closed` family; new explicit linkage transition, no alias |
| `support.triage_started.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `support.ticket.opened\|resolved\|closed` family; new explicit triage transition, no alias |
| `support.waiting_customer.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `support.ticket.opened\|resolved\|closed` family; new explicit wait transition, no alias |
| `support.waiting_internal.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `support.ticket.opened\|resolved\|closed` family; new explicit wait transition, no alias |
| `support.waiting_provider.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `support.ticket.opened\|resolved\|closed` family; new explicit wait transition, no alias |
| `support.work_resumed.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `support.ticket.opened\|resolved\|closed` family; new explicit resume transition, no alias |
| `support.work_started.v1` | domain | planned/pre-implementation | SPEC 07-support-hitl-knowledge; AsyncAPI | `support.ticket.opened\|resolved\|closed` family; new explicit start transition, no alias |
| `trial.activated.v1` | domain | planned/pre-implementation | SPEC 02-trial; AsyncAPI | `trial.service.requested\|activated\|ended\|failed` |
| `trial.cancelled.v1` | domain | planned/pre-implementation | SPEC 02-trial | `trial.service.requested\|activated\|ended\|failed`; ended splits into expired/cancelled/invalidated |
| `trial.eligibility_allowed.v1` | domain | planned/pre-implementation | SPEC 02-trial | `trial.retrial.approved\|denied` family; new explicit eligibility outcome, no alias |
| `trial.eligibility_denied.v1` | domain | planned/pre-implementation | SPEC 02-trial | `trial.retrial.approved\|denied` family; new explicit eligibility outcome, no alias |
| `trial.eligibility_review_required.v1` | domain | planned/pre-implementation | SPEC 02-trial | `trial.retrial.approved\|denied` family; new explicit eligibility outcome, no alias |
| `trial.expired.v1` | domain | planned/pre-implementation | SPEC 02-trial | `trial.service.requested\|activated\|ended\|failed`; ended splits into expired/cancelled/invalidated |
| `trial.first_playback_observed.v1` | observational | planned/pre-implementation | SPEC 02-trial | new explicit observation; telemetry only, never consumes trial validity by itself |
| `trial.followup_due.v1` | observational | planned/pre-implementation | SPEC 02-trial | new explicit follow-up signal; derived trigger only, never an aggregate mutation |
| `trial.invalidated.v1` | domain | planned/pre-implementation | SPEC 02-trial | `trial.service.requested\|activated\|ended\|failed`; ended splits into expired/cancelled/invalidated |
| `trial.provisioning_failed.v1` | domain | planned/pre-implementation | SPEC 02-trial | `trial.service.requested\|activated\|ended\|failed`; failed splits into technical_failed/provisioning_failed |
| `trial.provisioning_started.v1` | domain | planned/pre-implementation | SPEC 02-trial | `trial.service.requested\|activated\|ended\|failed` family; new explicit provisioning transition, no alias |
| `trial.requested.v1` | domain | planned/pre-implementation | SPEC 02-trial; AsyncAPI | `trial.service.requested\|activated\|ended\|failed` |
| `trial.retrial_allowed.v1` | domain | planned/pre-implementation | SPEC 02-trial | `trial.retrial.approved\|denied`; approved renamed, not an alias |
| `trial.technical_failed.v1` | domain | planned/pre-implementation | SPEC 02-trial | `trial.service.requested\|activated\|ended\|failed`; failed splits into technical_failed/provisioning_failed |
| `trial.technical_inconclusive.v1` | domain | planned/pre-implementation | SPEC 02-trial | `trial.service.requested\|activated\|ended\|failed` family; new explicit assessment outcome, no alias |
| `trial.technical_passed.v1` | domain | planned/pre-implementation | SPEC 02-trial; AsyncAPI | `trial.service.requested\|activated\|ended\|failed` family; new explicit assessment outcome, no alias |
<!-- event-registry:end -->

## Registry rules

- The registry block above is the ONLY source the validator reads. Examples elsewhere (e.g. the Asaas line below) never create registry entries.
- A new public ID requires SPEC or AsyncAPI declaration plus review; adding a row without a source fails `check_registry_sources`.
- Renames are new events with a new version, never silent reuses. No row above is an automatic alias: where a name changed, the correspondence column says "renamed, not an alias".
- Known gaps (semantic family with no public v1 yet): `crm.next_action.*`, `support.technical_access.*`, `commerce.order.awaiting_payment`, `subscription.created`, `subscription.cycle.started|ended`, `subscription.entitlement.*`, `subscription.cancel_at_period_end_set`, `provider.operation.started`, `provider.operation.verification_required`, `provider.drift.*`, `inventory.credit_batch.received`, `inventory.license.activated`, `content.*`, `growth.*`, `partner.*`, `ai.agent_run.*`, `ai.autonomy.downgraded`, `platform.*`. These stay unversioned until a SPEC declares them.

## Integration boundary rule

Example (illustrative only — NOT a registry entry):

`Asaas PAYMENT_RECEIVED webhook → validated IntegrationInboxEvent → payment.paid.v1 (event_type=payment.paid, schema_version=1)`

Provider enums and payloads must not become internal event contracts.
