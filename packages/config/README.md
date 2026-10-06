# @iptv/config

Boot-time environment validation: one Zod schema, one `loadConfig()` call.
Everything here runs once at startup — failures are boot failures by design.

## What it is

- `loadConfig(env = process.env)` — validates against the schema and returns
  typed `AppConfig`.
- `validateProductionAppDatabaseUrl(raw)` / `assertNoPrivilegedDatabaseEnv(env)`
  — the production database guard, shared with the API pool resolver.
- `PRODUCTION_DB_USERNAME` — `iptv_app`, the only role name a production API
  pool may be configured to connect as.
- `parseCorsAllowedOrigins(raw, nodeEnv)` / `isValidCorsOrigin(entry)` — the
  browser CORS allowlist parser.
- `DEFAULT_LOCAL_CORS_ORIGIN` — `http://localhost:3000`.

## Usage

```ts
import { loadConfig } from "@iptv/config";

const config = loadConfig(); // throws on invalid configuration
```

Called once in `apps/api/src/main.ts` before the Nest app is created.

## Env

**Every key is optional outside production.** Each has a default (or is
genuinely optional), so a missing variable never breaks boot on its own; with
`NODE_ENV=production` **three** values are required — `BETTER_AUTH_SECRET`,
`PROVIDER_DISPATCH_MODE` and `APP_DATABASE_URL` — and the database guard below
applies:

| Var | Default |
| --- | --- |
| `NODE_ENV` | `development` (`development`/`test`/`production`) |
| `PORT` | `3001` |
| `DATABASE_URL` | unset (**owner credential — rejected in a production API process**; blank is absent, nonblank values are kept byte-exact) |
| `APP_DATABASE_URL` | unset (**required in production**, non-blank) |
| `LOG_LEVEL` | `info` |
| `BETTER_AUTH_SECRET` | dev-only value (`min 16`); production MUST override it |
| `BETTER_AUTH_URL` | unset |
| `API_SCHEDULER_ENABLED` | `0` |
| `API_SCHEDULER_TICK_SECONDS` | `60` (5–3600) |
| `HATCHET_API_TOKEN` / `HATCHET_SERVER_URL` | unset |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset |
| `OTEL_SDK_DISABLED` | `true` |
| `INFISICAL_SITE_URL` / `INFISICAL_PROJECT_ID` / `INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET` | unset |
| `INFISICAL_ENVIRONMENT` | `development` |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:3000` outside production, `[]` (deny all) in production |
| `PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID` | unset (UUID when set) |

## Notes

- **Empty means absent.** Optional keys pass through `emptyToUndefined`, so a
  shipped `KEY=` placeholder is treated as unset rather than failing
  `.min(1)`. Prefer omitting the line over leaving it empty.
- **Boot error text**: any schema or CORS problem throws
  `Error("invalid environment configuration: …")`, listing every issue at
  once. Production additionally rejects the dev-only
  `BETTER_AUTH_SECRET` default with the same prefix.
- **`CORS_ALLOWED_ORIGINS` never accepts a wildcard.** Entries must be bare
  `http(s)://host[:port]` origins — no `*`, no path, query, hash or
  credentials. Invalid entries throw. Outside production the list defaults to
  the local web origin; in production an unset/empty value means **deny all
  cross-origin** (never an implicit localhost fallback).
- Keys not in this schema (WAHA, Asaas, provider adapters, OpenAI gateway)
  are validated at their point of use, not here.
- **`PROVIDER_DISPATCH_MODE` is deliberately not a schema field** — it is read
  straight from env so unvalidated values stay legal in development/test, where
  `providerDispatchModeFromEnv` keeps its `inline` fallback. In production it
  must be exactly `durable` (no case folding, no trimming): unset, empty
  (empty means absent), `inline`, typo, `DURABLE` or padded values throw before
  the API starts, because the durable dispatcher is the only certified executor
  for real provider writes.
