# @iptv/config

Boot-time environment validation: one Zod schema, one `loadConfig()` call.
Everything here runs once at startup — failures are boot failures by design.

## What it is

- `loadConfig(env = process.env)` — validates against the schema and returns
  typed `AppConfig`.
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

**Every key is optional.** Each has a default (or is genuinely optional), so
a missing variable never breaks boot on its own:

| Var | Default |
| --- | --- |
| `NODE_ENV` | `development` (`development`/`test`/`production`) |
| `PORT` | `3001` |
| `DATABASE_URL` | unset |
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