# Refinement v1.0.1 Summary

> Date: 2026-09-26  
> Base: agent-adjusted v1.0 package supplied by the user  
> Result: canonical implementation baseline corrected and re-reviewed

## Why this revision exists

The agent's hardening substantially improved contract consistency, event validation and implementation gates, but four semantic regressions were found: some canonical states had been changed to match older SQL/OpenAPI scaffolds; Commerce/Billing had collapsed Charge into Payment and let Order own fulfillment states; HumanReview mixed action mode with reason; and Tenant Copilot delivery had moved too late. v1.0.1 keeps the valid hardening and corrects those regressions.

## Final corrections

1. **Canonical authority restored** — approved domain rules drive pre-implementation migrations/contracts, not the reverse.
2. **Conversation** — `OPEN | AWAITING_CUSTOMER | AWAITING_INTERNAL | RESOLVED | ARCHIVED`; control is separate.
3. **Order** — `DRAFT | AWAITING_PAYMENT | SETTLED | CANCELLED | EXPIRED`; fulfillment stays outside Order.
4. **Billing** — explicit `Charge` lifecycle and confirmed `Payment`; zero-value settlement never fabricates Payment.
5. **Refund** — `RefundRequest` is separate from `Refund`; execution is human-gated, serialized/revalidated and reconciles unknown external effects.
6. **HumanReview** — `review_mode` says what the human must do; `reason` says why.
7. **Tenant Copilot** — starts dogfooding in Wave 3, gains commands incrementally, matures in Wave 14/17.
8. **Trust Renewal** — removed remaining generic courtesy/cooldown artifacts and reward enum support; fixed +3-day provider capability only when eligible.

## Valid hardening preserved from the agent revision

- explicit versioned Event Registry and registry/AsyncAPI/SPEC validation;
- Subscription four-state lifecycle;
- Trial lifecycle vs kind vs technical outcome separation;
- ProviderOperation `VERIFYING`, `RETRY_WAIT`, `HUMAN_REQUIRED` and effect certainty;
- richer Ticket/HITL/provider certification coverage;
- F16/F17 adversarial ownership/refund concurrency scenarios;
- first-value checkpoint separated from full MVP-PILOT gate;
- integration certification and Hatchet concurrency/fairness proof requirements;
- PII/evidence hardening.

## Implementation status

The documentation is ready to begin **Wave 0**. Static documentation/contract gates pass. PostgreSQL runtime execution and live/sandbox integration evidence are deliberately not claimed here and remain Wave 0 / later certification gates.
