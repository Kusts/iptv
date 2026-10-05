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

### 2026-10-01 — runtime hardening baseline (HISTÓRICO — snapshot datado, NÃO é o estado atual do runtime)

> Leitura correta desta seção: ela registra o que era verdade **naquele dia** e é mantida como trilha histórica do gate. Para o estado vigente do runtime leia as seções datadas posteriores (2026-10-02 e a atualização 2026-10-05) e o SPEC/PLAN `cinevision-runtime-hardening.md` — que registram o dispatcher durável (Fase 3) e o caminho real de `CREATE_TRIAL` (Fase 5) entregues em software depois deste baseline. Em particular, a frase "durable post-commit dispatch still does not exist" abaixo descreve o baseline de 2026-10-01 e **foi superada**: o dispatcher durável existe em código e testes, mas continua **não executado contra o painel real**, e a certificação live permanece pendente em todos os gates (Steps 1-6 e campos de evidência abaixo). Nada aqui foi promovido a certificado.

The [CINEVISION Provider Runtime Hardening](../04-specs/integrations/cinevision-runtime-hardening.md) SPEC+PLAN is canonical for this gate. Landed: fail-closed `provider.cinevision` capability fixture (migration `202610010000_044`, `UNAVAILABLE`/`UNCERTIFIED`; runtime gate forces MANUAL) and Browser Worker readback modules for the observed internal API reads (contract-tested, not yet wired to the CLI, not live certified). Durable post-commit dispatch still does not exist; writes remain blocked. Certification vocabulary authority: runtime enums `UNCERTIFIED | SANDBOX_CERTIFIED | CERTIFIED` (the ladder above stays plan-level until reconciled).

### 2026-10-02 — closure round + Fase 6 canary procedure (operator-run; NO live evidence yet)

Closure state: CI green (path-semantics fix in the browser-worker profile isolation tests; ubuntu-latest now validates Windows deployment paths via explicit `pathSemantics`), API hardening FIX4-N5 landed (reconcile may only re-arm a trial from a readback anchored by a persisted `external_ref`; anchorless uncertainty converges `HUMAN_REQUIRED`). Review round added a RUNTIME BOUNDARY: `resolveWorkerConfig`/`defaultProfileRoot` fail closed when the profile-root namespace does not match the host platform (on posix a windows path is a relative filename to the native fs and could land inside the checkout); pure cross-host policy validation remains available for tests. No live CINEVISION credentials or session were available in this round — no evidence was fabricated and nothing was marked certified. Worker remains GET-only; the `createTrial` real write stays gated.

Agreed execution order (2026-10-02 operator decision): the closure-round LOW findings did NOT trigger another engineering round before Fase 6; at that point they were registered as post-certification hardening backlog in `19-open-items-and-validation.md`. Since then, both engineering items have been implemented (HITL surfacing and production `PROVIDER_DISPATCH_MODE` fail-fast; see the dated updates below and the canonical open-items register). Their implementation does NOT change a certification gate: gates change ONLY in the final step below, after every evidence field is filled from live observation. Additionally: NO disposable CINEVISION panel account exists (2026-10-02 operator decision) — the canary runs against the operator's MAIN panel account as the designated account, with the compensating controls and cleanup step below; the account-level fence in code is unchanged.

Update 2026-10-05 (engineering only, no live evidence): BOTH post-certification hardening items are CLOSED in software, with regression coverage added: `provider_operation` surfaces own-tenant `HUMAN_REQUIRED` operations in the HITL center only for `provider.operation.read` (minimal projection; no provider payload/raw error; `support.ticket.read` was NOT widened), and production boot rejects any `PROVIDER_DISPATCH_MODE` other than exact `durable` while development/test behavior is unchanged. The focused config/provider unit tests, HITL policy unit tests and web tests passed; the new PostgreSQL API integration tests were NOT executed in this pass because no verified disposable EMPTY `TEST_DATABASE_URL` was available. These engineering closures are NOT certification: no live CINEVISION evidence was produced, nothing here is marked certified, and every live gate below (Steps 1-6 and the evidence fields) remains exactly as written.

#### Update 2026-10-05 (partial Step-2 READ evidence, GET-only; nothing promoted)

A later read-only pass on the same date produced the first live CINEVISION evidence of this gate. It extends — and partially corrects — the "no live evidence" sentence in the paragraph above; the engineering-only status of that paragraph stands, and NO gate below changed.

