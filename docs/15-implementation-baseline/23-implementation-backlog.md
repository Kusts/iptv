# Implementation Backlog — Work Packages

This backlog is the executable decomposition of `18-implementation-plan.md`. A work package may be split into agent-sized tasks but its acceptance gate must not be weakened.

## Status note (2026-10-02)

Waves 1–16 and the W0 CINEVISION provider runtime hardening (Fases 0–5) are implemented, with migration 046 applied. `CHANGELOG.md` (`## Unreleased`) is the authoritative delivery record. The wave sections below are preserved verbatim as the **original specification** and are no longer a statement of current progress.

## Wave 0 — Architecture Proof

- **W0-00 Contract reconciliation** — for the first vertical slice, align baseline states/events with SQL/OpenAPI/AsyncAPI and focused contract checks; retain a decision record for deliberate deviations. Scaffolds for later Waves are reconciled before implementation, not treated as shipped interfaces.
- **W0-01 Harness bootstrap** — `AgentHarnessPort`, OpenAI Agents SDK runner, model-provider abstraction, one Primary + one specialist-as-tool.
- **W0-02 Harness HITL** — approval interruption, serialized state, process restart and resume.
- **W0-03 Harness benchmark** — minimal-loop baseline vs Synkroo harness; tool/context/delegation metrics.
- **W0-04 Hatchet bootstrap** — self-hosted dev stack, task/workflow/event/wait/crash-resume proof.
- **W0-05 Hatchet HITL bridge** — workflow waits on `HumanReviewRequest`, then revalidates/resumes Agent state.
- **W0-06 Tenant fairness** — tenant-scoped/shared concurrency experiment and noisy-neighbor test.
- **W0-07 WAHA/GOWS session spike** — login, persistent session, restart, inbound/outbound, webhook.
- **W0-08 WAHA risk-state spike** — map/simulate capping/timelock to capability-specific health.
- **W0-09 Playwright worker spike** — persistent authenticated profile + one safe CINEVISION read + semantic readback.
- **W0-10 CINEVISION write proof** — one controlled test operation with pre/postcondition and unknown-effect reconciliation.
- **W0-11 MK browser proof** — authenticated balance/read and controlled purchase/activation test account path.
- **W0-12 Asaas sandbox proof** — PIX charge → duplicate webhook → one canonical payment effect.
- **W0-13 RLS/pooling spike** — prove request/background tenant context or document safe alternative defense layer.
- **W0-14 Manual pilot baseline capture** — in parallel with spikes, measure available lead/Trial/sale/renewal volumes, response/handling time, human hours and provider/payment costs from the current operation with source and observation period; use `BASELINE_UNAVAILABLE` for gaps (`docs/01-product/success-metrics.md`). This is product evidence, not a prerequisite to run sandbox spikes.

**Wave 0 exit:** ADR gates confirmed or fallback decision made; no architecture blocker hidden. For each W0 spike, the owner records environment/version, account scope, predeclared failure cases, test evidence, known limitations and fallback against `10-integrations-certification.md`. A demo without restart/reconciliation evidence is inconclusive.

## Wave 1 — Foundation

