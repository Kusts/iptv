# @iptv/browser-worker

Single-binding operator smoke CLI: `browser-worker` runs exactly one
read-only operation (`cinevision.readIdentity`) against the CINEVISION
panel. No HTTP server exists in this package by design.

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

## Env

| Var | Required | Notes |
| --- | --- | --- |
| `BROWSER_WORKER_ENABLED` | yes (`"1"`) | master gate |
| `BROWSER_WORKER_PROVIDER` | yes (`CINEVISION`) | single binding |
| `BROWSER_WORKER_TENANT_ID` / `BROWSER_WORKER_PROVIDER_ACCOUNT_ID` | yes | deployment binding |
| `CINEVISION_ALLOWED_ORIGIN` | yes | absolute `https://` origin |
| `CINEVISION_LOGIN_PATH` | yes | e.g. `/api/auth/login` (relative) |
| `BROWSER_INFISICAL_*` | yes | worker's own secret identity |
| `BROWSER_WORKER_PROFILE_ROOT` | no | restricted override (validated) |
| `BROWSER_WORKER_HEADLESS` | no | `"0"` = headed |
