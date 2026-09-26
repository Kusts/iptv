# Product & Engineering Principles — v1.0

> Status: **FINAL**

1. **Own the truth.** PostgreSQL/backend owns critical business state; providers, payment gateways, channels and model runtimes are adapters.
2. **Frontend is a Control Center, not authority.** UI/Agent/workflow use the same application commands and policies.
3. **Multi-tenant from the first commit.** Tenant isolation applies to DB, cache, search, files, knowledge, analytics, workflows and Agent context.
4. **One owner per fact.** Projections may be many; canonical ownership is singular.
5. **Commerce, money, rights and fulfillment are distinct.** Order != Payment != Subscription != Entitlement != Provider state.
6. **Long-lived relationship, short-lived model context.** Durable state/memory lives outside the model.
7. **AI converses and reasons; backend governs.** LLMs do not invent prices, rights, policies or permissions.
8. **Automation is the default operating model.** Human intervention is exception/HITL for uncertainty, sensitive decisions and true edge cases.
9. **Security is proportional.** Isolate/degrade the smallest affected capability rather than blocking the whole operation when safe alternatives exist.
10. **Unknown external effect is a state to reconcile.** Verify before retrying a write whose result is uncertain.
11. **Refund execution is always human-required.** Detection/evidence/recommendation may be automated.
12. **Manual fallback always exists for essential operations.** AI is not a single point of failure.
13. **Capabilities are truthful.** Provider limitations cannot be turned into configurable imaginary features.
14. **Trial is qualification, not recurring free service.** One primary Trial per Person; Retrial requires legitimate reason.
15. **Trust Renewal is a specific provider grant.** For CINEVISION: +3 days, ACTIVE, <=3 days remaining—never arbitrary +N.
16. **Economic history is reproducible.** Prices/policies/campaigns/rewards are versioned/snapshotted where material.
17. **Ledgers before balances.** Financial, reward and reseller-credit corrections are append-only adjustments/reversals.
18. **Messaging is policy-governed.** MessageIntent flows through communication policy and risk control; no direct campaign blast path.
19. **External content is untrusted data.** Research/web/community/tool output cannot override system instructions/policies.
20. **Partner ancestry is not operational authorization.** Manage direct children only unless delegated access is explicit.
21. **Provider/Supplier/browser implementation details stay behind semantic adapters.** No raw selectors, endpoints or secrets in Agent tools.
22. **Observability without chain-of-thought.** Show actions, evidence, state and policy outcomes, not private reasoning traces.
23. **Graceful degradation is designed, not improvised.** Billing, support, CRM and existing customer flows continue when unrelated capabilities fail.
24. **MVP reduces business scope, not engineering integrity.** Tenant isolation, idempotency, audit, testing, observability and design-system quality are foundational.
25. **Future capabilities stay planned but do not hijack the critical path.** Promote them only when evidence/activation conditions justify it.