- **W1-01 Repo bootstrap** — pnpm/Turbo, apps/packages, lint/typecheck/test/build pipelines.
- **W1-02 Database bootstrap** — Kysely, migrations, UUID/Money/time primitives, Neon/local Postgres profiles.
- **W1-02a Ownership constraints** — classify tenant/customer/Subscription/Order ownership across draft FKs; add database and command checks where tenant-only FKs permit mixed-customer or mixed-subscription references. Exercise SQL migrations and adversarial same-tenant fixtures on disposable PostgreSQL before use.
- **W1-03 Tenant/Auth** — Better Auth sessions, Tenant/TenantMembership, active TenantContext.
- **W1-04 Authorization** — roles/permissions, platform-role separation, permission test matrix.
- **W1-05 Audit** — actor/source/correlation audit entry infrastructure.
- **W1-06 Command/query conventions** — typed application command bus/conventions without over-engineered CQRS framework.
- **W1-07 Event envelope + Outbox/Inbox** — atomic publication and idempotent-consumer infrastructure.
- **W1-07a Minimal exception substrate** — persisted `HumanReviewRequest`, tenant-scoped queue, audited decision/action and stale-approval revalidation contract needed before Customer Agent goes live; richer UI follows in Wave 8.
- **W1-08 Hatchet production adapter** — runtime wiring, error/correlation conventions.
- **W1-09 Configuration/Policy foundation** — typed definitions, versioning/publish semantics, resolver skeleton.
- **W1-10 Capability/Tool Registry foundation** — availability/risk/certification/manual-equivalent metadata.
- **W1-11 Secrets/R2** — Infisical machine identities, private R2 object metadata/signed access.
- **W1-12 Observability** — OTel traces/logs/metrics, Langfuse integration boundary, correlation IDs.
- **W1-13 Design System foundation** — tokens/layout/navigation/forms/tables/status/empty/loading/error primitives.
- **W1-14 Control Center shell** — authenticated tenant shell and basic health/activity surfaces.
- **W1-15 Backup/restore automation** — pilot backup path and first documented restore exercise.
- **W1-16 Pilot baseline continuation** — extend/recheck W0-14 where reliable and instrument before/after comparisons; mark unknowns `BASELINE_UNAVAILABLE` rather than inventing targets.

**Wave 1 exit:** authenticated tenant command produces state + domain event + audit + trace; isolation tests pass.

## Wave 2 — CRM + Communications

- Person/ContactIdentity deterministic resolution;
- Lead/Customer/Pipeline/NextAction;
- ChannelAccount + WAHA session binding;
- Conversation/Message/MessageIntent;
- Inbox manual operation + delivery/status mapping;
- basic human takeover/return and manual exception queue usable before AI live operation;
- communication preferences/focus/quiet hours basics;
- Saved Views/filter foundation for CRM/Inbox;
- E2E G01 + F05/F06 foundations.

## Wave 3 — Customer Agent v1

- Context Builder + memory/knowledge fetch interface;
- AgentRelease + ModelRoutingPolicy;
- Commercial and Technical specialists;
- semantic CRM/Knowledge tools;
- MessageIntent response tool path;
- Shadow mode, AI/Human control, Agent Activity;
- live-safe approval/resume and failed-agent manual fallback through the same command/policy/audit path;
- critical injection/cross-tenant/tool-policy evals;
- **Tenant Copilot foundation** — global widget shell, current route/entity/selection/filter context, permission-scoped read/navigation, deep links and explain-current-screen using the same Context Builder/Capability Registry; no privileged bypass;
- E2E G02 + F07/F09/F10 plus Copilot read/isolation smoke tests.

## Wave 4 — Trial + Compatibility

- ServiceTrial/assessment/retrial constraints;
- TechnicalAccess domain skeleton;
- compatibility/app/device models;
- CINEVISION trial semantic operations;
- live-provider/account and applicable content/technical-access checks before the first real Trial;
- Customer Agent trial tool/policy;
- E2E G03/G04 + invariant suite.

## Wave 5 — Commerce + Billing

- Product/Plan/Version/PriceBook/Offer/Order snapshots;
- CommercialPolicy/discount boundaries;
- Asaas Charge/Payment adapter, authenticated webhook inbox, reconciliation;
- operational balanced financial ledger: order settlement (including zero-value with valid credit), idempotent postings, reversal/chargeback adjustment; keep analytical allocation for Wave 10;
- `RefundRequest`/human decision/`Refund` execution implementation against the v1.0.1 migration/OpenAPI contract, including serialized refundable-amount reservation, concurrent requests, stale approval and unknown-effect reconciliation (F08/F17); no real payment canary until runtime evidence passes;
- controlled production canary and applicable payment/data checks before the first real charge;
- Billing specialist/tools;
- Tenant Copilot may prepare Order/Charge drafts and open filtered billing views; execution uses existing commands/policies;
- PIX UI and Order/Charge/Payment timelines;
- E2E G05 + F01.

## Wave 6 — Subscription + Fulfillment

