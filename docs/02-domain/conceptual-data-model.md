# Canonical Domain and Ownership Model

## Rule

**One canonical owner per business fact.** Other contexts may project, query or react to a fact, but must not create a competing source of truth.

## Bounded contexts

| Context | Canonical ownership |
|---|---|
| Identity & Access | User, session, TenantMembership, roles, permissions |
| Platform Control Plane | Tenant catalog, SaaS plans/subscriptions, usage, platform entitlements |
| Partners & Distribution | Reseller/Partner accounts, direct partner relationships, reseller economics |
| CRM & Relationships | Person, ContactIdentity, Lead, Customer, Pipeline, NextAction |
| Communications | ChannelAccount, Conversation, Message, MessageIntent, scheduled contact |
| Commerce | Product, Plan, PlanVersion, PriceBook, Offer, Order |
| Billing & Payments | Charge, Payment, RefundRequest, Refund, PromiseToPay |
| Subscriptions & Entitlements | CustomerSubscription, SubscriptionCycle, Entitlement, temporary grants |
| Provider Operations | Provider, capability, external binding/state, ProviderOperation, reconciliation |
| Inventory & Procurement | ProviderCredit, batches, reservations, suppliers, LicenseAsset |
| Support & Reliability | Ticket, DiagnosticSession, SolutionAttempt, Incident, Problem |
| Content & Discovery | ContentItem, availability, ContentRequest, ContentInterest |
| Referral & Rewards | Referral, Reward, RewardWallet ledger |
| Growth & Attribution | Campaign, Audience, Creative, AttributionTouch |
| Finance & Unit Economics | Financial ledger, COGS, contribution, CAC/payback/LTV inputs |
| Analytics & Experimentation | MetricDefinition, Insight, Hypothesis, Experiment, DecisionRecord |
| Knowledge & Memory | MemoryFact, CustomerEpisode, KnowledgeItem, research candidates |
| AI & Automation | AgentRun, AgentTask, AgentRelease, HumanReviewRequest, skills/tools/runtime |

## Canonical distinctions

- `User` = authenticated SaaS user; `Person` = person known inside one tenant.
- `Lead` and `Customer` are relationships around `Person`, not synonyms.
- `Customer` is created on settled economic conversion even if fulfillment is pending.
- Ex-customer/reactivated are projections, not separate entities.
- Pipeline stage is operational organization, not domain state.
- Conversation ≠ Ticket.
- Product ≠ Plan ≠ Offer ≠ Order.
- Order ≠ Charge ≠ Payment ≠ Subscription.
- Subscription persists across renewals; each paid period is a `SubscriptionCycle`.
- Trial ≠ Retrial ≠ TechnicalAccessGrant ≠ TrustRenewalGrant ≠ AppTrial.
- Provider ≠ Supplier.
- ProviderCredit ≠ ResellerCredit ≠ RewardWalletCredit ≠ OrderCredit.
- Referral ≠ Affiliate ≠ Reseller.
- Knowledge ≠ Memory ≠ Skill ≠ Capability ≠ Tool.
- Notification ≠ Alert ≠ Task/NextAction ≠ Insight ≠ Incident.

## Reseller hierarchy

The canonical relation is a direct edge:

`parent_partner_id → child_partner_id`

An ancestor may see permitted aggregate network information, but operational management requires a **direct relationship** or an explicit delegated-access grant. Depth is a projection, not canonical truth.

A reseller may simultaneously be:

- IPTV/service reseller;
- SaaS Tenant;
- SaaS reseller.

Those roles are linked but not merged.

## Source of truth matrix

| Fact | Owner |
|---|---|
| Person/identity | CRM |
| Conversation/message | Communications |
| Price/offer/order | Commerce |
| Charge/payment/refund | Billing |
| Subscription/cycle/right | Subscriptions & Entitlements |
| External provider state | Provider Operations |
| Inventory/credits/licenses | Inventory |
| Support case/diagnostic | Support |
| Content availability | Content |
| Referral/reward | Referral & Rewards |
| Campaign/attribution | Growth |
| Revenue/cost/contribution | Finance |
| Metric/insight/experiment | Analytics |
| Memory/knowledge | Knowledge |
| Agent execution/HITL | AI & Automation |
| User/permission | Identity & Access |
| SaaS subscription/usage | Platform Control Plane |
| Reseller network | Partners |

## Non-authoritative surfaces

LLM context, conversation summaries, dashboards, pipeline stages, WhatsApp, CINEVISION, Asaas and analytics are **not** the source of truth for facts owned elsewhere.

## Shared implementation primitives

The shared kernel must remain intentionally small: typed IDs, `Money`, tenant context, time primitives, event envelope, error/result primitives. Do not grow a generic `shared` package into a second domain layer.


## Physical blueprint

See `../15-implementation-baseline/20-data-model-blueprint.md`.
