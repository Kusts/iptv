# ADR-0024 — Reconcile state and event contracts before dependent Waves

- Status: **ACCEPTED for the pre-implementation baseline**
- Date: 2026-09-26

## Context

The v1.0 state catalog simplified several aggregates after draft SQL/OpenAPI and SPECs had already listed more detailed lifecycles. The event catalog listed semantic families while the SPECs/AsyncAPI and static validator used versioned public IDs. No application implementation or PostgreSQL runtime validation exists yet; contract files and SQL are pre-implementation scaffolds.

## Decision

- Keep Order, Payment, Conversation, ProviderOperation, Ticket, HumanReviewRequest and KnowledgeItem aligned to the detailed physical/API sets, as documented in `../15-implementation-baseline/03-state-machines.md`. `PAID` is the Payment fact; `Order.SETTLED` remains distinct. Refund/chargeback facts preserve original entries and require adjustments.
- Keep CustomerSubscription's four-state lifecycle (`PENDING_ACTIVATION | ACTIVE | SUSPENDED | ENDED`) as the Subscription domain rule. Delinquency/grace are Billing/policy projections; `cancel_at_period_end` is an instruction while the paid period remains active. Align the draft SQL CHECK, OpenAPI enum and validator to this rule.
- The event catalog documents semantic families; the explicit versioned registry in `../15-implementation-baseline/04-event-catalog.md` identifies provisional public IDs and their correspondence. Public `event_type` and `schema_version` must be decomposed/validated consistently. Different meanings are not automatic aliases. Observational events are not business authority.
- Before a dependent Wave exits, validate catalog ↔ SQL/OpenAPI and registered event IDs ↔ operational SPEC/AsyncAPI references. Wave 0 may prove technology with synthetic/sandbox fixtures while later-Wave contracts are being reconciled.

## Consequences and rollback

The pre-implementation schema/contract changes are reversible by restoring their previous revisions; they have not been certified against a running database. **If any migration has already been applied or a contract has real consumers, do not rewrite history in that environment:** use a new additive migration, data mapping, versioned compatibility/deprecation plan and owner approval. Reopen the Subscription decision only if a concrete Subscription-owned workflow requires `OVERDUE`/`GRACE` as lifecycle states rather than Billing projections; reopen Payment if `CONFIRMED` is shown to have a different meaning from `PAID`.
