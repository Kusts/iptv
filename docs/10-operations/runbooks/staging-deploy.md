# Runbook — Staging Deploy (Containerized, Migrate Job First)

> Status: Reproducible compose profile; images proven by a real `docker build`
> + full stack proof on 2026-10-06 (branch `Kusts/closure-round-p0-rls-cutover`,
> PR #6 — api/web built, postgres → migrate 49/49 on empty DB → api as
> `iptv_app` + web, health/ready, restart, backup → destroy → restore →
> migrate no-op 0/49 → smoke; see execution log below). Scheduling/offsite/
> PITR remain operator work — see "Known assumptions". The contract
> it enforces (migrations run only through the `migrate` job, with owner
> credentials, before the API starts) is the part that matters most and is
> covered by tests.
> Version: 1.0

## Scope and shape

Single host, containers, staging data. One compose file
(`deploy/staging/docker-compose.staging.yml`) builds from the repository root:
images are digest-pinned, long-running services are `restart: unless-stopped`
with a healthcheck, and every published port binds to `127.0.0.1` — public
traffic is terminated by a reverse proxy or tunnel outside this file.

```text
postgres (healthy) ──▶ migrate (one-shot, exit 0) ──▶ api (ready) ──▶ web
                                                browser-worker  (opt-in profile)
                                                pgbouncer       (opt-in profile)
                                                outbox-worker   (opt-in profile, ONLY after legacy quiescence)
```

Deploy order is expressed in `depends_on` and must not be reordered by hand:
`postgres → migrate → api → web`.

## Prerequisites

1. Docker Engine with the compose v2 plugin (`docker compose version`) and
   enough disk for the postgres volume plus three images.
2. `deploy/staging/.env.staging` created from the example and filled with real
   values — never committed, never pasted into tickets:
   ```powershell
   Copy-Item deploy/staging/.env.staging.example deploy/staging/.env.staging
   ```
3. `LOG_LEVEL` set in `.env.staging`. It is required on purpose: the Fastify
   logger is disabled when it is unset, so a container without it boots silently.
4. `NODE_ENV=production` implies two more hard requirements, both enforced by
   `packages/config` at boot: a real `BETTER_AUTH_SECRET` and
   `PROVIDER_DISPATCH_MODE=durable`.
5. Infisical reachable from the host and from the containers when
   `INFISICAL_*` is filled: without it the secrets adapter stays noop and every
   `infisical://` ref fails closed (ADR-0014, `packages/secrets/README.md`).
6. `APP_DATABASE_URL` must be SET to a valid restricted `iptv_app` connection
   (the fail-closed boot guard refuses to start the API without it when
   `NODE_ENV=production` — there is no owner fallback). This is rehearsal,
   NOT cutover: pointing the app at `iptv_app` today means fail-closed reads
   on every domain that is not enrolled yet — see
   [RLS role split cutover](rls-role-split-cutover.md). If the API container
   crash-loops at boot, read its logs first (`... logs api`): with
   `restart: unless-stopped` an invalid configuration restarts forever by
   design — fix the env, then `up -d --force-recreate api`. Never "fix" it
   by giving the API owner credentials.

## Build

```powershell
docker compose --env-file deploy/staging/.env.staging `
  -f deploy/staging/docker-compose.staging.yml build
```

`--env-file` is required on every compose command: the file drives both
interpolation (`${DATABASE_URL:?...}` guards) and the containers' `env_file`.

Images produced:

| Service | Image | Notes |
| --- | --- | --- |
| `api` | `iptv-staging-api:local` | also runs the `migrate` job |
| `migrate` | `iptv-staging-migrate:local` | same Dockerfile, different entrypoint |
| `web` | `iptv-staging-web:local` | Next.js standalone |
| `browser-worker` | `iptv-staging-browser-worker:local` | opt-in profile, see limitations |
| `outbox-worker` | `iptv-staging-outbox-worker:local` | opt-in profile, ONLY after legacy quiescence (see below) |

Tag images with an immutable revision before a real environment (see Rollback).

## Deploy

```powershell
# 1. database
docker compose --env-file deploy/staging/.env.staging `
  -f deploy/staging/docker-compose.staging.yml up -d postgres
# 2. migrations (one-shot; a non-zero exit must stop the rollout)
docker compose --env-file deploy/staging/.env.staging `
  -f deploy/staging/docker-compose.staging.yml run --rm migrate
# 3. api + web (compose re-checks the migrate dependency only on `up`)
docker compose --env-file deploy/staging/.env.staging `
  -f deploy/staging/docker-compose.staging.yml up -d api web
```

`run --rm migrate` prints one summary line and exits:

```text
iptv-migrate: applied=49 skipped=0 total=49 dir=/app/db/migrations
```

