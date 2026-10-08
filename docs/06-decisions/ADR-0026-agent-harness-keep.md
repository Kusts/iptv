# ADR-0026 — Keep the platform-owned agent harness (conditional)

- Status: **ACCEPTED — KEEP CURRENT HARNESS (CONDITIONAL)**
- Date: 2026-10-07
- Supersedes-direction: ADR-0020 (the SDK-primary direction is superseded; ADR-0020 is kept as historical context)
- Inputs: EXPL-P2 gap analysis; jev decisions `keep_conditional` and `keep_local_honest`

## Context

ADR-0023 already establishes the platform-owned agent runtime: no external
framework owns business state, memory, policies, tools or workflow semantics.
ADR-0020 chose the OpenAI Agents SDK TypeScript as the primary execution
harness behind an owned port, subject to a Wave 0 benchmark that was never
run against the current codebase.

EXPL-P2 found the honest local position:

- The shipped harness (`packages/ai-runtime` + `apps/api/src/agent`) is
  platform-owned, deterministic under the echo gateway, and covered by offline
  evals, F07 model-failure tests and the shadow→approval integration path.
- 9 eval fixtures were missing (ambiguous/malformed/secret-leak-output/
  tenant-attack-cross-ID/wrong-tool/timeout/hallucinated-action/
  HITL-stale-agent/fallback-model); no minimum baseline or thresholds existed.
- The Hatchet stub is exactly that — a stub. F12 is BLOCKED and declared as
  such; this ADR makes no durability claim.

Per `keep_local_honest`, the baseline must describe the harness we actually
ship, not the SDK we might adopt.

## Decision

**KEEP_CURRENT_HARNESS**, conditionally. The platform-owned harness stays
primary. The OpenAI Agents SDK TypeScript drops to *future alternative*:
ADOPT-SDK happens only if a future benchmark beats the owned harness on the
business-weighted evals defined in
`../15-implementation-baseline/08-agent-harness.md`.

Conditions (P2b owns the code; P2a owns the eval proof):

1. Runtime budgets/timeouts/fallback land in code (P2b scope, not this ADR).
2. The 9 P2 eval fixtures run in the offline suite with documented expected
   behaviour (escalate/degrade/refuse per `mapFailureToStatus`).
3. Critical invariants hold 100% before any AUTO operation; the rest carry a
   recorded baseline (thresholds documented in the 08 baseline).

## Consequences

- `08-agent-harness.md` is rewritten consistently: owned harness primary, SDK
  as a future alternative with an adoption criterion, no SDK claims.
- No new durability assertions: HITL waits that need durability stay BLOCKED
  on F12/Hatchet certification wherever the baseline says so.
- Reopen ADOPT-SDK only with a benchmark victory on the 08 eval set plus the
  P2b runtime conditions met. A model/vendor change alone is not a reason.
