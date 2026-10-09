# P3 — Integrations (code + register; no live calls)

> Status: **SOFTWARE-VERIFIED / LIVE-BLOCKED** (2026-10-08, branch `closure/p3-integrations`, TASK_ID `CODER-P3`)
> Reconciliation 2026-10-09 (branch `closure/p8-p5-evidence-20261009`, TASK_ID `IPTV-P8-STATUS-RECONCILIATION`, docs-only): the operator live evidence of 2026-10-08 is now incorporated into the Asaas rows (**B1 PARTIAL**) and the WAHA rows (**M1 PARTIAL live; M2 NOT executed**). Nothing promoted: no new status, no certification; P3 stays **LIVE-BLOCKED**.
> Rule: **zero external calls, zero secrets in files.** Every PASS below is code/synthetic
> (mocked fetch, local stubs, existing suites). Nothing here promotes any row of
> `docs/10-operations/integrations-capability-status.md` beyond its honest status —
> only operator-recorded live evidence promotes.
> Authority: this directory **complements** `docs/15-implementation-baseline/` and does not
> replace it. In conflict, the baseline wins.
> Evidence: `evidence/p3-asaas-sandbox/report.md`, `evidence/p3-waha/report.md`,
> `evidence/p3-hatchet/report.md` + operator live evidence 2026-10-08:
> `evidence/p3-asaas-sandbox/live-b1.md`,
> `evidence/p3-asaas-sandbox/live-refund-pix-exec.md`,
> `evidence/p3-waha/m1-live.md`, `evidence/p3-waha/m2-drill.md`.

## What changed in this slice

- `RealAsaasAdapter.createPixCharge` now accepts a `providerCustomerId` binding +
  `dueDate` (`apps/api/src/billing/asaas-port.ts`): the `/payments` minimum is
  `billingType/value/dueDate/externalReference` + `customer` **only** from an explicit
  binding — never invented, never hardcoded. Without a binding the provider rejects
  (4xx → `KNOWN_NOT_APPLIED`, charge stays `PENDING`), which is the honest signal
  that gate **B1** is still pending.
- +4 mocked-fetch unit tests (2xx-with-id applies, 2xx-without-id → `UNKNOWN`,
  4xx → `KNOWN_NOT_APPLIED`, customer present in payload): **55/55 green** with the
  51 pre-existing tests; `pnpm --filter @iptv/api typecheck` green.
- Capability register rows updated with this session's verdicts (status tokens
  unchanged — no false promotion).

## Provider × gate matrix

| Provider | Implementar (code) | Sandbox (software) | Gate do operador (live — explicit authorization required) |
|---|---|---|---|
| Asaas PIX lifecycle | `RealAsaasAdapter` + customer binding (DONE this slice) | SOFTWARE-VERIFIED: 55/55 mocked units + read-only live `GET` 404→FAILED (P3B); first live lifecycle PARTIAL 2026-10-08 (B1 — see gate column) | **B1 — PARTIAL (live 2026-10-08, `evidence/p3-asaas-sandbox/live-b1.md`), NOT closed and NOT certified**: done live = disposable sandbox customer + 1× discardable PIX charge + `receiveInCash` + readback PAID (`RECEIVED_IN_CASH`) + cleanup (zero residue). `receiveInCash` is NOT faithful PIX settlement; "duplicate webhook"/reconcile were disposable-PostgreSQL integration tests (16/16 + unit 55/55), NOT live provider webhook delivery; live refund attempts were refused by the Sandbox provider — the `receiveInCash` charge refund got 400 `invalid_object` ("Somente é possível estornar cobranças recebidas ou confirmadas"; `evidence/p3-asaas-sandbox/live-b1.md`) and the cash-received PIX charge refund (`evidence/p3-asaas-sandbox/live-refund-pix-exec.md`) was refused too → `KNOWN_NOT_APPLIED` (provider refund object 404 — nothing applied); no successful refund is demonstrated, and refund behavior after faithful PIX settlement is untested (G1). Remaining: **G1** (faithful PIX settlement via sandbox dashboard), **G2** (live Asaas→us webhook delivery — needs public URL/tunnel), **G3** (dedicated reorder test). **B2**: `TEST_DATABASE_URL` (empty, disposable) for the integration re-run — primary `test:` citations re-executed in the 2026-10-09 software re-run (`docs/16-pilot-closure/P5-RELEASE-E2E.md`; `evidence:` files are historical and were NOT re-executed). Live maps to **M4/M5** (`19-open-items-and-validation.md:25`). |
| Asaas webhook/settle | Per-channel auth, dedupe, idempotent confirm (existing) | SOFTWARE-VERIFIED: code + existing integration (401/dedupe/defer paths) | Same Asaas gate as above — still open: duplicate/reordered/delayed deliveries + reconciliation + reversal evidence. Honest split (2026-10-08, `evidence/p3-asaas-sandbox/live-b1.md`): dedupe + idempotent confirm + reconcile were re-proven only against disposable PostgreSQL integration tests; NO live provider delivery observed (localhost unreachable from Sandbox → **G2**); no live refund/reversal — the only live refund attempts were on cash-received charges and were refused (`KNOWN_NOT_APPLIED`), so no `SUCCEEDED` refund is demonstrated and a refund after faithful PIX settlement (G1) is untested. |
| WAHA session/outbound/inbound | `WahaGatewayAdapter` + echo default (existing) | SOFTWARE-VERIFIED: 37 unit tests green (P3C); first live session evidence 2026-10-08 — M1 PARTIAL (see gate column) | **M1 — PARTIAL live (2026-10-08, `evidence/p3-waha/m1-live.md`)**: session/restart/outbound/inbound/auth/dedupe/LID/triage PASS live (session `ted`, Contabo; the inbound blocker was a 2nd WAHA instance on Hostinger, removed by the operator; webhook restored, environment returned as found). Residuals: multi-session, deep reconnect, live restriction/timelock (never provoke); media/audio still NOT implemented. **M2**: 429/cap observation + manual fallback drill — still NOT executed (`evidence/p3-waha/m2-drill.md`: procedure recorded + healthy state read live; the drill itself is an operator act). |
| WAHA media/audio/reconnect | NOT implemented (`sendText` only; no LID-distinct field) | N-A — nothing to certify | Requires M1 residual closure (multi-session, deep reconnect, live restriction never provoked — the partial M1 live evidence does NOT certify reconnect/restriction) + implementation + recertification. |
| Hatchet durable workflows | `LocalWorkflowAdapter` default (honest non-durable); PR #39 makes Hatchet construction-only enqueue fail-closed but does not integrate SDK/worker | N-A — 9/9 LIVE-BLOCKED: no configured/authorized instance; P2C's package/env assumptions were stale | Official docs/research 2026-10-09: published SDK is `@hatchet-dev/typescript-sdk` (not `@hatchet-dev/hatchet`, registry 404); documented client env is `HATCHET_CLIENT_TOKEN` plus `HATCHET_CLIENT_HOST_PORT` / `HATCHET_CLIENT_API_URL` / TLS options, while current main uses `HATCHET_API_TOKEN`/`HATCHET_SERVER_URL`. Correct code wiring + producer/worker integration, instance authorization and full 9-item W0-04 gate remain. F12 stays BLOCKED; ADR-0019 keeps Hatchet chosen, Inngest only on certification failure. |
| CINEVISION reads | Existing (schemas + projection) | SOFTWARE-VERIFIED (LAB_VALIDATED 2026-10-05 pass, unchanged) | Fase 6 **Steps 6–9** canary (full CLI re-run + panel-build pin reconciliation first). |
| CINEVISION writes | NOT implemented (no adapter — contract-before-code rule holds) | Unobserved | Fase 6 **Step 3** human-operated `POST /api/customers` observation (+ delete probe + restore count) → Steps 4–9. |
| MK Ativador | Echo/manual adapters only (existing) | Unvalidated in this environment | **G07**: supplier account/terms + controlled test purchase + unknown-effect reconciliation + explicit spending limits. |
| Infisical secrets | `packages/secrets` (existing, ADR-0014) | LAB_VALIDATED (machine-identity lab reads, unchanged) | Per-environment operator smoke (presence/length only) before any live gate references production paths. CINEVISION/MK live credentials stay in the operator vault — never repo/`.env`. |

