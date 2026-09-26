# API, Command and Contract Blueprint

## Contract strategy

REST/OpenAPI is the operational API surface. Domain events use the canonical event envelope and AsyncAPI documentation. Agent tools do **not** call provider APIs directly; they invoke semantic application commands/capabilities.

The pre-implementation OpenAPI/AsyncAPI files are scaffolds. During each Wave the implementation must update/generate them from the v1.0 canonical vocabulary and pass contract validation before the Wave exits.

## Route groups

Representative route groups, not exhaustive endpoint naming:

- `/v1/auth/*` and tenant/session selection integration;
- `/v1/persons`, `/leads`, `/customers`, `/next-actions`;
- `/v1/conversations`, `/messages`, `/message-intents`;
- `/v1/trials`, `/technical-access`;
- `/v1/products`, `/plans`, `/price-books`, `/offers`, `/orders`;
- `/v1/charges`, `/payments`, `/refund-requests`;
- `/v1/subscriptions`, `/subscription-cycles`, `/entitlements`;
- `/v1/provider-operations`, `/provider-state`, `/reconciliation-findings`;
- `/v1/inventory`, `/suppliers`, `/licenses`;
- `/v1/tickets`, `/diagnostics`, `/incidents`, `/problems`;
- `/v1/content`, `/content-requests`;
- `/v1/referrals`, `/rewards`, `/wallet`;
- `/v1/campaigns`, `/audiences`, `/attribution`;
- `/v1/partners`, `/reseller-orders`, `/reseller-credits`, `/academy`;
- `/v1/finance`, `/metrics`, `/analytics`;
- `/v1/knowledge`, `/memory` (appropriately scoped/admin-only where needed);
- `/v1/agent/tasks`, `/agent/activity`, `/human-reviews`;
- `/v1/settings/policies`, `/integrations`, `/audit`;
- `/v1/platform/*` for SaaS control-plane operations.

## Command-oriented actions

State-changing routes should map to explicit application commands rather than generic arbitrary PATCH when a domain transition is meaningful. Examples:

- `RequestServiceTrial`
- `CreateOfferOrder`
- `Confirm/ProcessPaymentEvent`
- `RenewSubscription`
- `SetCancelAtPeriodEnd`
- `RequestTrustRenewal`
- `RequestProviderOperation`
- `GrantTechnicalAccess`
- `ResolveTicket`
- `ApproveHumanReview`
- `RequestRefund` / `DecideRefundRequest` / `ExecuteApprovedRefund` (distinct from a provider-initiated chargeback)
- `ActivateCampaign`
- `CreateDirectResellerRelationship`

## Request invariants

- tenant identity comes from authenticated/effective context, never trusted request-body tenant IDs;
- client-provided idempotency keys are accepted only in documented scopes;
- correlation IDs flow through API → workflow → integration → events;
- money and timestamps use canonical representations;
- APIs expose canonical domain statuses, not raw provider enums.

## Webhook ingress

`HTTP webhook → authenticate/validate → persist integration inbox/dedupe → fast acknowledgement → async handler → canonical command/event`.

Never run long provider/business logic before acknowledging an external webhook after durable persistence.

## Refund/chargeback contract required before the first real charge

The v1.0.1 pre-implementation OpenAPI/DDL scaffold now contains the minimum RefundRequest and human-gated execution paths. Wave 5 must implement, runtime-validate and certify these contracts before M4 production canary promotion:

1. Authenticated customer/operator request creates a tenant-scoped `RefundRequest` linked to Payment, amount/currency/reason, immutable requester and idempotency key; it **never** executes the refund.
2. An authorized human decision is recorded as an auditable HumanReview action, with amount/scope/expiry. A model/tool cannot self-approve or execute it.
3. `ExecuteApprovedRefund` revalidates actor, decision, payment, currency, remaining refundable amount and current policy under transaction-level serialization for that payment. Reserve the amount before any external attempt; multiple requests, concurrent commands and provider webhook retries cannot exceed the original paid amount. Record provider operation/effect certainty; ambiguous effects reconcile before retry.
4. Reconcile provider outcome with a `Refund` and append-only ledger adjustment; re-evaluate downstream entitlements separately. Reject stale/revoked approval or wrong customer/tenant linkage. Provider-initiated chargeback follows a distinct intake/reversal path and is not forged as a human-authorized refund.

Contract tests must include duplicate command/webhook, two concurrent partial refunds, total over-refund, stale approval, cross-customer IDs within the same tenant, provider timeout and chargeback. OpenAPI/API surface, migration and integration fixtures must remain synchronized in Wave 5; the present scaffold is a contract blueprint, not proof of runtime safety.

## Async contracts

Events must remain backward compatible within their version. Breaking payload change increments event version; consumers are idempotent and can ignore additive fields unless the contract requires them.

## Agent tool contract

Tool inputs/outputs are narrower than public API payloads and optimized for semantic intent. A tool cannot accept raw `tenant_id`, arbitrary provider endpoint, SQL, selector or secret. It returns structured outcome/status/evidence references suitable for Agent reasoning without exposing implementation credentials/details.
