# Remaining Open Items and Validation Register

No item below blocks beginning Wave 0 unless explicitly stated. Unknowns are isolated instead of silently guessed.

## Technical spikes required in Wave 0

| Item | Current decision | Promotion criterion |
|---|---|---|
| Hatchet | preferred workflow runtime | certification suite passes; otherwise evaluate Inngest fallback |
| WAHA engine | GOWS preferred | core capability certification passes |
| OpenAI Agents SDK harness | accepted primary harness | benchmark/HITL/provider abstraction proof passes |
| PostgreSQL RLS | defense-in-depth target | pooling/background-worker implementation proven without unsafe bypass patterns |

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