- What was executed: **authenticated GET reads only**. `GET /api/auth/me` and `GET /api/customers?perPage=25&page=1` both returned HTTP 200 JSON. No POST/DELETE, no trial, no gate flip, no drain — **no write of any kind was performed**.
- Panel build: the dashboard displayed `v3.94`. Recorded as an **unverified compatibility-pin candidate** only; the registered pin remains the 2026-09-30 observation (`v3.93`). Step 1 records a candidate only and does NOT change the pin. Change the pin only after the version/build is corroborated from explicit footer or bundle evidence and the compatibility record is reconciled in Fase 19; this dashboard observation alone is insufficient. No domain rule depends on the number.
- Customers read: pagination `total = 18`, 18 rows on the first page; `is_trial` distribution `YES: 7` / `NO: 11`. The current build therefore serializes `is_trial` as an **exact uppercase enum**, which the read validators in `apps/browser-worker/src/providers/cinevision/schemas.ts` previously rejected (they accepted only `"true"`/`"false"`).
- Local correction: `normalizeIsTrial` now also accepts the exact `"YES"`/`"NO"` representations (keeping `"true"`/`"false"`), still fail-closed for lowercase `"yes"`/`"no"`, `1`/`0`, booleans, whitespace-padded or any other value. Regression coverage was added in `apps/browser-worker/test/cinevision/schemas.test.ts` for `normalizeIsTrial`, `parseCustomer`, `parseCustomerPage` and `parsePackagePriceList`. This is **representation normalization, not capability certification** — Step 2 of the procedure requires exactly this validator update + re-run loop, and it happened here only for the field observed.
- Data handling: **no customer identifiers or PII were retained** — no id, username, e-mail, phone, credential, token or raw payload. Only HTTP status, response shape and the aggregate distribution above were kept; the account-specific identity/credit values returned by `/api/auth/me` are deliberately not recorded anywhere.
- Additional read validation (2026-10-05, GET-only): all 11 read-operation contracts were checked across 8 underlying GET paths using the compiled `fetchProjectedInPage` plus the existing schema parsers (`schemas.ts`) in the authenticated Chrome session; every response was HTTP 200 and parsed successfully. Identity/credit share one identity read; customer status/connections are pure derivatives of the validated customer-detail read. This validates observed response shapes, but is **not** the 11-command CLI/profile E2E or its identity/session fencing/reauth lifecycle, and that smoke remains pending. The create-form was not opened and the Step 3 contract-probe write was not started. No customer identifiers/PII/raw body were retained; no POST/DELETE/trial/gate/drain ran. Nothing here certifies or promotes a capability; all capability certification states remain unchanged and **no staging DB / canary readiness is claimed**.

#### Fase 6 canary — exact operator procedure (run only against the designated account)

Prerequisites (all mandatory, fail-closed if missing):

1. W0-09 unblock path resolved (rested/clean IP + interactive challenge solved inside the bounded window, or real-Chrome channel, or a different network); the operator then obtains a legitimate panel session manually. Re-run the read-identity CLI probe first and require JSON (a 403 HTML challenge aborts the procedure).
2. Designated account: no disposable panel account exists, so `PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID` names the operator's MAIN CINEVISION account (ACTIVE) — env name kept for compatibility; semantics: the designated canary account. The fence is unchanged in code: only that account may receive the real trial dispatch. Compensating controls: account balance and any plan/charge page noted BEFORE the canary; the canary customer is identifiable by its readback external id (plus an explicit `canary-fase6` username marker in the payload when the wired adapter allows it), deleted from the panel in the cleanup step, and the trial self-expires in ≤6h if deletion is ever missed.
3. `provider.cinevision.trial` capability flipped `AVAILABLE` ONLY for the canary window (migration/seed path records the event), reverted immediately after; the row stays `UNCERTIFIED` until the final step. Record the state of BOTH gate rows before the flip — the global `provider.cinevision` row (migration 044, read by the domain seams) and the per-action `provider.cinevision.trial` row (migration 046, the strict per-action gate).
4. `PROVIDER_DISPATCH_MODE=durable` (the dispatcher is the only certified executor), a **dedicated staging database** reserved for this canary, and API logs captured to file. Keep `API_SCHEDULER_ENABLED=0`; stop other producers/operators from submitting provider work during the window. Because the admin `drain` endpoint is tenant-agnostic, verify before opening the gate that the staging database has no other dispatcher-eligible provider operations; if any exist, STOP and isolate/resolve them before the canary.

Step 1 — operator session + panel build registration:

