# P3 — Integrations (code + register; no live calls)

> Status: **SOFTWARE-VERIFIED / LIVE-BLOCKED** (2026-10-08, branch `closure/p3-integrations`, TASK_ID `CODER-P3`)
> Rule: **zero external calls, zero secrets in files.** Every PASS below is code/synthetic
> (mocked fetch, local stubs, existing suites). Nothing here promotes any row of
> `docs/10-operations/integrations-capability-status.md` beyond its honest status —
> only operator-recorded live evidence promotes.
> Authority: this directory **complements** `docs/15-implementation-baseline/` and does not
> replace it. In conflict, the baseline wins.
> Evidence: `evidence/p3-asaas-sandbox/report.md`, `evidence/p3-waha/report.md`,
> `evidence/p3-hatchet/report.md`.

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
| Asaas PIX lifecycle | `RealAsaasAdapter` + customer binding (DONE this slice) | SOFTWARE-VERIFIED: 55/55 mocked units + read-only live `GET` 404→FAILED (P3B) | **B1**: disposable sandbox customer + 1× discardable create + dashboard-simulated payment + webhook PAID + reconcile vs truth + live refund + cleanup. **B2**: `TEST_DATABASE_URL` (empty, disposable) for the integration re-run. Live maps to **M4/M5** (`19-open-items-and-validation.md:25`). |
| Asaas webhook/settle | Per-channel auth, dedupe, idempotent confirm (existing) | SOFTWARE-VERIFIED: code + existing integration (401/dedupe/defer paths) | Same Asaas gate as above (duplicate/reordered/delayed deliveries + reconciliation + reversal evidence). |
| WAHA session/outbound/inbound | `WahaGatewayAdapter` + echo default (existing) | SOFTWARE-VERIFIED: 37 unit tests green, zero live calls (P3C) | **M1**: designated sandbox session + opt-in recipient + 1× synthetic text/inbound/dedupe (+ media only if implemented). **M2**: 429/cap observation + manual fallback drill. |
| WAHA media/audio/reconnect | NOT implemented (`sendText` only; no LID-distinct field) | N-A — nothing to certify | Requires M1 + implementation + recertification. |
| Hatchet durable workflows | `LocalWorkflowAdapter` default (honest non-durable); Hatchet adapter construction-only | N-A — 9/9 LIVE-BLOCKED: `HATCHET_*` empty = absent, SDK not installed (P2C) | Adopt-vs-keep-local decision first; only then: real instance + pinned SDK + real mapping + full 9-item gate (cold-engine startup per upstream #4778, noisy-tenant, provider-down). F12 stays BLOCKED; fallback Inngest needs its own decision. |
| CINEVISION reads | Existing (schemas + projection) | SOFTWARE-VERIFIED (LAB_VALIDATED 2026-10-05 pass, unchanged) | Fase 6 **Steps 6–9** canary (full CLI re-run + panel-build pin reconciliation first). |
| CINEVISION writes | NOT implemented (no adapter — contract-before-code rule holds) | Unobserved | Fase 6 **Step 3** human-operated `POST /api/customers` observation (+ delete probe + restore count) → Steps 4–9. |
| MK Ativador | Echo/manual adapters only (existing) | Unvalidated in this environment | **G07**: supplier account/terms + controlled test purchase + unknown-effect reconciliation + explicit spending limits. |
| Infisical secrets | `packages/secrets` (existing, ADR-0014) | LAB_VALIDATED (machine-identity lab reads, unchanged) | Per-environment operator smoke (presence/length only) before any live gate references production paths. CINEVISION/MK live credentials stay in the operator vault — never repo/`.env`. |

## Live-blocked summary (nothing promoted)

- Asaas PIX-live: BLOCKED → B1/B2 (→ M4/M5).
- WAHA live session/media/reconnect/restriction/fallback: BLOCKED → M1/M2.
- Hatchet durability: BLOCKED → adopt decision + 9-item gate (F12 BLOCKED).
- CINEVISION writes: BLOCKED → Step 3 observation first; reads canary → Steps 6–9.
- MK purchase: BLOCKED → G07.
- No `CERTIFIED` / `CERTIFIED_WITH_LIMITATIONS` / `DEGRADED` claim exists for any
  capability in this repository (cf. `integrations-capability-status.md` § Reading the rows).
