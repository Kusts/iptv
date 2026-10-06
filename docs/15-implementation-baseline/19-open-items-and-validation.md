# Remaining Open Items and Validation Register

No item below blocks beginning Wave 0 in sandbox/synthetic environments unless explicitly stated. Unknowns are isolated instead of silently guessed. A gate for real customers, messages, provider writes or money may block that *live milestone* without blocking engineering work.

## Technical spikes required in Wave 0

| Item | Current decision | Promotion criterion |
|---|---|---|
| Hatchet | preferred workflow runtime | certification suite passes; otherwise evaluate Inngest fallback |
| WAHA engine | GOWS preferred | core capability certification passes |
| OpenAI Agents SDK harness | accepted primary harness | benchmark/HITL/provider abstraction proof passes |
| PostgreSQL RLS | defense-in-depth target | pooling/background-worker implementation proven without unsafe bypass patterns |

Each Wave 0 spike requires a named decision owner, pinned environment/version, predeclared acceptance/failure scenarios, observed evidence and a written fallback/limitations decision. The detailed, capability-specific cases are in `10-integrations-certification.md`; a happy-path demo is not a promotion criterion. The owner records inconclusive results as unvalidated rather than silently approving them.

## Gates before first live operation

These checks are proportional to the actual operation. Record responsible operator, evidence and the permitted environment before promotion; do not interpret this list as a claim that the current business lacks authorization.

| First live milestone | Required validation before that milestone |
|---|---|
| M1 — real customer conversation | Channel/account authorization, applicable messaging rules, customer-data handling/consent or other applicable legal basis and manual reply path |
| M2 — AI-handled conversation | M1 checks plus shadow/canary evals, human takeover, approved action boundaries and customer-facing disclosure where applicable |
| M3 — provider Trial | Authorized access to provider/test account, provider capability certification, customer-data/content/technical-access constraints and manual exception path |
| M4/M5 — real PIX and fulfilled sale | Asaas controlled production canary, account/business/payment/tax/content-rights checks applicable to the operation; implemented and verified RefundRequest → human decision → Refund/chargeback paths (including duplicate/concurrent/unknown effects), ledger and same-customer entitlement invariants. The v1.0.1 OpenAPI/DDL scaffolds define the contract but do not satisfy this gate without runtime/concurrency/provider evidence |
| G07 — real supplier purchase | MK account/supplier terms, controlled test purchase, reconciliation for unknown purchase effect and explicit spending limits |

Use synthetic/sandbox fixtures while a live gate remains unresolved; a production credential or working integration is not evidence of authorization by itself. Revisit these validations on material provider, business or jurisdiction changes.

## Live integration evidence

- CINEVISION browser semantic operations and postconditions need recertification against live panel during implementation.
- MK private purchase/balance/activation needs authenticated browser certification.
- Asaas uses official Sandbox first, production canary before final certification.
- WAHA session/restriction/media behavior requires pinned-version certification.
- Per-capability status (never a global product status; only operator-recorded evidence promotes a row): [Integrations Capability Status](../10-operations/integrations-capability-status.md).

### CINEVISION engineering items closed in software (NOT certification)

Status 2026-10-05 (engineering only; no live evidence, nothing promoted):

- **Cross-boundary `is_trial` representation divergence — CLOSED.** The
  browser-worker's read parser accepts EXACTLY `"true"|"false"|"YES"|"NO"`
  (`apps/browser-worker/src/providers/cinevision/schemas.ts`, `normalizeIsTrial`;
  the `"YES"`/`"NO"` arm is backed by the live 2026-10-05 observation: panel
  v3.94, customers `total = 18`, `is_trial` `YES: 7` / `NO: 11`), but the API
  postcondition normalizer returned `null` for `"YES"`/`"NO"` — so a real
  readback adapter forwarding the observed representation would have evaluated
  postcondition `not_trial` and fail-closed on a CORRECT trial. The normalizer
  now accepts the same two exact representations
  (`apps/api/src/trial/trial-readback.ts`, `normalizeTrialIsTrial`), keeping
  every existing rejection (no trimming, no case folding, no lowercase `"yes"`,
  no `1`/`0`, no booleans on the worker side) and the documented legacy/dev arm;
  the strict allowlist table is pinned in
  `apps/api/test/trial-readback.unit.test.ts`. This closes a representation bug
  only. It does **not** satisfy Fase 6 Step 2/3, does not license any write, and
  changes no capability row.
- **Trial readback wiring — STILL OPEN (operator/engineering, live-gated).**
  Both dispatcher seams default to `StubTrialReadback` (fail-closed
  INCONCLUSIVE): `apps/api/src/provider/provider-dispatcher.service.ts:995`
  (drain) and `:678` (reconcile). Until a real `TrialReadbackPort` is wired
  together with the real ops adapter, a SUCCEEDED secret-required
  `trial.provision` parks VERIFYING/UNKNOWN by design and no canary can run.
  The complete, point-by-point wiring list (ops-port union, `adapterNameFromEnv`
  + the zod `adapter` enums, the dispatcher's `resolvePort` mirror, the two
  readback injections, and the `adapter_version` literal that MUST NOT change)
  is now recorded in Fase 6 Step 5 of
  [Live Integration Certification](10-integrations-certification.md), so the next
  implementer needs no archaeology.