- **Production database guard.** With `NODE_ENV=production` `loadConfig` calls
  two exported helpers, which are also what the API pool factory calls — one
  implementation, so the boot path and the pool cannot drift:
  - `assertNoPrivilegedDatabaseEnv(env)` throws when a privileged/test
    connection ALIAS is **non-blank** in the API process: `DATABASE_URL`,
    `DATABASE_OWNER_URL`, `TEST_DATABASE_URL`, `POSTGRES_PASSWORD` (repo
    blank-means-absent rule). Owner roles bypass RLS, a test database is never a
    production target and a password does not belong in the API env. It also
    throws when a **driver-consumed** variable is supplied at all — only an empty
    string is absent, whitespace included: `PGPASSWORD`, `PGOPTIONS` (feeds
    driver startup `options` from outside the URI), `PGHOST`, `PGPORT`,
    `PGDATABASE`, `PGUSER`, `PGSSLMODE`, `PGSSLNEGOTIATION` (the driver would
    derive the connection target/transport from them). All are refused even when
    `APP_DATABASE_URL` is valid. The same guard screens `PGAPPNAME`: ordinary
    application names (spaces included) stay legal, while an ASCII control
    character is refused with a static message.
  - `validateProductionAppDatabaseUrl(raw)` throws unless the value is
    non-blank, unpadded, free of ASCII control characters, a parseable
    `pg://`/`postgres://`/`postgresql://` URI whose authority username is **exactly**
    `iptv_app`, that states its **target explicitly** (non-empty host in the
    authority AND non-empty database name in the path, so the driver cannot fall
    back to ambient `PGHOST`/`PGDATABASE` or a libpq default), and that carries
    **no `user=`, `role=`, `options=` or `host=`/`port=`/`database=`/`db=`/
    `dbname=` query parameter** (compared case-insensitively — the target keys
    would override the target the URI already states). Each URI component (username,
    password, hostname, raw query string **and the database path**) must additionally have
    well-formed percent escapes and must not decode to an ASCII control
    character: `new URL` keeps `%00`/`%09` encoded while `URLSearchParams`
    decodes them into **real** control characters, so
    `application_name=api%00user%00postgres` (or a `db%00x` database name)
    would otherwise reach the driver intact. A percent-encoded space in a
    password stays legal and accepted URLs are returned byte-exact. A **URI fragment
    is forbidden**: any literal `#` is refused, including a bare trailing `#`
    whose parsed fragment would be empty. An encoded `%23` inside a component is
    not a delimiter and stays ordinary encoded data. `sslnegotiation`, when
    present, must be exactly `postgres` or `direct` (it is echoed back by the
    driver/server), so an invalid value is refused here rather than downstream.
    TLS is validated for ambiguity, **not required**: the URI must be URL-encoded
    (a literal space anywhere is refused — the installed parser rewrites such a
    URI, which could make its view of a percent-encoded query key differ from
    the WHATWG-validated one); query keys must be canonical lowercase **literals**
    (the driver consumes lowercase parameter names, so `SSLMODE` or an encoded
    `ssl%6dode` would be read differently by the driver than by this validator —
    percent-encoding is for values only); and a repeated parameter is
    refused (case-insensitively, before parsing — `pg-connection-string`
    assigns parameters onto an object, so a repeat is last-value-wins);
    `ssl` must be exactly `true|1|0`, and **`ssl=false` is refused** because the
    installed pg parser leaves it as a truthy string and would not disable TLS
    (use `ssl=0` or `sslmode=disable`); `sslmode` must be one of
    `disable|prefer|require|verify-ca|verify-full|no-verify`, plus `allow` only
    with `uselibpqcompat=true` (where `no-verify` is unavailable), and
    libpq-compat `verify-ca` requires a non-blank `sslrootcert` value —
    **only that combination does**: the installed parser throws for it, while
    `verify-full` uses `{}` (system CA + identity verification) and stays legal
    without a custom root certificate. In both cases **only the parameter is
    checked, never whether a certificate file is readable or valid on the
    server**; `uselibpqcompat` must
    be exactly `true|false`; `ssl` and `sslmode` together are refused as
    ambiguous; and `sslnegotiation=direct` is refused while TLS is explicitly
    disabled. Explicit disable (`ssl=0` or `sslmode=disable`) is also refused
    with nonblank `sslcert`, `sslkey` or `sslrootcert` settings because the
    driver can let certificate options override `ssl=0`, while a `sslmode=disable`
    combination is still conflicting and may trigger certificate-file handling.
    Rejected values are never echoed.
    Per the node-postgres
    connection-string reference, `user` is the driver identity override and
    `options` is forwarded to server startup, so it can request a role change
    (e.g. `-c role=owner`); whether that request succeeds depends on server-side
    role membership/privileges, which **this guard does not verify**. `role` is
    denied **by policy** — no current-driver behavior is claimed for it, simply
    never needed and best removed. Ordinary settings (`sslmode`,
    `application_name`, `connect_timeout`, …) remain legal. Owner/superuser
    names, case variants (`IPTV_APP`), percent-encoded forms (`iptv%5Fapp`),
    non-PostgreSQL schemes, malformed URIs and ASCII control characters anywhere
    in the value (tab/LF/CR are stripped by URL parsing and could smuggle a
    different connection string) are rejected. Blank counts as absent, and the
    value is never trimmed — a padded credential is reported, not repaired. On
    success the value is returned **byte-exact**.

  Error text names the variable and the rule only; **the connection value and
  its credentials are never printed**. Outside production neither helper runs
  and URL precedence is untouched — all those variables stay legal there.

  This validates the **configured** identity only: nothing queries the server, so
  it does not prove the connected role's effective privileges, does not enable
  RLS and does not complete the role-split cutover
  (`docs/10-operations/runbooks/rls-role-split-cutover.md`).
- **`APP_DATABASE_URL` in `AppConfig` is guard/validation-only.** It exists so
  `loadConfig` can enforce the production rule; it never selects a connection.
  Actual pool selection is `resolveAppConnectionString(env)` in
  `apps/api/src/app.module.ts`, which calls these same helpers. The value is
  kept **byte-exact** in every environment (`blankToUndefined`, not
  `emptyToUndefined`): a padded value is preserved as-is outside production and
  rejected in production — no connection value is ever silently trimmed.
