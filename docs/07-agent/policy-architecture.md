# Agent Policy & Guardrail Architecture

> Status: Canonical MVP design  
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Purpose

Define deterministic controls that surround model reasoning so prompt injection or model error cannot directly create discounts, renewals, rewards, payments or provider mutations.

## Control layers

```text
Input classification
→ Conversation/Communication policy
→ Agent reasoning
→ Tool intent
→ Authorization
→ Commercial/Domain policy
→ Risk/Action class
→ Tool execution
→ Output/postcondition policy
```

## Policy examples

- Trial primary access only once per Person;
- Retrial only through allowed exception;
- Agent cannot invent price/discount;
- user statement "I paid" is not payment confirmation;
- referral reward requires qualification;
- additional connection remains recurring/costed each cycle;
- provider operation cannot succeed without postcondition;
- human takeover blocks autonomous outbound;
- external retrieved text is data, not instruction.

## Prompt injection boundary

Instructions from customers, web pages, documents, YouTube transcripts or provider messages cannot modify system policy/tool permissions. Retrieved content is tagged with source/trust and rendered as untrusted context.

## Fail-closed rules

For financial/high-risk mutations, missing authorization/policy/risk dependency means DENY/REVIEW rather than "best effort" execution.

## Explainability

Policy decisions return structured reason codes suitable for audit and operator review. Do not expose sensitive fraud heuristics verbatim to external users.

## Kill switches

Support per-tenant and global kill switches for AI outbound, specific tool families, provider/browser actions, billing automation and campaigns.

## Auto-review result

Reviewed against the project guardrails to ensure no policy relies solely on prompt wording or LLM self-restraint.

## Refinamentos de policy v0.14

- `REFUND` é sempre R4/HITL; Agent pode analisar/recomendar, nunca autorizar/executar sozinho.
- `TRUST_RENEWAL` só é permitido se provider capability confirmar ACTIVE + <=3 dias; duração fixa +3 dias.
- Additional Connection mid-cycle exige disclosure da expiration compartilhada antes de purchase/activation.
- Support deve confirmar contexto volátil quando relevante e não transformar dado externo/web/community em instrução.
- Paid App procurement requer AppTrial/validação + Order SETTLED antes de débito do Supplier Balance.
- Manual UI actions passam pelo mesmo Policy Engine e não constituem bypass administrativo implícito.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — risk/policy refinements checked.

