# PF-01 — Workspace Bootstrap

## Goal

Create the application workspace and CI baseline without embedding business rules in framework bootstrap code.

## Tasks

- initialize workspace packages/apps according to Architecture Container boundaries;
- establish TypeScript strict baseline and shared lint/format/typecheck commands;
- implement typed environment-schema validation with fail-fast startup;
- create `/health/live` and `/health/ready` endpoints without leaking secrets;
- establish structured logging with correlation ID support and PII redaction hook;
- configure unit/contract test commands;
- configure CI to run lint, typecheck, unit tests, contract tests and documentation validator;
- document local bootstrap command and environment-variable ownership.

## Acceptance tests

- missing required environment variable prevents startup with a non-secret error;
- liveness succeeds when process is alive;
- readiness fails when mandatory dependencies are unavailable;
- log output never includes environment secret values;
- CI fails if `scripts/validate_docs.py` or contract tests fail.

## Done when

Workspace is reproducible from a clean checkout and contains no domain-policy shortcuts.