- The `POST /api/customers` write contract remains **unobserved** and marked
  `OPERATOR/LIVE EVIDENCE REQUIRED` at Fase 6 Step 3. No adapter, transport or
  contract for it exists in this repository, by design.

## CINEVISION post-Fase-6 hardening backlog (from the Fase 5 closure review)

Registered 2026-10-02 as an operator decision: the two engineering hardening items did not block the Fase 6 live canary and were intended before broad production operation. Their current status is recorded individually below; the account-isolation item remains operator/external.

Status 2026-10-05: both engineering hardening items below are CLOSED (engineering only); the CINEVISION test-subaccount/isolation item remains OPEN and requires operator/external action.

- `HUMAN_REQUIRED` provider operations were invisible to the HITL center: its
  read model aggregated only `human_review`, `comm_exception`,
  `billing_exception` and `recovery_task`, so resolution depended on technical
  polling plus the per-id `POST /v1/provider/operations/:id/resolve`. Closed by
  a fifth read-model source, `provider_operation`, in
  `apps/api/src/human-review/{center-policy.ts,human-review.controller.ts}`: it
  aggregates only `provider.provider_operations` rows of the caller's own
  tenant with exact `status = 'HUMAN_REQUIRED'` (the `tenant_id` comes from the
  authenticated request context, never from input), normalized by
  `providerOperationCenterItem` into the shared center item shape with
  `deepLink = /v1/provider/operations/:id` (the implemented read endpoint — not
  the resolve command and not a stale OpenAPI route). No table was restructured,
  no new queue exists, and the four existing sources are unchanged.
  Permission boundary (the security review's requirement, preserved exactly):
  admission is `planCenterSources(wanted, canReadProviderOperations)` against
  the PermissionsGuard-resolved set — `provider.operation.read` and nothing
  else. `support.ticket.read` is NOT widened and no role mapping changed. A
  caller WITH the permission gets the rows in an unfiltered center and
  `?source=provider_operation` narrows to that source; a caller WITHOUT it gets
  200 with provider rows omitted on an unfiltered request (never a 403 for the
  other four sources), and a 403 `missing permission: provider.operation.read`
  on an explicit `?source=provider_operation`, thrown before any provider
  query. Unknown sources stay 400 regardless of permissions. Payload
  minimization: the query selects only `id`, `action` and `requested_at` —
  `requested_payload_json`, `result_summary_json`, secret refs,
  provider-account/customer identifiers, `entity_id`, `correlation_id`,
  evidence, traces and raw adapter errors are never selected nor exposed, and
  the summary is the fixed constant `provider operation awaiting human
  resolution`. The source is read-model only: no claim/approve/reject control
  was added, and the web center hides the option AND the rows without
  `hasPermission('provider.operation.read')`, including against a stale or
  cached response. Coverage: pure policy unit tests plus API integration tests
  (authorized owner sees only its own parked op; `SUCCEEDED`/`RUNNING` and
  cross-tenant ops stay absent; payload/result sentinels absent from the whole
  serialized response; support-only `tenant_operator` unfiltered omits provider
  rows; explicit source 403s; authorized filter returns exactly the source;
  unknown 400) and web flow tests for the permission gate. Pure/API typecheck,
  API HITL unit tests and web flow tests passed on 2026-10-05; the PostgreSQL
API integration test was EXECUTED 2026-10-06 against a verified disposable
EMPTY database (fresh database, all 48 migrations applied by the suite's own
`applyMigrations`) and passed — full `@iptv/api` suite: 67 test files / 802
tests, 0 failures, with all 35 integration files running (none skipped). This closes the
  surfacing gap only — it is NOT provider/live certification and the remaining
  live gates above are unchanged.

- **CLOSED — production fail-fast for `PROVIDER_DISPATCH_MODE` (2026-10-05; engineering only).** `packages/config/src/index.ts` now rejects production startup unless the raw value is exactly `durable`; unset, empty, inline, mistyped, uppercase and padded values fail in `loadConfig()` before Nest bootstrap. Development/test retain the historical inline fallback, and `providerDispatchModeFromEnv` is unchanged. Evidence: config regression tests, provider-dispatch unit tests, and the docs/contracts/seeds gates recorded in `CHANGELOG.md`. This closes the silent-inline-misconfiguration item only; it does not certify a provider adapter or live write path.
- No disposable CINEVISION panel account exists (2026-10-02 operator decision): the Fase 6 canary runs against the operator's main account under the designated-account fence (`PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID`, code unchanged) with compensating controls — marked + deleted canary customer, short 046 gate window, balance before/after. Before broad production: obtain a test sub-account from the panel owner or an equivalent isolation improvement.

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
