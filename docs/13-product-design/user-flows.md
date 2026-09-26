# UX User Flows

> Status: Canonical UX baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — business state transitions remain owned by Domain docs.

## Flow A — New lead to Trial

`Inbox/Lead → identify/link Person → qualify device/context → Trial eligibility → ALLOW/REVIEW/DENY → create Trial → provisioning → technical assessment → outcome`.

UX requirements:

- eligibility reason visible;
- previous Trial history visible before exception;
- RETRIAL requires reason/evidence;
- support state pauses conversion pressure.

## Flow B — Trial to paid customer

`Technical pass → offer → order preview → payment method → authoritative payment confirmation → order settlement → subscription/entitlement → fulfillment verification`.

The UI must distinguish payment success from fulfillment success.

## Flow C — Support with HITL

`Ticket → incident check → guided troubleshooting → uncertainty/high risk → Human Review → customer standby state → human guidance/action → return to AI → resolve → outcome → candidate knowledge`.

## Flow D — Renewal

`Renewal due → communication policy → payment/order → settlement → recurring add-on charges → provider renewal → postcondition → confirmation → referral opportunity`.

## Flow E — Referral

`positive moment → referral ask → invite → referred Person → Trial → valid conversion → qualification/risk → reward issued → wallet/gift pass`.

## Flow F — Provider failure

`operation pending → running → timeout/unknown effect → verify external state → retry/repair/HITL → final evidence`.

No blind retry after unknown-effect operations.
