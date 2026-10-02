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

## Notes

- Without credentials nothing calls the network: the Echo gateway is the
  safe default for tests, CI and dev.
- Inbound customer text is DATA, never instruction. It is tagged in the user
  message and checked with `looksLikeInjection`; the OpenAI adapter applies
  the same check to the raw completion and throws when the output looks like
  an injection or a leaked secret.
- `OpenAICompatGateway` refuses to construct without a key and rejects empty
  completions.