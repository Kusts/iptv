# PostgreSQL Data Model Blueprint

This is the v1.0 physical-model contract. Migrations are delivered per Wave; table names may be refined without changing canonical ownership/invariants.

## Physical organization

PostgreSQL schemas as actually created (`CREATE SCHEMA` across `db/migrations/`), in creation order:

`control, platform, security, identity, crm, trial, catalog, commerce, billing, finance, subscription, entitlement, provider, inventory, communication, support, knowledge, agent, referral, loyalty, renewal, growth, partners, analytics, experiments`

Schema boundaries improve ownership but do not replace tenant isolation.

## Common tenant-scoped columns

For operational tables: opaque UUIDv7-style `id`, `tenant_id`, `created_at`, `updated_at` where mutation is meaningful. High-risk relationships should use tenant-aware FKs/unique constraints where practical.

Money is exact (`*_minor bigint` + ISO currency, or exact decimal where a domain requires fractional units). Never binary floats.

## Core tables by context

### Identity / control
- `users`, `auth_sessions` (Better Auth integration boundary)
- `tenants`
- `tenant_memberships`
- `roles`, `permissions`, `role_permissions` or equivalent platform-owned authorization model
- `delegated_access_grants`

### CRM
- `persons`
- `contact_identities`
- `leads`
- `customers`
- `pipelines`, `pipeline_stages`, `pipeline_items`
- `next_actions`
- `customer_devices`

Critical unique: deterministic contact identity uniqueness within tenant/type/normalized external identifier where semantics permit.

### Communications
- `channel_accounts`
- `conversations`
- `conversation_participants`
- `messages`
- `message_intents`
- `scheduled_contacts`
- `communication_preferences`

Message external IDs need provider/session-aware dedupe.

### Trials / support grants
- `service_trials`
- `trial_assessments`
- `technical_access_grants`
- `trust_renewal_grants`
- `app_trials`

Constraints support at most one primary commercial Trial per Person and no concurrent open free-access window according to canonical policy.

### Commerce
- `products`
- `plans`, `plan_versions`
- `price_books`, `price_book_versions`, `price_book_items`
- `offers`, `offer_versions`
- `customer_orders`, `customer_order_items`
- immutable economic snapshots/version references after acceptance/settlement.

### Billing
- `charges`
- `payments`
- `refund_requests`
- `refunds`
- `promise_to_pay`
- integration event/inbox references.

External webhook dedupe by provider + external event ID; business idempotency keys separately scoped.

### Subscription / Entitlements
- `customer_subscriptions`
- `subscription_cycles`
- `entitlements`
- `entitlement_grants`
- optional add-on definitions/cycle charges where recurring COGS needs explicit allocation.

A renewal creates a cycle; it does not replace the subscription aggregate.

### Provider
- `providers`
- `provider_accounts`
- `provider_capabilities`
- `provider_bindings`
- `provider_operations`
- `provider_operation_attempts`
- `provider_state_snapshots`
- `reconciliation_findings`

Provider operations persist state, effect certainty, adapter version, attempts, evidence references and pre/postconditions.

### Inventory / Procurement
- `suppliers`
- `provider_credit_batches`
- `provider_credit_entries`
- `credit_reservations`
- `procurement_orders`
- `app_catalog_items`
- `license_assets`

### Support
- `support_tickets`
- `diagnostic_sessions`
- `solution_attempts`
- `incidents`
- `problems`
- `operational_signals`

### Content
- `content_items`
- `content_availability`
- `content_requests`
- `content_interests`
- catalog snapshots/diff metadata where needed.

### Referral / Rewards
- `referrals`
- `referral_programs`, `referral_program_versions`
- `rewards`
- `reward_wallet_entries` (ledger truth)

### Growth
- `campaigns`, `campaign_versions`
- `audience_definitions`, optional static memberships
- `creatives`
- `attribution_touches`
- `conversion_events`

### Partners
- `partner_accounts`
- `partner_relationships` (direct parent-child edge)
- `partner_capabilities`
- `reseller_price_books`
- `reseller_orders`
- `reseller_credit_entries` / reservations
- `learning_content`, `learning_content_versions`, `learning_progress`

No transitive management permission is derived from ancestry.

### Finance
- `financial_transactions`
- `financial_ledger_entries`
- cost allocation / source references

Ledger is append-only; correction is reversal/adjustment, not history mutation.

### Analytics / Experimentation
- `metric_definitions`
- event/fact projections/materialized aggregates as needed
- `insights`, `hypotheses`, `experiments`, `experiment_exposures`, `decision_records`

Operational truth is never moved into analytics tables.

### Knowledge / Memory
- `memory_facts`
- `customer_episodes`
- `knowledge_sources`
- `knowledge_items`
- embeddings/search indexes tenant-scoped
- research/learning candidates.

### AI / Automation
- `agent_releases`
- `agent_runs`
- `agent_tasks`
- `human_review_requests`
- `capability_definitions`
- `tool_definitions` metadata where persisted
- `workflow_links`/external workflow IDs as needed.

### Events / audit / idempotency
- `domain_events`
- `outbox_messages`
- `inbox_receipts`
- `idempotency_records`
- `audit_entries`
- `stored_objects` metadata/reference layer.

### Platform Control Plane
- `saas_plans`, `saas_plan_versions`
- `platform_subscriptions`
- `platform_entitlements`
- `usage_events` / metering aggregates
- `platform_invoices` or billing references
- tenant lifecycle/health configuration.

## Constraints that must be tested at database + application levels

- tenant-aware foreign relationships cannot cross tenants accidentally;
- one canonical external webhook effect is processed once;
- ledger transaction balances and cannot be edited to simulate reversal;
- one primary free ServiceTrial per Person;
- RETRIAL requires prior Trial + reason;
- reservation/consumption paths prevent double-spend for credits/rewards/inventory;
- direct partner edge is the management boundary;
- order snapshots/version references are immutable after settlement;
- payment/provider retries never create duplicate economic/provider effects.

## RLS

RLS is a defense layer to validate in Wave 0/1. If adopted, policies default-deny for tenant-scoped access and use a transaction/request tenant context. Background workers must establish the same explicit context rather than relying on privileged bypass as a convenience.
