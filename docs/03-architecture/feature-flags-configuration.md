# Feature Flags & Runtime Configuration

> Status: Canonical baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked for tenant safety, kill-switch behavior, auditability and experiment separation.

## Types

1. **Kill switch** — immediate disable of risky capability.
2. **Release flag** — progressive rollout of implementation.
3. **Tenant entitlement flag** — product/package availability.
4. **Operational config** — thresholds/limits not requiring deployment.
5. **Experiment assignment** — owned by Experimentation Engine, not generic feature flags.

## Required kill switches

At minimum:

```text
agent.outbound.enabled
agent.tools.<tool>.enabled
messaging.outbound.enabled
provider.<provider>.operations.enabled
browser.provider.enabled
billing.automation.enabled
growth.autonomous_changes.enabled
```

## Rules

- defaults are fail-safe for high-risk features;
- changes are audited with actor, old/new value, reason and timestamp;
- tenant overrides cannot exceed platform safety boundaries;
- secrets are never stored as flag/config values;
- business rules that require historical audit/versioning are not hidden in flags.

## Configuration versioning

Commercial/policy thresholds used for decisions should record the effective configuration/policy version on the resulting decision where economically or operationally important.

## Auto-review result

Reviewed to distinguish deployment controls from durable business policy and prevent flags from becoming an untracked rules engine.
