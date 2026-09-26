# AI Experience Design

> Status: Canonical UX baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — aligned with tool failure taxonomy and HITL.

## AI state visibility

The UI must distinguish:

- composing/reasoning internally;
- waiting for tool;
- waiting for external provider;
- waiting for payment;
- waiting for human;
- blocked by policy;
- degraded due to dependency;
- completed/verified.

## Customer-facing waiting behavior

Do not leave customers with indefinite “verificando…”.

Pattern:

1. acknowledge action;
2. state what is being checked;
3. if delay exceeds expected window, update status;
4. never claim completion without authoritative evidence.

## Admin AI trace

For important interactions show:

- agent release;
- relevant context sources;
- tool calls and result categories;
- policy blocks;
- human intervention;
- cost/latency where useful.

Do not expose hidden chain-of-thought. Show concise decision rationale/evidence instead.

## AI recommendation vs action

Recommendation uses advisory visual treatment.
Executed action uses state/evidence treatment.

They must never look identical.
