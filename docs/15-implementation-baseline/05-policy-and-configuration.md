# Policy, Configuration and Business Decision Strategy

## Five decision classes

1. `PLATFORM_INVARIANT` — cannot be relaxed by tenant configuration.
2. `PLATFORM_POLICY` — platform-controlled, versioned when material.
3. `TENANT_POLICY` — configurable by the business within platform bounds.
4. `PARTNER_POLICY` — direct reseller/partner rules within superior bounds.
5. `RUNTIME_FACT` — observed state; never user configuration.

## Immutable platform invariants

- tenant isolation;
- financial idempotency and append-only accounting adjustments;
- refund execution is human-required;
- uncertain provider effect is reconciled before retry;
- LLM cannot receive raw secrets or override authorization;
- manual UI and Agent use the same application commands;
- a partner manages direct children only unless explicit delegated access exists;
- Order, Charge, Payment and Subscription remain separate;
- provider capability cannot be invented by configuration.

## Configurable/versioned business objects

- `PriceBook/PriceBookVersion`;
- `Plan/PlanVersion`;
- `Offer/OfferVersion`;
- `Campaign/CampaignVersion`;
- `CommercialPolicyVersion`;
- `ReferralProgramVersion`;
- `RewardPolicyVersion`;
- `ResellerPriceBook` / `ResellerCommercialPolicy`;
- `ModelRoutingPolicyVersion`;
- `AgentRelease`.

Historical orders, rewards and agreements must retain version references or immutable snapshots.

## Current business decisions

| Decision | Status |
|---|---|
| IPTV monthly current price = R$30 | CONFIGURABLE initial value |
| Longer package prices | PILOT_VALIDATE / configuration |
| Early-renewal price/benefit | CONFIGURABLE |
| Referral economics | CONFIGURABLE |
| Campaign benefits/discounts | CONFIGURABLE |
| Affiliate engine | POST-MVP |
| Reseller hierarchy | DECIDED |
| Reseller economics | CONFIGURABLE |
| SaaS reseller model | architecture DECIDED, experience POST-MVP |
| SaaS pricing/packaging | PILOT_VALIDATE |
| CINEVISION prepaid | MVP |
| CINEVISION monthly plan | POST-MVP / RESEARCH |
| Own application | FUTURE |

## Configuration resolution

Conceptual order:

`Platform invariant → Platform policy/default → SaaS entitlement → Tenant policy → Direct-partner policy → Campaign/Offer rule → authorized explicit override → effective decision`

This is not a generic "last value wins" algorithm. Each domain defines how values combine; lower layers can never violate superior guardrails.

## Autonomy

Operation classes resolve to `AUTOMATIC | APPROVAL | MANUAL | DENY`, bounded by a platform maximum. Safe low-risk deterministic operations should default toward automation in the internal pilot. Error/risk escalation may automatically downgrade `AUTO → APPROVAL`; increasing autonomy must not happen silently.
