# Live Integration Certification Plan

## Certification states

`UNVALIDATED → LAB_VALIDATED → CANARY_VALIDATED → CERTIFIED`

Side states: `CERTIFIED_WITH_LIMITATIONS | DEGRADED | RECERTIFICATION_REQUIRED | REJECTED`.

Certification is per **capability**, not merely per product.

## Common test classes

Authentication/session persistence; read; write; happy path; invalid input; idempotency; timeout; retry; unknown effect; reconciliation; disconnect/recovery; concurrency; observability; security; upgrade/regression.

For each capability, the owner fixes the test account/environment, integration version, representative load, acceptance/failure cases and observable artifacts *before* the spike. Record pass/fail/inconclusive, limitations, fallback, recertification trigger and decision owner. A lab pass does not authorize a live customer, provider write, charge or supplier purchase; use the live-milestone register in `19-open-items-and-validation.md`.

## WAHA/GOWS MVP gate

Must pass core session lifecycle, restart persistence, inbound/outbound text, required media/audio, webhook dedupe, identity/LID handling, multi-session isolation, reconnect, timelock/capping handling and risk-controller degradation.

Record session-to-tenant isolation, duplicate inbound/outbound behavior and restart recovery from the pinned version; fail certification if one account's messages reach another tenant or a restriction triggers an unsafe retry loop. Document manual customer contact when outbound is unavailable.

Timelock/capping must not cause retry storms or stop healthy existing conversations. Engine switches are technical-compatibility changes and require recertification; they are not restriction-evasion mechanisms.

Before promoting live messaging, the operator must verify account/channel permission, recipient opt-in and human escalation against the current [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/). WAHA/GOWS technical certification is not approval from Meta; if the selected channel cannot support the permitted customer journey, decide a compliant alternative behind `MessagingGateway` instead of switching engines to evade restrictions.

## CINEVISION browser adapter gate

Read certification precedes writes. MVP semantic operations include customer/state/expiry/connection/adult/server/credit reads plus required Trial, renewal, Trust Renewal, adult toggle, connection, migration and Portal VOD actions.

Every write requires precondition, semantic action and readback/postcondition. Unknown effect enters reconciliation before retry.

Demonstrate a timed-out write with ambiguous result and a DOM change in the certified environment. If a safe readback cannot distinguish applied from unapplied, leave that write capability unvalidated and route to human review.

Provider truths to regression-test:

- Trial only 1h/3h/6h;
- Trust Renewal exactly +3 days, only ACTIVE with <=3 days remaining;
- additional connection shares primary expiration;
- normal cancellation remains active until paid period end.

## MK Ativador gate

Authenticated Browser Worker for private balance/purchase/activation. Catalog synchronization retains snapshots/diffs. Paid app acquisition follows trial/test + customer payment before purchase. Unknown purchase effect reconciles before another supplier charge.

## Asaas gate

Official sandbox first, then controlled production canary. Validate PIX lifecycle, chosen card/boleto paths if enabled, webhook authentication, duplicate delivery/idempotency, delayed/reordered events, reconciliation and refund flow. Refund application command remains HITL.

Fail certification if duplicate/reordered notifications produce duplicate ledger postings, settlement or entitlements. Record reconciliation against provider truth and reversal evidence before promoting the real-charge path.

## Hatchet gate

Prove crash recovery, wait-for-event/lookback, human review, cancellation/supersede, retry policies, tenant fairness/shared concurrency, provider-down bulkheads and operational observability.

Record post-crash restart and replay evidence for the same business effect, a noisy-tenant scenario and a provider-down scenario; if fairness/isolation cannot be shown, retain the fallback decision and do not promote dependent workflows.

Include cold-engine startup with interleaved tenant/group concurrency and combined parent/task limits in the pinned-version experiment. An [open Hatchet concurrency issue](https://github.com/hatchet-dev/hatchet/issues/4778) reports over-admission in a SQL scheduling path; test the actual configuration and do not assume a warm-engine pass proves the limit.

## Agent Harness gate

Prove specialists-as-tools, serializable HITL resume, policy/tool boundaries, model fallback, loop/cost budgets, prompt injection resistance, tenant isolation and business-weighted eval uplift versus minimal tool-loop baseline.

Declare the comparison fixture and release thresholds before benchmarking. Critical cross-tenant, refund, provider and financial-duplication invariants require full deterministic/eval-fixture pass. If quality uplift is inconclusive or the harness violates a critical invariant, do not promote automatic customer actions; retain manual/shadow operation and decide a bounded fallback.

## Full-system certification

Required golden/failure journeys are defined in `14-e2e-acceptance-matrix.md`.
