# Prompt & Agent Release Governance

> Status: Canonical agent-change process  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked against evals, policy/tool authority, rollback and production audit requirements.

## Versioned artifacts

An Agent Release pins:

```text
system/developer prompt versions
model-routing config
tool schemas
policy versions
retrieval/memory config
knowledge compatibility version
eval dataset/result
release notes
```

## Change classes

- wording-only low-risk;
- behavioral prompt change;
- tool schema/availability change;
- policy/autonomy change;
- model/routing change;
- retrieval/memory change.

Anything beyond wording-only requires targeted evals; tool/policy/autonomy changes require higher review.

## Promotion

```text
draft
→ offline eval
→ adversarial/safety cases
→ shadow
→ limited rollout
→ production
```

Hard-fail evals block promotion.

## Rollback

Previous release remains addressable so runtime can revert quickly. Historical `agent_run` records keep the release identity used at execution time.

## Prompt discipline

Prompts may describe behavior but cannot be the sole location of business rules, prices, eligibility or permissions. They reference/use structured policy/domain/tool results.

## Auto-review result

Reviewed to prevent undocumented prompt drift from becoming an invisible production rules engine.
