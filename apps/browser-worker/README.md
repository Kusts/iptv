# @iptv/browser-worker

Single-binding operator smoke CLI: `browser-worker` runs **certified
read-only operations** against the CINEVISION panel. No HTTP server exists in
this package by design.

## Commands

All subcommands are read-only (`CINEVISION_READ_COMMANDS`,
`src/constants.ts`). There are no write commands, and no path/URL/method/
selector flags — args are numeric ids/pagination only, validated fail-closed.

| Subcommand | Operation | Purpose |
| --- | --- | --- |
| `read-identity` | `cinevision.readIdentity` | `GET /api/auth/me` — sanitized identity snapshot (no token). |
| `read-credit-balance` | `cinevision.readCreditBalance` | `credits` field of the identity read (unit/precision unknown). |
| `list-customers` | `cinevision.listCustomers` | `GET /api/customers` — paginated customer snapshots (`--page`/`--per-page`). |
| `read-customer --id X` | `cinevision.readCustomer` | `GET /api/customers/{id}` — single customer snapshot. |
| `read-customer-status --id X` | `cinevision.readCustomerStatus` | Derived from `readCustomer`: status / expires_at / is_trial. |
| `read-connections --id X` | `cinevision.readConnections` | Derived from `readCustomer`: contracted connection allowance (NOT live sessions). |
| `list-servers` | `cinevision.listServers` | `GET /api/servers` — server catalog snapshot. |
| `read-server-status` | `cinevision.readServerStatus` | `GET /api/servers/status` — status entries. |
| `list-package-prices` | `cinevision.listPackagePrices` | `GET /api/packages/price` — package price table snapshot. |
| `read-live-connections --server-id X` | `cinevision.readLiveConnections` | `GET /api/customers/live-connections/{serverId}` — live sessions (paginated). |
| `list-integrations` | `cinevision.listIntegrations` | `GET /api/integrations` — integration catalog snapshot. |

`--operation <name>` (dotted) and `--help` are accepted; any other
`--*` flag fails closed. DOM selection (`--selector`, `--dom`, `--xpath`,
`--css`, `--strategy`) fails closed with `DOM_NOT_CERTIFIED`.

## Binding (fail closed)

- `BROWSER_WORKER_PROVIDER` must be exactly `CINEVISION`.
- `BROWSER_WORKER_TENANT_ID` / `BROWSER_WORKER_PROVIDER_ACCOUNT_ID`
  identify the deployment binding only. They come from env — never from
  argv (no such flags exist) — and no request-supplied ids are trusted
  because there is no server to receive them.
- Secrets resolve only via the three `FIXED_SECRET_REFS`
  (`CINEVISION_URL/EMAIL/PASSWORD`); `CINEVISION_LOGIN_PATH` (relative
  `/api/...`, no query/fragment/traversal) pins the single allowed login
  POST. Without a configured binding the CLI fails closed (`CONFIG`).
- The worker uses its **own** Infisical identity (`BROWSER_INFISICAL_*`) and
  never reads the API `INFISICAL_*` vars (`src/secrets.ts`). It resolves
  exactly those three refs through `@iptv/secrets`; a missing/empty value
  throws `SECRET_UNAVAILABLE`, and no ref/URL/argv value is ever echoed.
- A future API integration MUST resolve the provider binding from the
  tenant/account id in its own DB — never from caller-supplied ids.
  This CLI is an operator smoke probe, not multi-tenant authZ.

## Safety invariants

- Browser writes stay blocked: GET/HEAD/OPTIONS same-origin only, plus at
  most ONE POST to the exact login path inside the single `submitLogin`
  click window on the exact `#/sign-in` route. Any challenge, drift or
  ambiguity → `HUMAN_REQUIRED`.
- Profile: per-binding hashed dir under `%LOCALAPPDATA%` (Windows) /
  XDG state (POSIX), `0700` (re-chmodded on POSIX), atomic `.lock`
  sidecar per binding (second holder gets `PROFILE_LOCKED`). On Windows
  isolation relies on the user-container ACLs; roots outside the
  container fail closed. A crashed run can leave a stale `.lock` — remove
  it only after confirming no worker holds the profile.
- Identity reads use the absolute `/api/auth/me` URL with redirects
  disabled; cross-origin redirect targets fail closed without following.
- Outputs carry booleans + fixed code words only. Raw argv values,
  secret values and URLs are never echoed. No trace/screenshot/HAR/
  storageState is ever captured.
- Each command runs inside a bounded budget
  (`BROWSER_WORKER_COMMAND_TIMEOUT_MS`); exceeding it fails closed with
  `INCONCLUSIVE`/`TRANSPORT`.

## Output

One compact JSON envelope per run: booleans + fixed code words plus
execution metadata (`command`, `executionChannel`, `strategy`,
`adapterVersion`, `reauthenticated`). Exit `0` on `READ_CONFIRMED`, `2` on
`HUMAN_REQUIRED`/`INCONCLUSIVE` (also the `DISABLED`/`INVALID_CONFIG`
fail-closed paths), `1` on invalid invocation.

## Env

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `BROWSER_WORKER_ENABLED` | yes (`"1"`) | unset | master gate |
| `BROWSER_WORKER_PROVIDER` | yes (`CINEVISION`) | unset | single binding |
| `BROWSER_WORKER_TENANT_ID` | yes | unset | deployment binding; id-charset validated |
| `BROWSER_WORKER_PROVIDER_ACCOUNT_ID` | yes | unset | deployment binding; id-charset validated |
| `CINEVISION_ALLOWED_ORIGIN` | yes | unset | absolute `https://` origin, no path/query/hash |
| `CINEVISION_LOGIN_PATH` | yes | unset | e.g. `/api/auth/login` (relative) |
| `BROWSER_INFISICAL_SITE_URL` | yes | unset | worker's own secret identity; absolute `https://` |
| `BROWSER_INFISICAL_PROJECT_ID` | yes | unset | worker's own secret identity |
| `BROWSER_INFISICAL_CLIENT_ID` | yes | unset | worker's own secret identity |
| `BROWSER_INFISICAL_CLIENT_SECRET` | yes | unset | worker's own secret identity |
| `BROWSER_WORKER_PROFILE_ROOT` | no | user container | restricted override (validated, host-namespace match) |
| `BROWSER_WORKER_HEADLESS` | no | headless | `"0"` = headed |
| `BROWSER_WORKER_CHALLENGE_WAIT_SECONDS` | no | `45` | bounded managed-challenge wait (0–300) |
| `BROWSER_WORKER_COMMAND_TIMEOUT_MS` | no | `60000` | total per-command budget (clamped 5000–300000) |
| `BROWSER_WORKER_LAUNCH_SETTLE_MS` | no | `3000` | launch-quiescence wait before releasing the profile lock (clamped 500–15000) |

Refs resolved in the worker's Infisical project/environment (`dev`):
`infisical://dev/browser-worker/CINEVISION_URL`,
`.../CINEVISION_EMAIL`, `.../CINEVISION_PASSWORD`.

Build/verify: `pnpm --filter @iptv/browser-worker build|typecheck|lint|test`.
Runtime: `node --env-file-if-exists=.env apps/browser-worker/dist/cli.js <subcommand>`.