`applied=0 skipped=49` on a re-deploy is the expected idempotent no-op. Running
the same `up -d` again without a code change is therefore safe.

Rules that are not negotiable:

- Migrations run ONLY through the `migrate` job, and only with the OWNER
  connection string in `DATABASE_URL`. The CLI refuses to run as `iptv_app`
  before it opens a connection.
- The API NEVER migrates on boot. There is no boot-migrate path.
- The API NEVER receives the owner connection: `DATABASE_URL` and
  `POSTGRES_PASSWORD` in `.env.staging` exist for interpolation + the migrate
  job only; the compose file blanks them for the `api` service, and the
  production boot guard fails the boot if they ever reach the API process
  (proven 2026-10-06: first staging boot refused with `DATABASE_URL must NOT
  be present in the API process`).
- The migrate job has `restart: "no"` on purpose: a failed migration must stop
  the rollout, not retry against a half-migrated schema.

## Verification

```powershell
# readiness: 200 only when the database answers SELECT 1
curl.exe -i http://127.0.0.1:3001/v1/health/ready
# liveness: always 200 while the process runs (dependency-free)
curl.exe -i http://127.0.0.1:3001/v1/health
# web
curl.exe -i http://127.0.0.1:3000/
# state of the stack
docker compose --env-file deploy/staging/.env.staging `
  -f deploy/staging/docker-compose.staging.yml ps
docker compose --env-file deploy/staging/.env.staging `
  -f deploy/staging/docker-compose.staging.yml logs --tail 100 api
```

Expected: `/v1/health/ready` → `200 {"status":"ok","checks":{"database":"ok"}}`;
`/v1/health` keeps its original body (status/version/requestId/scheduler/
tickSeconds) so the liveness contract is unchanged. A `503` from `/ready` means
"running but not serving traffic" — keep the container up and fix the database;
do not restart it in a loop. Deeper checks: outbox/workflow backlog and
database health are covered by
[outbox backlog](outbox-workflow-backlog.md) and
[database degraded](database-degraded.md).

## Outbox worker activation (pós-050, opt-in)

The dedicated worker (`--profile outbox`) is NEVER part of the default `up`.
Fresh staging order: `postgres → migrate 001–050 (owner) → api (as
`iptv_app`, legacy drain still enabled by default) → web`, then:

```powershell
# 1. prove ZERO legacy drain in flight BEFORE touching the api service
#    (a stopped trigger is not proof). Recreating api mid-drain strands rows:
#    legacy claims only PENDING/FAILED and flips them to PUBLISHING with NO
#    lease, while the worker only reclaims PUBLISHING rows with a non-null
#    EXPIRED lease — a mid-drain kill leaves PUBLISHING rows with null lease
#    that NEITHER drainer reclaims.
curl.exe -i http://127.0.0.1:3001/v1/admin/outbox/drain-state
#    expect {"legacyDrainEnabled":true,"inFlight":0,...} (platform-admin auth);
#    if inFlight > 0, wait and re-poll — do NOT proceed to step 2.
# 2. disable new legacy drains (API-side gate; scheduler skips its outbox tick)
#    in .env.staging: LEGACY_OUTBOX_DRAIN_ENABLED=0, then PROMPTLY recreate
#    the api service. Keep the window between step 1 and this recreate short:
#    any drain that starts in between re-opens the stranding window, so
#    re-verify inFlight 0 immediately before recreating.
# 3. prove ZERO in flight again AFTER the recreate
curl.exe -i http://127.0.0.1:3001/v1/admin/outbox/drain-state
#    expect {"legacyDrainEnabled":false,"inFlight":0,...} (platform-admin auth)
# 4. set the worker password once (migration 050 sets none) and fill the
#    LOCAL .env.staging.outbox-worker (from its .example), asserting
#    OUTBOX_LEGACY_QUIESCED=1 only now
# 5. boot rehearsal with zero claims, then a single bounded batch
docker compose --env-file deploy/staging/.env.staging `
  -f deploy/staging/docker-compose.staging.yml --profile outbox `
  run --rm outbox-worker check
docker compose --env-file deploy/staging/.env.staging `
  -f deploy/staging/docker-compose.staging.yml --profile outbox `
  run --rm outbox-worker run --once
# 6. start the loop only after the smoke passes
docker compose --env-file deploy/staging/.env.staging `
  -f deploy/staging/docker-compose.staging.yml --profile outbox `
  up -d outbox-worker
```

Stranded-row detection (operator triage, NOT automatic SQL surgery): rows in
`PUBLISHING` with a null lease (`claim_token IS NULL`) are stranded by a
mid-drain api recreate and are invisible to both drainers. Detect with
`SELECT count(*) FROM platform.outbox_messages WHERE state = 'PUBLISHING'
AND claim_token IS NULL`; any nonzero count after steps 1–3 is an
operator triage event (inspect, then forward-fix deliberately — never an
ad-hoc state flip).