- With the unblocked session confirmed by the read-identity probe (JSON), record the observed panel version/build as a candidate and preserve its evidence source (footer or bundle metadata). Step 1 does not change the registered pin; verification and compatibility-record reconciliation are separate Fase 19 work.

Step 2 — revalidate the current reads (GET-only, no write):

- Run the read-only CLI subcommands (kebab-case: `read-identity`, `read-credit-balance`, `list-customers`, `read-customer`, `read-customer-status`, `read-connections`, `list-servers`, `read-server-status`, `list-package-prices`, `read-live-connections`, `list-integrations`) against the live panel and record the JSON evidence.
- Compare observed payloads against the read validators in `apps/browser-worker/src/providers/cinevision/schemas.ts`. Any drift ⇒ STOP, update validators + contract tests first, re-run the suite. This is also the live evidence the Fase 1/2 readers still lack; gate promotion remains deferred to the final step.

Step 3 — observe the real `POST /api/customers` contract (manual, human-operated session):

- In the browser devtools, create exactly ONE temporary contract-probe customer through the panel UI, with a `probe-fase6-contract-…` marker when the UI permits it. Record: request method, exact endpoint path, request headers (REDACT `Authorization`/`Cookie` — record only their presence and shape), full body schema (field names, types, required/optional, server-side defaults), response schema and status, and the resulting external customer id. This is the separate probe write; the only other authorized write is the single trial canary in Step 6.
- Immediately after capturing the contract, delete exactly that probe customer by its recorded external id in the panel UI. Re-read the customer list and verify both that the probe is absent and the count is back to its pre-probe value. If deletion/count restoration cannot be confirmed, STOP before Step 4 and the canary; record the limitation and do not treat the main-account canary as a substitute cleanup.
- Known baseline BEFORE this step: the W1 dossier (`docs/11-research/cinevision-api-investigation-2026-09-30.md`) lists the body fields as OBSERVED/frontend-sourced with the response schema `unknown` and the runtime path UNCONFIRMED. `schemas.ts` pins READ contracts only — the write contract does not exist in code yet; this observation is what lands it.

Step 4 — compare the real contract against the expected one, field-by-field:

- Observed method/path/headers/body/response vs the W1 dossier fields and the read-validator conventions. Any drift, or a response shape that contradicts the readback assumptions ⇒ STOP, update schemas + contract tests first, re-run the suite, then resume at Step 5.

Step 5 — real executor wiring (engineering gate BEFORE the canary):

- TODAY the API runtime resolves only `echo`/`manual` ops ports (`adapterNameFromEnv`/`resolveOpsPort`) and defaults the trial readback to `StubTrialReadback` (fail-closed INCONCLUSIVE): a secret-required `trial.provision` dispatched in this state parks `HUMAN_REQUIRED` by design. The canary therefore requires that the Step 3/4 observed write contract first be implemented as the real port adapter plus the real trial readback, contract-tested and wired into the runtime registration — replacing the synthetic defaults ONLY for the real branch, never by relaxing provenance enforcement.
- Record the wiring commit/PR and its test evidence before proceeding. If the real executor is not wired, STOP — do not run the canary against a synthetic port.

Step 6 — controlled canary trial (single operation):

- Record the panel customer count as the pre-canary baseline only AFTER Step 3's temporary probe customer has been deleted and the count restored to its pre-probe value.
- The trial customer IS the canary customer: record its panel username marker (`canary-fase6-…`) when the payload carries one, and its external id from the readback — the cleanup step deletes exactly this entry.
- Submit exactly ONE `trial.provision` through the isolated staging API against the designated account. Before draining, use a read-only query with the dispatcher's eligibility predicate to verify that the canary operation is the **only** eligible row in the entire staging database (expected operation id, tenant, account and action); any extra row or concurrent submission ⇒ STOP, do not drain. Then call the platform-admin `POST /v1/admin/provider-dispatch/drain` with `{ "limit": 1 }` and require the response to claim exactly that expected operation id (`claimed === 1`, `operationIds === [expectedId]`); any mismatch ⇒ STOP, no retry. Run `/reconcile` only for that canary operation; `/recover` is only for an actually abandoned lease. Do not run scheduled drains during this window.
- Record, per operation: provider result outcome, readback snapshot (customer found? trial flag? expiration observed?), postcondition verdict, and the financial effect (account balance before/after, any charge line created — expected: none for a trial). A bare HTTP 200 must never terminalize the operation.

Step 7 — confirm postconditions and internal state (readback + PostgreSQL):

