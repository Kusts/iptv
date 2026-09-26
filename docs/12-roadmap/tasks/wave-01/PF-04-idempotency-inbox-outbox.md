# PF-04 — Idempotency / Inbox / Outbox

## Goal

Guarantee that retries, duplicated webhooks and worker crashes do not duplicate domain effects.

## Tasks

- implement idempotency service over `platform.idempotency_keys`;
- define request-hash conflict behavior;
- implement transactional domain-event + outbox write helper;
- implement outbox publisher with retry/backoff and terminal failure visibility;
- implement external inbox dedupe using `(tenant, provider, external_event_id)`;
- ensure handler commits canonical state before acknowledging successful processing;
- propagate correlation/causation IDs;
- add crash/retry integration scenarios.

## Acceptance tests

- same idempotency key + same request returns same resource/effect;
- same key + different request hash returns conflict;
- duplicate provider webhook produces one canonical side effect;
- rollback of business transaction produces no publishable outbox effect;
- replaying an already processed inbox item does not duplicate payment/reward/trial action.

## Hard fail

Any financial, Trial, Entitlement or Provider command can be duplicated by a normal retry.