## Live-blocked summary (nothing promoted)

- Asaas PIX-live: BLOCKED → B1 PARTIAL/not closed (live cash-receipt only; G1/G2/G3 open; tested refund attempts on cash-received charges refused — no `SUCCEEDED` demonstrated) / B2 (primary `test:` citations re-executed 2026-10-09; `evidence:` files not re-run) (→ M4/M5).
- WAHA live session/media/reconnect/restriction/fallback: BLOCKED → M1 PARTIAL live (session/restart/outbound/inbound/auth/dedupe/LID/triage PASS 2026-10-08; residuals multi-session/deep reconnect/restriction) + M2 NOT executed (manual drill = operator act).
- Hatchet durability: BLOCKED → adopt decision + 9-item gate (F12 BLOCKED).
- CINEVISION writes: BLOCKED → Step 3 observation first; reads canary → Steps 6–9.
- MK purchase: BLOCKED → G07.
- No `CERTIFIED` / `CERTIFIED_WITH_LIMITATIONS` / `DEGRADED` claim exists for any
  capability in this repository (cf. `integrations-capability-status.md` § Reading the rows).

## Refund policy — MANUAL (operator decision 2026-10-08)

Refunds are **never executed automatically**: the system records the request,
requires second-human approval (self-approval forbidden), and executes only on
explicit human decision — and the operator decision is that the money movement
itself is performed **by the user** (dashboard/API do provider), with the
system reconciling afterwards. Rationale, proven live in Sandbox
(`evidence/p3-asaas-sandbox/live-refund-*.md`; the two live refund refusals
are in `evidence/p3-asaas-sandbox/live-b1.md` and
`evidence/p3-asaas-sandbox/live-refund-pix-exec.md`): the full governance
path (request→review→approve→execute→reconcile, stale/self-approval
rejections, over-refund rejection, `KNOWN_NOT_APPLIED` with zero false
ledger) is green. What the live evidence proves about refunds is narrow: the
tested refund attempt on a `receiveInCash` charge was refused (400
`invalid_object`, "Somente é possível estornar cobranças recebidas ou
confirmadas" — a cash-receipt does not qualify), and the second live attempt,
on a cash-received PIX charge, was refused as well (`KNOWN_NOT_APPLIED`,
provider refund object 404 — nothing applied). `receiveInCash` is not faithful
PIX settlement, so neither attempt tested a refund after real PIX settlement:
that behavior, and the sandbox `SUCCEEDED` demonstration itself, remain
unverified and open under **G1** (dashboard-simulated PIX settlement) — this
evidence does NOT establish a general Sandbox refusal of PIX refunds. No
successful refund (`SUCCEEDED` / `KNOWN_APPLIED`) has been demonstrated in
Sandbox. The manual policy above is unchanged, no refund promotion is
claimed, and the production canary (M4/M5) still requires explicit
authorization.
