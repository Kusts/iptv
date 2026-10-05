# Live Integration Certification Plan

> **SUPERSEDED — não use este arquivo como referência canônica.** Duplicata histórica preservada apenas por compatibilidade de links antigos. A versão canônica e mantida é [`docs/15-implementation-baseline/10-integrations-certification.md`](../15-implementation-baseline/10-integrations-certification.md), que contém os blockers W0-09 e o procedimento operacional completo da Fase 6 (canary live ainda **não executado**). Para o status de implementação das Fases 0–5 do CINEVISION, consulte o SPEC/PLAN [`cinevision-runtime-hardening.md`](../04-specs/integrations/cinevision-runtime-hardening.md). Esta cópia não tem os blockers W0-09, o procedimento de canary nem as atualizações datadas; em caso de divergência, os canônicos prevalecem.

## Certification states

`UNVALIDATED → LAB_VALIDATED → CANARY_VALIDATED → CERTIFIED`

Side states: `CERTIFIED_WITH_LIMITATIONS | DEGRADED | RECERTIFICATION_REQUIRED | REJECTED`.

Certification is per **capability**, not merely per product.

## Common test classes

Authentication/session persistence; read; write; happy path; invalid input; idempotency; timeout; retry; unknown effect; reconciliation; disconnect/recovery; concurrency; observability; security; upgrade/regression.

## WAHA/GOWS MVP gate

Must pass core session lifecycle, restart persistence, inbound/outbound text, required media/audio, webhook dedupe, identity/LID handling, multi-session isolation, reconnect, timelock/capping handling and risk-controller degradation.

Timelock/capping must not cause retry storms or stop healthy existing conversations. Engine switches are technical-compatibility changes and require recertification; they are not restriction-evasion mechanisms.

## CINEVISION browser adapter gate

Read certification precedes writes. MVP semantic operations include customer/state/expiry/connection/adult/server/credit reads plus required Trial, renewal, Trust Renewal, adult toggle, connection, migration and Portal VOD actions.

Every write requires precondition, semantic action and readback/postcondition. Unknown effect enters reconciliation before retry.

Provider truths to regression-test:

- Trial only 1h/3h/6h;
- Trust Renewal exactly +3 days, only ACTIVE with <=3 days remaining;
- additional connection shares primary expiration;
- normal cancellation remains active until paid period end.

## MK Ativador gate

Authenticated Browser Worker for private balance/purchase/activation. Catalog synchronization retains snapshots/diffs. Paid app acquisition follows trial/test + customer payment before purchase. Unknown purchase effect reconciles before another supplier charge.

## Asaas gate

Official sandbox first, then controlled production canary. Validate PIX lifecycle, chosen card/boleto paths if enabled, webhook authentication, duplicate delivery/idempotency, delayed/reordered events, reconciliation and refund flow. Refund application command remains HITL.

## Hatchet gate

Prove crash recovery, wait-for-event/lookback, human review, cancellation/supersede, retry policies, tenant fairness/shared concurrency, provider-down bulkheads and operational observability.

## Agent Harness gate

Prove specialists-as-tools, serializable HITL resume, policy/tool boundaries, model fallback, loop/cost budgets, prompt injection resistance, tenant isolation and business-weighted eval uplift versus minimal tool-loop baseline.

## Full-system certification

Required golden/failure journeys are defined in `14-e2e-acceptance-matrix.md`.


## WAHA-specific authority

WAHA/GOWS is the selected implementation candidate. Evolution/WPPConnect are no longer the active validation path; they may only be revisited as alternate adapters if evidence requires.
