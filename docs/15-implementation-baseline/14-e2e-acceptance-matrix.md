# E2E Acceptance Matrix

The following scenarios are mandatory gates. Automated coverage should be maximized; live integration/canary scenarios may remain controlled certification tests where automation is unsafe.

## Golden journeys

| ID | Journey | Required outcome |
|---|---|---|
| G01 | WhatsApp inbound → identity → conversation → manual reply | one correct Person/Conversation; outbound delivered once |
| G02 | WhatsApp inbound → Customer Agent → answer | correct context/policy; audited AgentRun; one outbound intent |
| G03 | New Person → eligible 1h/3h/6h Trial → provider | one primary Trial; provider readback matches |
| G04 | Legitimate Retrial after technical failure | reason + previous trial recorded; no abuse loophole |
| G05 | Trial → Offer → CustomerOrder → PIX → Payment confirmed | Order settles exactly once |
| G06 | Settled Order → Subscription/Cycle/Entitlement → CINEVISION | service provisioned once; postcondition confirmed |
| G07 | Paid app trial/test → payment → MK purchase → LicenseAsset | no speculative purchase; one supplier charge |
| G08 | Active customer renewal before expiration | remaining paid days preserved; new cycle recorded |
| G09 | Eligible Trust Renewal | exactly +3 days; no paid Order fabricated |
| G10 | Cancellation | service remains active through paid period; future renewal disabled |
| G11 | Support → Diagnostic → solution → confirmation | structured evidence/outcome; support suppresses inappropriate marketing |
| G12 | Technical access for existing/ex-customer | distinct from commercial Trial; support ticket/reason linked |
| G13 | Referral → referred customer settles → reward | qualification and reward ledger happen once |
| G14 | Reseller onboarding → training → reseller order/credit → first sale | reseller activates without becoming tenant special case |
| G15 | Reseller creates direct child; ancestor views network | parent manages child; grandparent cannot manage descendant directly |
| G16 | Reseller becomes SaaS Tenant | PartnerAccount remains; tenant isolated; relationship linked |
| G17 | Campaign → dynamic/static audience → Offer → attribution | historical campaign/offer version remains reproducible |
| G18 | Tenant Copilot opens filtered view/prepares action/executes allowed command | same command/policy/audit as manual UI |

## Failure/recovery journeys

| ID | Failure | Required behavior |
|---|---|---|
| F01 | Payment webhook delivered repeatedly | one payment effect, one settlement, no duplicate entitlement |
| F02 | Payment confirmed, provider unavailable | payment/order preserved; fulfillment queued; support/CRM continue |
| F03 | Browser write times out with unknown effect | VERIFYING/readback before retry |
| F04 | Browser DOM drift | affected provider write degrades safely; unrelated operation continues |
| F05 | WAHA timelock/capping | affected new outreach deferred/suppressed; existing conversations/inbound remain where possible |
| F06 | WAHA restart | certified sessions recover without cross-session/tenant mixup |
| F07 | Primary model failure | safe fallback or capability-specific degradation; deterministic workflows continue |
| F08 | Agent attempts refund | HumanReviewRequest; no refund execution without human decision |
| F09 | Prompt/tool/web content attempts policy injection | no privilege/policy change; content treated as untrusted data |
| F10 | Tenant A attempts Tenant B data access | denied before retrieval/action; audited/security tested |
| F11 | Human approves but resource changed before execution | permission/policy/preconditions revalidated; stale approval cannot force invalid action |
| F12 | Workflow/worker crashes mid-step | durable resume without duplicate economic/provider effect |
| F13 | Scheduled payment reminder becomes obsolete after payment | reminder cancelled/suppressed after state re-evaluation |
| F14 | Knowledge/analytics unavailable | sale/payment/provider/support critical paths remain operational |
| F15 | MK balance insufficient | app purchase path pauses/alerts; IPTV/support remain operational |
| F16 | Valid IDs from two customers of the same tenant are mixed in Order/Subscription/Cycle/Entitlement/add-on charge | mismatched ownership is rejected before granting access or posting money; tenant-only FKs are insufficient |
| F17 | Duplicate or concurrent partial refunds; stale approval; provider refund timeout or chargeback | no over-refund or duplicate ledger adjustment; refund waits for valid human decision; unknown effect reconciles; chargeback remains distinct |

## Agent invariant fixtures

- expired customer never receives Trust Renewal;
- Trust Renewal with >3 days remaining is denied;
- second primary free Trial is not silently created;
- additional connection disclosure reflects same expiration as primary;
- audio requested + credentials produces hybrid response;
- refund remains human-required;
- summaries cannot override authoritative DB facts;
- ambiguous identity never silently merges.
