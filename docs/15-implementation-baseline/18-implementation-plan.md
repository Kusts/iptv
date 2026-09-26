# Implementation Plan — Waves and Critical Path

Roadmap is exit-criteria-driven rather than calendar-driven.

The first-value milestone is not the MVP-PILOT gate: validate the operating loop early, then add the remaining required pilot capabilities through later Waves. Integrity, tenant isolation and manual recovery apply to every live slice.

## Parallel workstreams

- Platform/Core;
- Business Domains;
- AI & Automation;
- Integrations;
- Product/Frontend;
- transversal QA/Observability/Documentation.

Parallelism starts only after contracts/invariants are stable.

## Wave 0 — Architecture Proof

Prove with production-shaped code:

- Agent Harness: Primary + specialist + tool + policy + HITL/resume;
- Hatchet: durable workflow, wait/retry/crash/HITL/tenant fairness;
- WAHA/GOWS: sessions, inbound/outbound, webhook/restart;
- Browser Worker: authenticated semantic operation + postcondition;
- Asaas sandbox: charge → webhook → idempotent canonical event.
- Canonical state/event registry: baseline, SQL/OpenAPI/AsyncAPI and contract checks agree for the first vertical slice; later-Wave scaffolds are reconciled before use.
- In parallel with the technical spikes, record the current manual pilot baseline (volume, handling time, conversion/renewal and costs where available) with period and source; mark missing values `BASELINE_UNAVAILABLE` rather than inventing targets.

**Exit:** for each spike, record owner, environment/version, test account or sandbox, predeclared pass/fail cases (including retries, restart and unknown effects), observed evidence, unresolved limits and selected fallback. Baseline collection may continue through Wave 1 if historical data is unavailable; it must not become a made-up Wave 0 pass threshold. No unresolved architecture blocker for dependent implementation. An inconclusive proof does not certify an adapter or runtime.

## Wave 1 — Foundation

Monorepo, DB, migrations, Tenant/Auth/RBAC, audit, Command/Event conventions, Outbox/Inbox, configuration/policy/capability infrastructure, minimal HumanReview persistence/queue, observability, Design System shell. Capture baseline business/cost measures where available before broad automation.

**Exit:** login → tenant → command → event → audit/trace works end-to-end.

## Wave 2 — CRM + Communications

Person/Identity/Lead/Customer, Conversation/Message/NextAction, WAHA Inbox/manual reply, basic human takeover/return and exception queue. First live messaging requires the applicable communication/privacy/operational validation recorded in `19-open-items-and-validation.md`.

**Milestone M1:** first real WhatsApp conversation through platform.

## Wave 3 — Customer Agent v1 + Tenant Copilot foundation

Context Builder, Primary, Commercial/Technical specialists, AgentRelease, safe tools, MessageIntent, evals, shadow mode and a working human takeover/approval/resume path before first real AI-handled conversation.

**M2:** first AI-handled conversation.

## Wave 4 — Trials + Compatibility

Eligibility, primary/retrial, diagnostics, CINEVISION trial adapter, app/device compatibility. Certify real-account access and the applicable content/technical-access checks before the first live Trial.

**M3:** first automated real Trial.

## Wave 5 — Commerce + Billing

Product/Plan/PriceBook/Offer/Order, operational financial ledger posting/reversal, Asaas PIX, webhook/reconciliation. Production canary and applicable payment/data checks precede a real charge.

**M4:** first payment processed through canonical flow.

## Wave 6 — Subscription + Fulfillment

Subscription/Cycle/Entitlement, CINEVISION fulfillment/postconditions, credentials/customer notification.

**M5:** first autonomous sale.

**First-value checkpoint (after M5, before broad growth scope):** demonstrate G01–G06 and F01–F04/F10/F12/F16/F17 with real integrations or certified controlled equivalents, plus manual handling of exceptions and measured handling time/cost. This checkpoint proves the core sales loop; it does **not** declare MVP-PILOT ready. The same standard applies to the first renewal in Wave 9.

## Wave 7 — Apps/MK

App catalog/trial, MK balance/purchase, LicenseAsset. Paid purchase requires certified test-account path followed by controlled live evidence.

## Wave 8 — Support + HITL

Full Ticket/diagnostic/TechnicalAccess, incident management, HumanReview center and extended takeover/review UX. The minimal exception path was already operational in Waves 1–3.

## Wave 9 — Renewal + Retention

Renewal windows, early renewal, Trust Renewal, cancellation at period end, recovery/winback.

**M6:** first autonomous renewal.  
**M7:** full customer lifecycle operational.

## Wave 10 — Finance/Unit Economics

Advanced cost attribution, contribution, CAC/payback/LTV/cohorts. The transaction ledger is operational from Wave 5 and cost telemetry has been collected since earlier waves.

**M8:** real unit economics available.

## Waves 11–16 — Growth loops

11 Campaign/attribution mature UX; 12 Referral/Rewards; 13 Resellers/Academy/network; 14 Analytics/Control Center and **Tenant Copilot maturation**; 15 Knowledge/Learning Admin; 16 experiment instrumentation/basic experiment capability.

**M9:** first reseller managed.

## Wave 17 — Pilot Hardening

Operate real business, reduce avoidable human intervention, fix reliability/UX/agent/integration issues, finish the required Tenant Copilot surfaces, and freeze regression suites. Recheck the complete MVP-PILOT matrix, not just the first-value checkpoint.

**M10:** Pilot Operational.

## Wave 18 — SaaS Productization

Platform Control Plane, SaaS billing/usage, external onboarding, final brand/docs/data lifecycle/pricing from pilot data.

## Wave 19 — External Tenant Beta

1–3 assisted tenants, Observation Mode, selective autonomy, usability/default validation.

**M11:** first external SaaS tenant.

## Wave 20 — MVP-SAAS

Resolve beta findings, finalize packages/billing/support/onboarding/docs.

**M12:** MVP-SAAS Ready.

## Task contract for coding agents

Each implementation task must declare bounded context, allowed files/packages, canonical command/event/capability, dependencies, tests/evals, acceptance criteria and docs to update. Avoid task wording such as “implement Billing” without a vertical slice.
