# Infisical Sandbox writer smoke — staging (2026-11-04)

> Scope (initial synthetic smoke): staging Sandbox only. No Production action
> in that smoke, no CINEVISION values,
> no host or container mutation, no database change.
> Sanitized: no secret values, no identifiers, no tokens, no raw error text.

## Authorization and scope

- Explicitly user-authorized synthetic writer smoke through the Infisical
  adapter, executed inside the already-verified staging container.
- Host identity had been checked via Orca before the run: canonical path
  `/home/deploy/iptv-staging`, marker `main@76515c3`.
- Synthetic tenant path (UUID, value withheld) under provider `asaas`
  (chosen deliberately to avoid touching CINEVISION),
  allowlisted key `ASAAS_WEBHOOK_TOKEN` only.
- Test values were random 24-byte values generated inside the container;
  the secret was deleted afterwards and absence was read-verified.
- The adapter path `/integrations/<synthetic UUID>/asaas` ensures its
  empty folder: the secret was deleted with absence read-verified, and
  the empty `asaas` folder was deleted 2026-11-04 in a user-authorized
  live Orca cleanup (authenticated project `iptv`, environment `Sandbox`
  only): the synthetic tenant folder was uniquely identified under
  `/integrations`, its only child was `asaas` (table empty, 0 secrets, no
  child rows/subfolders), only that `asaas` folder was deleted via its row
  Delete Folder action, and a re-read of the parent confirmed the table is
  empty with no `asaas` child. The empty synthetic parent
  `/integrations/<synthetic UUID>` remains; no attempt was made to delete
  it (outside the exact authorized scope — ask if cleanup is wanted).
  No other environment/project touched; no secrets read; no
  CINEVISION/Production.

## Method (read/write path exercised)

1. `create` synthetic secret → read back (`createReadBack`).
2. `update` synthetic secret → read back (`updateReadBack`).
3. `delete` synthetic secret → read back absence (`absentAfterDelete`).

## Result

`writer: infisical`, `environment: SANDBOX`, `created: true`,
`createReadBack: true`, `updated: true`, `updateReadBack: true`,
`deleted: true`, `absentAfterDelete: true`, `failureStage: null`,
`errorCode: null`.

This is the explicit live Sandbox writer proof that the earlier
`evidence/pilot-asaas-e2e-20261104/report.md` did not provide: that run
recorded `webhook_ensure` + delivery success but did not distinguish
token reuse from a new put. This smoke proves an actual put/get/update/delete
cycle through the adapter in the staging Sandbox scope.

## Read-only log-scan context (same session)

- A read-only 24h API log scan showed two `POST`
  `/v1/integrations/cinevision/configure` responses `503`, plus `OPTIONS`
  `204`.
- No `VAULT_UNAVAILABLE` literal appeared, and the sanitized fields carried
  no error details — the exact original `503` cause remains unknown.
- Those `POST`s cannot be tied to the currently visible UI state: the UI
  had `PRODUCTION` selected when inspected, and this report makes no claim
  that the `503`s came from that environment.

## Read-only follow-up (same day, no writes)

- After the user's re-entry, the staging UI still showed `NOT_CONFIGURED`
  with StreamMax / `PRODUCTION` selected and the dialog open; an Orca
  network capture at that moment returned zero entries, so no request was
  observed from that UI state and this report makes no claim that
  `Validate access` ran.
- A read-only 1h staging API log scan correlated nine request IDs for
  `/v1/integrations/cinevision/configure`: 6 `POST`s, each `statusCode`
  `503`, and 3 `OPTIONS`, each `204`.
- No literal `VAULT_UNAVAILABLE` appeared in the 1h logs; request bodies
  are not logged, so this report does not claim any of the six `POST`s
  carried the `Production` environment — the exact `503` cause remains
  unknown and no cause is inferred.
- The Infisical Audit Logs UI showed the current plan lacks access
  (upgrade paywall); no audit data was accessed or retrieved.

## Code diagnostic (read-only, no behavior change)

- Web `apps/web/lib/api.ts:137-150,231-240,272-276`: `apiFetch` parses
  `payload.code` into `ApiError.code`, but `messageForStatus(503)` always
  returns the generic 503 string and `userMessage` returns `.message` —
  so the structured `code` survives on the error object while the
  displayed message stays generic.
- Web `apps/web/app/settings/integrations/cinevision-card.tsx:581-584`
  (via `conflictOrGeneric`, defined `:165-170`): the configure handler
  displays only that generic message for non-409 failures.
- API `apps/api/src/integrations/integrations.commands.ts:422-430` maps a
  `SecretsError` during the vault put phase to `503` (`vaultUnavailable`,
  defined `:302-308`); `:513-519` maps any DB insert/update exception
  after a successful put to the same `503` after best-effort compensation.
  Either path therefore presents identically at the UI with current code,
  and this report does not infer which path produced the observed `503`s.
- The current `packages/secrets` synthetic Sandbox smoke passed, but it
  does NOT prove the Production environment or the CINEVISION key
  namespace.

## Boundaries (explicitly NOT claimed)

- CINEVISION `CINEVISION_USER`/`CINEVISION_PASS` configure path: unvalidated.
- Any Production ref: unvalidated, no successful binding. The initial
  synthetic Sandbox smoke itself performed no Production action; a later
  user-authorized StreamMax / `PRODUCTION` attempt (credentials entered in
  UI by the user, same generic error reported by the user) failed with the
  binding still `NOT_CONFIGURED`.
- Least privilege: unvalidated — the broad `Admin Project` role was seen
  and left unchanged by operator choice.
- Container inspection showed five `INFISICAL_*` keys, all nonempty
  (names and count only); no `BROWSER_INFISICAL_*` or `CINEVISION_*` vars
  in the API container.

## Status and next gates

- Status stays `LAB_VALIDATED`; no gate promotion, no certification.
- Next: sanitized distinction of Vault-write vs DB-persist failures before
  more retries, then read-only `Validar acesso` only after config success.