Confirm in PostgreSQL: API session = `iptv_app`, worker session =
`outbox_worker`, migrations ran as owner, no role with `BYPASSRLS`
(`SELECT rolname FROM pg_roles WHERE rolbypassrls`). Staging E2E on the
worker: happy publish, fail/retry, renew, reclaim, restart, stale token,
activation refusal while legacy is enabled. Rollback: stop the worker, await
in-flight, confirm zero `PUBLISHING` rows with live leases before any legacy
re-arm — residual fenced rows are forward-fix via the worker (the legacy
drain cannot reclaim them). Full procedure and crash semantics:
[RLS role split cutover](rls-role-split-cutover.md) ("Worker process +
legacy quiescence") and `apps/outbox-worker/README.md`.

## Rollback

Decide forward-fix vs rollback BEFORE touching the environment:

- **Forward-fix** is the default. Migrations are append-only and the expand /
  migrate / contract discipline means the previous image normally keeps working
  against the new schema. Add a new migration and redeploy.
- **Rollback the image** when the defect is purely application code and the
  schema is compatible. Pin the previous tag in the compose `image:` line (or
  tag it before the rollout) and `up -d` again — schema changes are never
  reverted by an image rollback, there are no down migrations.
- **Restore from backup** only when integrity actually requires it, following
  the DR process. A failed migration is handled in
  [Migration failure](migration-failure.md): determine whether the transaction
  rolled back, do not blindly re-run non-idempotent data movement, and prefer a
  forward-fix over a destructive reversal.

```powershell
# pin the known-good image tags, then recreate only the app services
docker compose --env-file deploy/staging/.env.staging `
  -f deploy/staging/docker-compose.staging.yml up -d --no-deps api web
```

Database rollback caveat: `platform.migration_history` is append-only and
content-hashed. Re-running a migration whose bytes changed after it was applied
fails loudly on purpose — write a new migration instead of editing an applied
one.

## Optional profiles

- **Pooler** (`--profile pooling`): mirrors the dev compose service. Migrations
  and owner traffic stay DIRECT; only `iptv_app` DML may be pooled, and only
  after the step 4 certification in
  [RLS role split cutover](rls-role-split-cutover.md). Needs
  `deploy/pgbouncer/pgbouncer.ini` plus a local, gitignored userlist.
- **Browser worker** (`--profile worker`): an on-demand operator smoke CLI, not
  a service.
  ```powershell
  docker compose --env-file deploy/staging/.env.staging `
    -f deploy/staging/docker-compose.staging.yml --profile worker \
    run --rm browser-worker read-credit-balance
  ```
  Honest limitations: the image ships no browser binary (no `playwright
  install`), headed Chromium needs a display, and headless Chromium in a
  container is a NEW, uncertified execution environment for the drift/challenge
  detection certified on a desktop browser. Prefer running the worker on the
  operator host (see [Browser drift challenge](browser-drift-challenge.md)) and
  treat this image as reproducible packaging plus a reviewed container boundary.
- **Outbox worker** (`--profile outbox`): the dedicated platform outbox
  publisher (migration 050 protocol). Long-running but NEVER default: see
  "Outbox worker activation (pós-050, opt-in)" above. `check` is the compose
  healthcheck (zero claims); `run --once` is the staging smoke.

## Known assumptions (confirmed by the first real `docker build` 2026-10-06)

1. `pnpm install --prod --filter "@iptv/api..."` (and the worker equivalent) is
   the smallest correct runtime install. CONFIRMED inside the image: the api
   image built and booted cleanly 2026-10-06 (PR #6 staging proof).
2. The Next.js standalone layout mirrors the monorepo root, so `server.js` is
   at `apps/web/server.js` in the runtime stage and hashed assets must be copied
   to `apps/web/.next/static`. CONFIRMED: the web image built and serves 200
   on `/` 2026-10-06.
3. `NEXT_PUBLIC_API_BASE_URL` is inlined at build time — changing it requires a
   web image rebuild, not a restart.
4. `corepack prepare pnpm@10.15.0 --activate` needs registry access at build
   time and the matching corepack signature keys in the base image. CONFIRMED
   implicitly: both images built 2026-10-06 with registry access.
5. `apps/web/public` does not exist yet; when it appears, add the `public` COPY
   back to `apps/web/Dockerfile` (the comment in that file says which line).

## Related runbooks

- [Migration failure](migration-failure.md) — a failed `migrate` job.
- [Database degraded](database-degraded.md) — `/v1/health/ready` returning 503.
- [RLS role split cutover](rls-role-split-cutover.md) — owner vs `iptv_app`.
- [Outbox / workflow backlog](outbox-workflow-backlog.md) — post-deploy drain.