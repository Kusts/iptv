# Agent Context Engineering

> Status: Canonical MVP guidance  
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Goal

Provide enough context to make a correct decision without dumping entire customer history, knowledge base or repository into the model.

## Context layers

1. **Task instruction** — current agent responsibility and allowed tools.
2. **Conversation window** — recent messages and compact thread summary.
3. **Operational snapshot** — authoritative current Lead/Trial/Subscription/Payment/Support facts needed for the task.
4. **Customer memory** — minimal relevant preferences/context.
5. **Knowledge retrieval** — top context-matched trusted procedures/solutions.
6. **Policies/constraints** — applicable commercial/communication/risk decisions as structured data.

## Retrieval order

Operational facts have priority over memory; internal policy has priority over external knowledge; current Incident may supersede generic troubleshooting.

## Summarization

Long histories are summarized with source references/ids. Critical facts such as payment/entitlement state must be fetched live rather than copied from an old summary.

## Token/cost control

Use progressive retrieval: start with minimum context, retrieve additional history/knowledge only when necessary. Record context size and model cost per run.

## Auto-review result

Reviewed to minimize stale-context risk and prevent summaries/RAG from becoming an accidental source of truth.