- Readback: external customer id, `is_trial`, and the observed expiration beating the locally computed `expires_at`.
- PostgreSQL evidence: `provider.provider_bindings` row for the trial (`entity_type='trial'`, `external_id`, `status='ACTIVE'`, metadata postcondition satisfied), `trial.trials.provider_binding_id` set, `trial.trials.lifecycle_status='ACTIVE'`, `trial.trials.expires_at` matching the observed value, and the `provider.provider_operations` row `SUCCEEDED` with `effect_certainty='KNOWN_APPLIED'` (attempt row `SUCCEEDED`).

Step 8 — idempotency evidence (no duplicate customer/trial may exist):

- Replay the same `trial-provision:{trialId}` intent (409 expected); attempt a second provision for the same trial after `SUCCEEDED` (must be refused); confirm panel-side via a customer list read that exactly ONE additional customer exists versus the pre-canary baseline, attributable to the canary operation.

Step 9 — uncertainty drill (only if it can be done without a second real write):

- Induce one timeout/UNKNOWN (e.g., command budget below the panel's response time) and verify the operation parks `VERIFYING/UNKNOWN`, reconcile converges `HUMAN_REQUIRED`, and NO second POST is sent (worker/proxy request count must stay at 1).
- Note: resolving a parked operation remains manual (`POST /v1/provider/operations/:id/resolve`); the HITL center now lists parked operations as a read-only `provider_operation` source for callers with `provider.operation.read`, which surfaces them without adding any resolve control and without changing this step.

Cleanup step — mandatory gate before certification changes or ending the canary window. Do not stop the cleanup sequence after an earlier substep fails: still close the capability window and complete all other safe cleanup before stopping.

- Delete the canary customer from the panel (UI, by its recorded external id / `canary-fase6` marker) and confirm via a customer list read that it is absent and the count is back to the pre-canary baseline.
- Re-check the account balance/charge page: still no charge line attributable to the canary.
- Revert the `provider.cinevision.trial` flip immediately after the final read-only/drill operations (records the event) and verify the row is back to its pre-window availability/certification state, even if customer deletion or another cleanup check failed.
- If deletion, absence, baseline count, no-charge check, or gate reversion cannot be confirmed, STOP: do not promote any capability or mark certification complete. Record the unresolved cleanup; the natural ≤6h trial expiry is only a last-resort safety net, never a substitute for cleanup evidence.

Final step — certification gate changes, only now:

- Only after every evidence field below is filled from live observation, the panel version/build is corroborated from its recorded footer/bundle source and reconciled into the compatibility record (Fase 19), the queue-isolation/drain postcondition is proven, and the mandatory cleanup step is fully confirmed may certification gates change: the write capability leaves `UNCERTIFIED` (runtime enums `UNCERTIFIED | SANDBOX_CERTIFIED | CERTIFIED` are the vocabulary authority; the plan ladder at the top of this file stays plan-level until the Fase 19 reconciliation) and Step 2 read evidence is recorded for read-capability promotion. Cleanup failure always blocks promotion. If Step 9 could not be executed without a second real write, record `UNKNOWN drill: not executed (<reason>)` as an explicit limitation — promotion is then capped at `SANDBOX_CERTIFIED`, with the drill as the recorded recertification trigger before `CERTIFIED`. Any systemic challenge/bad-response/drift/unknown/postcondition-mismatch pattern ⇒ abort to `DEGRADED` + manual, per SPEC Fase 6, and nothing is promoted.

Evidence template (fill every field, attach raw captures without secrets):

- panel version/build observed: ____
- read revalidation evidence (Step 2 commands + JSON): ____
- Step 3 probe customer external id + deletion/readback/count-restoration evidence: ____
- request method + endpoint: ____
- headers (shapes only, no values): ____
- body schema (customer) vs W1 dossier: ____
- response schema + status: ____
- observed effects (customer/trial created): ____
- external customer id: ____
- trial flag + expiration observed in readback: ____
- readback verdict + postconditions: ____
- provider_bindings row + trial.provider_binding_id (PostgreSQL): ____
- trial lifecycle_status + expires_at (local vs observed): ____
- provider_operations final state + effect_certainty: ____
- financial effect (balance before/after): ____
- pre-canary panel customer baseline (after confirmed Step 3 probe cleanup): ____
- idempotency evidence (replay 409 / post-SUCCEEDED refusal / one additional customer vs baseline): ____
- UNKNOWN drill result (park → reconcile → HUMAN_REQUIRED, single send) or recorded limitation: ____
- cleanup (canary customer deleted, count back to baseline, balance re-checked, gate flip reverted): ____

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
