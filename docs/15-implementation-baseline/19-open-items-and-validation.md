# Remaining Open Items and Validation Register

No item below blocks beginning Wave 0 in sandbox/synthetic environments unless explicitly stated. Unknowns are isolated instead of silently guessed. A gate for real customers, messages, provider writes or money may block that *live milestone* without blocking engineering work.

## Technical spikes required in Wave 0

| Item | Current decision | Promotion criterion |
|---|---|---|
| Hatchet | preferred workflow runtime | certification suite passes; otherwise evaluate Inngest fallback |
| WAHA engine | GOWS preferred | core capability certification passes |
| OpenAI Agents SDK harness | accepted primary harness | benchmark/HITL/provider abstraction proof passes |
| PostgreSQL RLS | defense-in-depth target | pooling/background-worker implementation proven without unsafe bypass patterns |

Each Wave 0 spike requires a named decision owner, pinned environment/version, predeclared acceptance/failure scenarios, observed evidence and a written fallback/limitations decision. The detailed, capability-specific cases are in `10-integrations-certification.md`; a happy-path demo is not a promotion criterion. The owner records inconclusive results as unvalidated rather than silently approving them.

## Gates before first live operation

These checks are proportional to the actual operation. Record responsible operator, evidence and the permitted environment before promotion; do not interpret this list as a claim that the current business lacks authorization.

| First live milestone | Required validation before that milestone |
|---|---|
| M1 — real customer conversation | Channel/account authorization, applicable messaging rules, customer-data handling/consent or other applicable legal basis and manual reply path |
| M2 — AI-handled conversation | M1 checks plus shadow/canary evals, human takeover, approved action boundaries and customer-facing disclosure where applicable |
| M3 — provider Trial | Authorized access to provider/test account, provider capability certification, customer-data/content/technical-access constraints and manual exception path |
| M4/M5 — real PIX and fulfilled sale | Asaas controlled production canary, account/business/payment/tax/content-rights checks applicable to the operation; implemented and verified RefundRequest → human decision → Refund/chargeback paths (including duplicate/concurrent/unknown effects), ledger and same-customer entitlement invariants. The v1.0.1 OpenAPI/DDL scaffolds define the contract but do not satisfy this gate without runtime/concurrency/provider evidence |
| G07 — real supplier purchase | MK account/supplier terms, controlled test purchase, reconciliation for unknown purchase effect and explicit spending limits |

Use synthetic/sandbox fixtures while a live gate remains unresolved; a production credential or working integration is not evidence of authorization by itself. Revisit these validations on material provider, business or jurisdiction changes.

## Live integration evidence

- CINEVISION browser semantic operations and postconditions need recertification against live panel during implementation.
- MK private purchase/balance/activation needs authenticated browser certification.
- Asaas uses official Sandbox first, production canary before final certification.
- WAHA session/restriction/media behavior requires pinned-version certification.

## Business validation during pilot

- longer IPTV package prices;
- early-renewal economics;
- referral reward amounts/limits;
- reseller tier/price economics;
- SaaS value metric, packaging and price;
- final SLO/usage thresholds after measured load/cost.

## Post-MVP research

- CINEVISION monthly-credit model;
- Affiliates;
- own app;
- advanced cross-tenant learning/benchmarks;
- advanced autonomous experimentation/pricing.

## Before external commercial launch

- final naming/domain/trademark/social checks;
- logo/palette/type/brand guidelines;
- legal review for privacy/LGPD, terms/DPA, marketing language, tax and content licensing/tenant compliance boundaries;
- external-facing retention/deletion policies and support commitments.

The implementation must not hardcode assumptions for any item in this register. Use configuration/capability boundaries already defined by the baseline.
