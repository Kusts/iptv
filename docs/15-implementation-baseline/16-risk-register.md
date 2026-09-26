# Implementation Risk Register

| Risk | Severity | Primary mitigation | Trigger / contingency |
|---|---|---|---|
| CINEVISION UI changes break browser adapter | High | semantic adapter, fixture tests, readback, canary | degrade provider writes, alert engineering, keep CRM/billing/support running |
| WAHA/WhatsApp behavior/restriction changes | High | Risk Controller, certification, version pin/canary | defer affected outbound; preserve healthy inbound/existing chats |
| Agent harness fails to improve model reliability | High | Wave 0 benchmark vs minimal loop | adjust context/tool/specialist design; replace harness through owned port if evidence justifies |
| Hatchet fails durable/HITL/fairness requirements | High | Wave 0 certification | switch workflow runtime to Inngest candidate before dependent build expands |
| Duplicate economic/provider effect | Critical | idempotency keys, ledgers, inbox/outbox, postcondition verification | halt only affected write capability and reconcile |
| Cross-tenant data leak | Critical | explicit TenantContext, repository guards, isolation tests, RLS defense layer | security incident, revoke/suspend affected path, investigate/contain |
| Browser session loss/challenge | Medium/High | persistent isolated profile + HITL | reauthenticate; queued operations remain durable |
| Asaas webhook delay/duplicate | Medium | validated inbox + reconciliation | API reconciliation; no state based solely on webhook ordering |
| Model provider outage/degradation | Medium | Model Gateway/fallback and deterministic boundaries | degrade advanced AI; manual/transactional paths remain |
| Knowledge/prompt injection | High | untrusted ingestion quarantine + tool/policy boundary | suppress malicious instruction, security finding if meaningful |
| Human approval becomes operational bottleneck | High | automation-first policies, approval-fatigue analytics | review policy/tool reliability; never remove mandatory refund HITL |
| Scope creep delays pilot | High | MVP freeze + FutureCapability Registry | reject/defer non-gate features |
| SaaS pricing chosen without real COGS | High | pilot metering before pricing | keep SaaS pricing TBD until sufficient data |
| Reseller hierarchy grants accidental descendant control | High | direct-edge authorization | deny unless direct relationship/delegated grant |
| Data quality during existing-customer import | Medium | preview/conflict/Observation Mode | partial import; isolate conflicts instead of blocking all |
| Too-rigid security blocks autonomous operation | High | capability-scoped degradation and platform minimum guardrails | measure avoidable HITL/block rate and tune policies |
| Stale docs cause coding agents to implement superseded decisions | High | v1.0 authority map + loading order + stale-term CI checks | block documentation validation until resolved |
| Baseline, schema and public contracts disagree on states/events | High | explicit contract registry, targeted equality checks and Wave 0/each-Wave reconciliation | stop dependent Wave promotion; decide aggregate ownership before editing schema/contracts |
| Live pilot milestone precedes applicable operational/legal validation | High | milestone-specific gates for customer messages, provider writes and money | keep synthetic/sandbox path until evidence and accountable operator are recorded |
| Pilot feature breadth hides first-value signal | High | first-value checkpoint after core sale; maintain full MVP-PILOT gate separately | measure core conversion/handling time/cost before expanding growth/AI surfaces |
| Same-tenant cross-customer IDs link payments to another subscription/access | Critical | customer/subscription/order ownership checks in DB + commands; F16 | block affected order/fulfillment path before Wave 6 promotion |
| Duplicate/concurrent refund exceeds paid value or bypasses human decision | Critical | separate Request/Decision/Effect, transaction-level reservation, provider reconciliation; F17 | block live-charge promotion until OpenAPI, schema and integration behavior are verified |

## Risk governance

Risks have owners during implementation and must be revisited at Wave exit gates. A mitigation may not silently weaken a platform invariant. New risks discovered during pilot become regression/eval/runbook candidates rather than isolated fixes only.
