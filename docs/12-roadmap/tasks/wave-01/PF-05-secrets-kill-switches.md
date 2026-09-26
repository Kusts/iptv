# PF-05 — Secrets & Kill Switches

## Goal

Make external credentials non-public and every high-risk automation independently stoppable without deploy.

## Tasks

- implement SecretsPort against selected secrets provider;
- prohibit raw secrets in tenant tables/logs/traces/events;
- resolve provider account `secret_ref` at execution time;
- implement feature/kill-switch evaluation with tenant override;
- cover AI outbound, messaging outbound, browser provider operations and provider-specific operation switches;
- make workers fail closed when a required kill switch is disabled;
- audit switch changes with human actor;
- add emergency-operation runbook stub.

## Acceptance tests

- disabling browser provider switch blocks new browser operations while preserving queued state safely;
- disabling messaging outbound prevents outbound send but does not discard message intent;
- secret value never appears in API payload, domain event, audit metadata or trace;
- tenant-specific flag does not change another tenant;
- switch change is auditable.