- CustomerSubscription/SubscriptionCycle/Entitlement;
- CINEVISION provider bindings/state/operations/reconciliation;
- automatic fulfillment workflow + postcondition;
- credentials delivery and completion-state UX;
- manual equivalent commands;
- Tenant Copilot may execute the first low-risk authorized domain commands (for example open/reconcile/prepare actions) only through the same command/policy/audit pipeline; sensitive actions still follow HITL;
- E2E G06 + F02/F03/F04/F12/F16 (cross-customer Order/Cycle/Entitlement and add-on ownership).

**First-value checkpoint after Wave 6:** G01–G06 and F01–F04/F10/F12/F16/F17 passing with controlled real/certified equivalents, manual exception path, baseline handling time and transaction cost captured. This checkpoint is not the full MVP-PILOT release gate.

## Wave 7 — Apps/MK

App catalog snapshots/diffs, AppTrial, MK balance/inventory, LicenseAsset, trial-before-purchase rule, supplier reconciliation, certified test-account then controlled live purchase, G07/F15.

## Wave 8 — Support/HITL

Ticket, DiagnosticSession, SolutionAttempt, TechnicalAccessGrant, incident basics, full HumanReview center and expanded human takeover/return UX, G11/G12/F11. Do not defer the Wave 1–3 minimal exception path to here.

## Wave 9 — Renewal/Retention

Renewal cycle, early renewal configuration, TrustRenewalGrant, cancel-at-period-end, reminders/PromiseToPay/winback, G08/G09/G10/F13.

## Wave 10 — Finance/Unit Economics

Advanced cost references/allocation, provider/app/payment/AI/messaging costs, lifetime contribution, CAC/payback/cohorts and core executive metrics; operational ledger posting/reversals already delivered in Wave 5.

## Wave 11 — Campaigns/Attribution

Campaign/version/audience/creative, MessageIntent scheduling, basic budget/attribution, G17.

## Wave 12 — Referral/Rewards

Referral lifecycle, qualification, reward/wallet ledger, anti-abuse, context-aware referral opportunities, G13.

## Wave 13 — Resellers

PartnerAccount/direct relationships/network projection, reseller order/credit ledger, reseller CRM/360, Academy/progress, direct-child authorization, SaaS opportunity/link, G14/G15/G16.

## Wave 14 — Analytics/Control Center + Tenant Copilot maturation

Metric Catalog implementation, funnels/cohorts/revenue/provider/agent/reseller dashboards, data-quality indicators, Control Center aggregation. **W14-COPILOT:** mature the Copilot foundation already dogfooded since Wave 3: full workspace, business/metric analysis, richer structured responses, draft/preview flows, cross-domain navigation and the required authorized-command scenarios through the existing command/policy/audit pipeline; human approval where risk requires it; denial, stale-resource and tenant-isolation cases; G18. Full reporting/research polish can continue in Wave 17, but widget + workspace + G18 must pass before MVP-PILOT.

## Wave 15 — Knowledge/Learning maturation

Knowledge Admin, lifecycle/provenance/freshness, memory corrections, candidate validation, knowledge gaps/research workflow.

## Wave 16 — Experiment instrumentation

Feature flags, exposure events, Experiment basic aggregate and guardrails. Advanced statistics/UI remain post-MVP.

## Wave 17 — Pilot Hardening

Operate real tenant, close reliability/UX/agent/integration regressions, complete Tenant Copilot surfaces and G18, tune autonomy, verify unit economics, run restore/incident drills and freeze critical regression suites.

## Waves 18–20 — SaaS Productization/Beta/Launch

Control Plane/SaaS billing/usage, onboarding/import/go-live, brand/docs/data lifecycle, pricing from pilot, assisted external beta, beta fixes and MVP-SAAS gate.

## Agent task template

Every coding task derived from a work package must contain:

- work-package ID and bounded context;
- goal/vertical slice;
- allowed files/packages;
- canonical states/commands/events/capabilities;
- dependencies and non-goals;
- acceptance tests/evals;
- security/tenant implications;
- observability requirements;
- documentation files to update;
- Definition of Done reference.
