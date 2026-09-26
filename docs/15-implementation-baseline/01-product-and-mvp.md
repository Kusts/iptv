# Product Contract and MVP Freeze

## Product definition

The product is a multi-tenant **AI Revenue & Operations Platform** for recurring businesses. It combines CRM, conversations, commerce, billing, subscriptions, fulfillment, support, growth, finance, analytics, knowledge and autonomous operations around an authoritative backend.

The first vertical is the owner's streaming/IPTV operation. The architecture must remain generic enough to support other recurring businesses without pretending all domain rules are generic.

## Core flywheel

`Acquisition → Activation/Trial → Sale → Fulfillment → Retention → Expansion → Referral → Recovery → Acquisition`

The economic objective is **lifetime contribution**, not first-order margin alone. Acquisition may be subsidized when cohort payback and retention justify it.

## MVP gates

### First-value checkpoint (M5; not a release gate)

Validate the core operating loop before the growth/productization scope: WhatsApp conversation → eligible Trial → offer/order → PIX settlement with ledger → verified provider fulfillment, with a human exception path. Check G01–G06 and F01–F04/F10/F12/F16/F17, baseline handling time/cost and manual fallback. The first real renewal in Wave 9 extends that evidence. This checkpoint does not waive any required MVP-PILOT item below.

### MVP-PILOT

Required to operate the internal tenant end-to-end:

- multi-tenancy, identity, RBAC and audit;
- CRM, Inbox and WAHA/GOWS;
- Customer Agent and Tenant Copilot;
- Service Trial, Retrial and Technical Access;
- Product/Plan/Offer/PriceBook/Order;
- Asaas PIX, payment webhooks and reconciliation;
- Subscription, cycles and entitlements;
- CINEVISION browser adapter and reconciliation;
- MK Ativador browser adapter and license assets;
- Support/Diagnostics/HITL;
- configurable campaigns, referral and rewards core;
- reseller core including hierarchical network;
- finance/unit economics and core analytics;
- operational ledger posting and reversal is required from the first real sale, not deferred to unit-economics reporting;
- knowledge/memory core;
- Control Center, Design System and critical mobile flows;
- observability, backup/restore, kill switches and manual fallback.

### MVP-SAAS

Adds what is required before external paying tenants:

- Platform Admin and tenant lifecycle;
- SaaS Plan/PlanVersion and PlatformSubscription;
- SaaS billing and usage dashboard;
- external onboarding/import/Observation Mode/Go-Live Review;
- final product naming and brand system;
- user documentation and platform support flow;
- commercial pricing/package defined from pilot telemetry;
- data export/cancellation/retention process required for external customers.

## Explicitly not required for MVP-PILOT

- Affiliate engine;
- own streaming application;
- advanced reseller portal/certification;
- white-label/custom domains;
- enterprise SSO/SCIM;
- Kafka/Kubernetes/microservices;
- dedicated warehouse/ClickHouse;
- full experimentation suite;
- cross-tenant benchmarks;
- CINEVISION monthly-credit model.

## MVP readiness statement

The pilot is ready only when the Golden Loop, renewal loop, recovery loop and failure journeys in the E2E matrix are passing with real integrations or certified test equivalents.
The first-value checkpoint is an earlier learning milestone; it is not permission to claim the full pilot ready or to skip real-operation validation gates.
