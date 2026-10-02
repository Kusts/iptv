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

### W0-09 status — 2026-09-30 (LAB, partially proven; live read blocked)

Environment: operator Windows host, Playwright bundled Chromium (headed), isolated persistent profile per tenant/account (`%LOCALAPPDATA%\iptv\browser-worker\profiles`), panel `https://cinevision.panelbr.site` (Sigma v3.92 family), credentials in Infisical `dev` `/browser-worker/*` via dedicated read-only machine identity (`viewer`; write probed and denied with 403).

Proven in this environment:

- isolated bootstrap: origin allowlist (HTTPS, exact match), SSRF guard, single-POST login window bound to the main frame, profile lock, zero raw secret/URL in outputs (62 unit tests + 2 security review rounds);
- secrets resolved inside the worker process only, via a dedicated Infisical identity (never the API identity);
- real login submitted against the live panel (`POST /api/auth/login` discovered from the panel bundle); session token is a Bearer string in `localStorage.token` (not cookies) — readback therefore runs an in-page same-origin `fetch` with that token.

Blocked (live read evidence not yet obtained):

- Cloudflare on `cinevision.panelbr.site` now serves an interstitial loop ("Um momento…") to automated browsers from this IP; recent runs never presented an interactive checkbox, so operator-assisted solving did not clear it, and the post-login `/api/auth/me` was answered with a 403 HTML challenge instead of JSON. This is IP/automation reputation, not a code defect; attempts from this state are rate-limited by design and must cool down.

Fixes already landed from live evidence (do not regress): challenge titles are locale-specific (`Um momento…` pt-BR included); a managed interstitial gets a bounded wait (`BROWSER_WORKER_CHALLENGE_WAIT_SECONDS`, default 45s) before fail-closed `HUMAN_REQUIRED/CHALLENGE_DETECTED`; embedded Turnstile login widgets are not treated as interstitials; readback uses the in-page session Bearer, never `context.request` without credentials.

Unblock paths (any one, then re-run the read-identity probe): operator re-runs the CLI from a rested/clean IP and solves the interactive challenge inside the bounded wait window; or add real-Chrome channel support (`BROWSER_WORKER_BROWSER_CHANNEL`) for a stronger fingerprint; or certify from a different network.

Writes (W0-10) remain rejected regardless of this read gate: durable post-commit dispatch and certified conclusive readback are prerequisites, and neither exists.

### 2026-10-01 — runtime hardening baseline

The [CINEVISION Provider Runtime Hardening](../04-specs/integrations/cinevision-runtime-hardening.md) SPEC+PLAN is canonical for this gate. Landed: fail-closed `provider.cinevision` capability fixture (migration `202610010000_044`, `UNAVAILABLE`/`UNCERTIFIED`; runtime gate forces MANUAL) and Browser Worker readback modules for the observed internal API reads (contract-tested, not yet wired to the CLI, not live certified). Durable post-commit dispatch still does not exist; writes remain blocked. Certification vocabulary authority: runtime enums `UNCERTIFIED | SANDBOX_CERTIFIED | CERTIFIED` (the ladder above stays plan-level until reconciled).

### 2026-10-02 — closure round + Fase 6 canary procedure (operator-run; NO live evidence yet)

Closure state: CI green (path-semantics fix in the browser-worker profile isolation tests; ubuntu-latest now validates Windows deployment paths via explicit `pathSemantics`), API hardening FIX4-N5 landed (reconcile may only re-arm a trial from a readback anchored by a persisted `external_ref`; anchorless uncertainty converges `HUMAN_REQUIRED`). Review round added a RUNTIME BOUNDARY: `resolveWorkerConfig`/`defaultProfileRoot` fail closed when the profile-root namespace does not match the host platform (on posix a windows path is a relative filename to the native fs and could land inside the checkout); pure cross-host policy validation remains available for tests. No live CINEVISION credentials or session were available in this round — no evidence was fabricated and nothing was marked certified. Worker remains GET-only; the `createTrial` real write stays gated.

#### Fase 6 canary — exact operator procedure (run only on the disposable account)

Prerequisites (all mandatory, fail-closed if missing):

1. W0-09 unblock path resolved (rested/clean IP + interactive challenge solved inside the bounded window, or real-Chrome channel, or a different network); re-run the read-identity CLI probe first and require JSON (a 403 HTML challenge aborts the procedure).
2. Disposable CINEVISION account designated: `PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID` pointing at an ACTIVE account of the test tenant; the account balance and any plan/charge page noted BEFORE the canary.
3. `provider.cinevision.trial` capability flipped `AVAILABLE` ONLY for the canary window (migration/seed path records the event), reverted immediately after.
4. `PROVIDER_DISPATCH_MODE=durable` (the dispatcher is the only certified executor), fresh `TEST_DATABASE_URL`-equivalent staging DB, API logs captured to file.

Step 1 — revalidate the `POST /api/customers` contract (observed against the live panel, disposable account):

- In the browser devtools (manual, human-operated session), create one customer through the panel UI and record: observed panel version/build (footer or bundle version), request method, exact endpoint path, request headers (REDACT `Authorization`/`Cookie` — record only their presence and shape), full body schema (field names, types, required/optional, server-side defaults), response schema and status, and the resulting external customer id.
- Compare field-by-field against `apps/browser-worker/src/providers/cinevision/schemas.ts` + the W1 dossier. Any drift ⇒ STOP, update schemas + contract tests first, re-run the suite.

Step 2 — controlled canary trial (single operation):

- Trigger exactly ONE `trial.provision` through the staging API against the disposable account; watch the dispatcher drain it (admin `POST /v1/admin/provider-dispatch/drain` then `/reconcile`).
- Record, per operation: provider result outcome, readback snapshot (customer found? trial flag? expiration observed), postcondition verdict, binding external id, and the trial's internal state (`ACTIVE` requires conclusive readback + satisfied postconditions — a bare HTTP 200 must never terminalize).
- Record financial effect: account balance before/after, any charge line created (expected: none for a trial).
- Idempotency evidence: replay the same `trial-provision:{trialId}` intent (409 expected); attempt a second provision for the same trial after `SUCCEEDED` (must be refused; no second panel-side trial).

Step 3 — uncertainty drill (only if it can be done without a second real write):

- Induce one timeout/UNKNOWN (e.g., command budget below the panel's response time) and verify the operation parks `VERIFYING/UNKNOWN`, reconcile converges `HUMAN_REQUIRED`, and NO second POST is sent (worker/proxy request count must stay at 1).

Evidence template (fill every field, attach raw captures without secrets):

- panel version/build observed: ____
- request method + endpoint: ____
- headers (shapes only, no values): ____
- body schema (customer): ____
- response schema + status: ____
- observed effects (customer/trial created): ____
- external customer id: ____
- trial flag + expiration observed in readback: ____
- readback verdict + postconditions: ____
- financial effect (balance before/after): ____
- idempotency evidence (replay 409 / post-SUCCEEDED refusal): ____
- UNKNOWN drill result (park → reconcile → HITL, single send): ____

Certification: only after every field above is filled from live observation AND the panel version is recorded as the new compatibility pin may the write capability leave `UNCERTIFIED`. Any systemic challenge/bad-response/drift/unknown/postcondition-mismatch pattern ⇒ abort to `DEGRADED` + manual, per SPEC Fase 6.

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
