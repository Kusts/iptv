# SPEC — Experimentation Engine

> Status: Supporting detail — reconciled under v1.0 implementation baseline
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Purpose

Convert hypotheses into controlled evidence before important business policy changes.

## Experiment definition

Population/eligibility, control/treatment, assignment, exposure event, primary/secondary/guardrail metrics, duration/sample target and stop/decision criteria.

## Guardrails

No LLM-only dynamic assignment. Experiment exposure is persisted. Pricing/reward/budget experiments still obey Policy/Risk and economic minimums.

## Outcome

Experiment concludes with evidence and decision record; a correlation from analytics alone is not promoted to causal policy.

## Auto-review result

Reviewed to keep Business Learning from silently changing policy based on noisy associations.
