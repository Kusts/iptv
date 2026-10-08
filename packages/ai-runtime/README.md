# @iptv/ai-runtime

Agent runtime substrate: harness, tool registry, release store and the
**model gateway port**. Framework-free; no provider SDK dependency.

## What it is

- `ModelGatewayPort` — the only path to an LLM. The harness never calls a
  provider directly, so tests and dev run on the deterministic gateway.
- `EchoModelGateway` (default, `name: "echo"`) — rule-based, no network. Maps
  the tagged inbound text to a labelled proposal (`injection_refusal`,
  `suppression_respect`, `off_scope_refusal`, `happy_reply`).
- `OpenAICompatGateway` (`name: "openai-compat"`) — env-gated chat-completions
  client for any OpenAI-compatible endpoint (OpenCode Go in this repo).
- `gatewayFromEnv(env)` — selection: Echo unless a key is present.
- `renderUserBlock(context, inboundText, mode)` — the deterministic user
  message, with the customer text inside an `<untrusted-inbound>` block.
- `looksLikeInjection` / `looksLikeSecret` — the safety guards applied to
  inbound text and to raw model output.
- `AgentHarness`, `ToolRegistry` / `mapFailureToStatus`, and
  `AgentReleaseStore` (`InMemoryAgentReleaseStore`,
  `defaultCustomerAgentRelease`).

## Usage

```ts
import { gatewayFromEnv } from "@iptv/ai-runtime";

const gateway = gatewayFromEnv(); // Echo without credentials
const completion = await gateway.complete(messages, { model, maxTokens: 400 });
```

## Env

| Var | Default | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | unset | Present ⇒ OpenAI-compatible gateway; absent/empty ⇒ deterministic Echo. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL of the OpenAI-compatible endpoint. |
| `AGENT_MODEL` | `gpt-4o-mini` | Model used when a call passes no explicit model. |

## Budgets, timeouts, fallback (P2b / ADR-0026 condition 1)

`new AgentHarness({ gateway, releases, tools, dispatch?, budgets?, fallback? })`.
All budget fields are optional; every default is safe (bounded loop, bounded
spend). Exhaustion degrades deterministically — never an infinite loop, never
open-ended cost. Total model failure still rejects loudly (F07: no run, no
review, no message); budgets bound the attempt, they do not mask the outage.

| Budget | Default | On exhaustion |
| --- | --- | --- |
| `maxModelAttempts` | `2` (1 + 1 retry, TRANSIENT only) | Throw (fail closed); or 1 fallback attempt when `fallback` is wired |
| `maxToolSteps` | `1` | Skip step, trace `tool:<name>:skipped:budget` |
| `perCallTimeoutMs` | `15_000` (real AbortSignal) | TRANSIENT → retry budget; then throw or fallback |
| `toolTimeoutMs` | `10_000` | `REVIEW_REQUIRED` / `UNKNOWN_EFFECT` (never blind-retry) |
| `totalTimeoutMs` | `60_000` (run deadline) | `ESCALATE` `run_deadline_exceeded` |
| `maxInputTokens` | `8_000` (chars/4 heuristic) | Deterministic context rebuild: shrink recent window 8→4→2→0, trace `context:rebuilt:kept=N` |
| `maxTokens` | `500` | Request cap per completion |
| `maxProposalChars` | `1000` | Truncate after validation |
| `inputMicrosPerToken` / `outputMicrosPerToken` | `0.15` / `0.6` (mini-class heuristic — host MUST calibrate for the live model) | Rate inputs to the cost caps |
| `maxEstimatedCostMicros` | `1_000_000` ($1/run) | Pre-call: no call, `ESCALATE` `cost_budget_exceeded`; post-call: discard to `ESCALATE`, real usage preserved |

Fallback direction (honest): `fallback` is a second `ModelGatewayPort`
tried ONCE and only on TRANSIENT (timeout, 429, 5xx, transport). FATAL
(4xx, empty, unsafe output) never falls back — a second model cannot fix a
bad answer. Fallback covers indisponibilidade, not hallucination; use is
always visible in `trace` as `model:fallback:<name>:<label>`. Prefer a
second compatible model; echo-as-fallback in LIVE yields generic
deterministic replies (visible in trace — it degrades, it does not
replicate the primary).

## Notes

- Without credentials nothing calls the network: the Echo gateway is the
  safe default for tests, CI and dev.
- Inbound customer text is DATA, never instruction. It is tagged in the user
  message and checked with `looksLikeInjection`; the OpenAI adapter applies
  the same check to the raw completion and throws when the output looks like
  an injection or a leaked secret.
- `OpenAICompatGateway` refuses to construct without a key and rejects empty
  completions.