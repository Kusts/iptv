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
   The live-activation path is "Infisical activation (staging, opt-in)" below.
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
iptv-migrate: applied=51 skipped=0 total=51 dir=/app/db/migrations
```

`applied=0 skipped=51` on a re-deploy is the expected idempotent no-op. Running
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

## Outbox worker activation (051 interlock, opt-in)

The dedicated worker (`--profile outbox`) is NEVER part of the default `up`.
Fresh staging order (pós-050/051, corrigido 2026-10-17 — ver §12.4 do
`P6-SECURITY.md`): `postgres → migrate 001–060 (owner, re-provision FRESH)
→ api (as `iptv_app`, `LEGACY_OUTBOX_DRAIN_ENABLED=0`) → web`, then:

> Nota 2026-10-17: stacks com drift de migration (origem ≠ HEAD) seguem
> re-provision FRESH (`down -v` + migrate total), nunca migração
> incremental sobre stack antigo — ver §5.1 do `P6-DR.md`. A ativação
> abaixo é o caminho forward (Opção B) com worker profile; o combo
> `iptv_app` + LEGACY + drain enabled jamais foi suportado
> (ver §12.4 do `P6-SECURITY.md`).

> SUPERSEDED (migration 051): the old env-copy activation (copying observed
> drain-state values into the worker env as the authority) is replaced by the
> DATABASE live-interlock `platform.outbox_runtime_control`
> (`LEGACY → QUIESCING → WORKER`, rollback `WORKER → QUIESCING → LEGACY`) via
> `platform.outbox_runtime_set()`. The env values stay as a fail-closed
> operator assertion, but the DATABASE decides who may publish: the legacy
> drainer consults `platform.outbox_runtime_mode()` before every drain
> (`QUIESCING`/`WORKER` refuse with the same disabled error), and
> `platform.outbox_claim()` raises unless the mode is `WORKER`. An API restart
> cannot change the mode — only `set()` (superuser operator, granted to NOBODY)
> switches it, with a two-key CAS on `(mode, generation)`. First proven
> end-to-end 2026-10-07 (STAGING-P0, branch `closure/p0-outbox-interlock`):
> full cycle `LEGACY→QUIESCING→WORKER→QUIESCING→LEGACY` (generations 2–5) —
> see `evidence/staging-p0-051/report.md`.

```powershell
# 1. prove ZERO legacy drain in flight BEFORE touching the api service
#    (a stopped trigger is not proof). Recreating api mid-drain strands rows:
#    legacy claims only PENDING/FAILED and flips them to PUBLISHING with NO
#    lease, while the worker only reclaims PUBLISHING rows with a non-null
#    EXPIRED lease — a mid-drain kill leaves PUBLISHING rows with null lease
#    that NEITHER drainer reclaims.
curl.exe -i http://127.0.0.1:3001/v1/admin/outbox/drain-state
#    expect {"enabled":true,"inFlight":0,...} (platform-admin auth +
#    x-tenant-context-revision header matching the session; without it the
#    guard answers 409 TENANT_CONTEXT_CONFLICT);
#    if inFlight > 0, wait and re-poll — do NOT proceed to step 2.
# 2. disable new legacy drains (API-side gate; scheduler skips its outbox tick)
#    in .env.staging: LEGACY_OUTBOX_DRAIN_ENABLED=0, then PROMPTLY recreate
#    the api service. Keep the window between step 1 and this recreate short:
#    any drain that starts in between re-opens the stranding window, so
#    re-verify inFlight 0 immediately before recreating.
# 3. prove ZERO in flight again AFTER the recreate
curl.exe -i http://127.0.0.1:3001/v1/admin/outbox/drain-state
#    expect {"enabled":false,"inFlight":0,...} (platform-admin auth)
# 4. switch the DATABASE authority (owner psql, superuser operator):
#    observe the generation first, then advance one step at a time —
#    set() refuses skipped steps and stale generations (fixed messages).
#    SELECT mode, generation FROM platform.outbox_runtime_control WHERE id = 1;
#    -- expect LEGACY, generation N
#    SELECT platform.outbox_runtime_set('LEGACY','QUIESCING','<operator>',N);
#    -- returns N+1. Activation MUST start here, never straight to WORKER.
# 5. prove unfenced-zero: no legacy-stranded row may exist before WORKER
#    SELECT count(*) FROM platform.outbox_messages
#      WHERE state = 'PUBLISHING' AND lease_expires_at IS NULL;
#    -- must be 0, else set() to WORKER refuses (operator triage, see below).
#    SELECT platform.outbox_runtime_set('QUIESCING','WORKER','<operator>',N+1);
#    -- returns N+2. The worker protocol is authoritative only now.
# 6. set the worker password once (migration 050 sets none) and fill the
#    LOCAL .env.staging.outbox-worker (from its .example), asserting
#    OUTBOX_LEGACY_QUIESCED=1 plus the OBSERVED drain-state
#    (OUTBOX_LEGACY_DRAIN_ENABLED=0, OUTBOX_LEGACY_IN_FLIGHT=0) only now
# 7. boot rehearsal with zero claims, then a single bounded batch
docker compose --env-file deploy/staging/.env.staging `
  -f deploy/staging/docker-compose.staging.yml --profile outbox `
  run --rm outbox-worker check
docker compose --env-file deploy/staging/.env.staging `
  -f deploy/staging/docker-compose.staging.yml --profile outbox `
  run --rm outbox-worker run --once
# 8. start the loop only after the smoke passes
docker compose --env-file deploy/staging/.env.staging `
  -f deploy/staging/docker-compose.staging.yml --profile outbox `
  up -d outbox-worker
```

Rollback is a forward transition, never a data repair: stop the worker, await
in-flight (zero `PUBLISHING` rows with live leases), then
`set('WORKER','QUIESCING',...)` → `set('QUIESCING','LEGACY',...)` and re-arm
the legacy drain (`LEGACY_OUTBOX_DRAIN_ENABLED=1` + recreate api, then
drain-state shows `enabled:true,inFlight:0`).

Stranded-row detection (operator triage, NOT automatic SQL surgery): rows in
`PUBLISHING` with a null lease (`lease_expires_at IS NULL`, equivalently
`claim_token IS NULL`) are stranded by a mid-drain api recreate and are
invisible to both drainers. `set()` to `WORKER` refuses while any exists —
that refusal IS the guard working, not a migration problem. Inspect, then
forward-fix deliberately — never an ad-hoc state flip.

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

## Infisical activation (staging, opt-in)

Canonical live-activation path for the API-side Infisical identity on
staging. Starting state on the host (2026-10-17):
`deploy/staging/.env.staging` (full host path
`/home/deploy/iptv/deploy/staging/.env.staging`) already carries a commented
placeholder block for the four vars below (marker
`STAGING-INFISICAL-ACTIVATION 2026-10-17`) — the operator fills/uncomments
it; nobody needs to create it. Only `INFISICAL_ENVIRONMENT=staging` is
active, so the API boots into the noop adapter: boot succeeds, every secret
consumption fails closed. Authority:
[ADR-0014](../../06-decisions/ADR-0014-infisical-secrets.md) and the
[packages/secrets](../../../packages/secrets/README.md) resolution contract;
identity/RBAC shape follows
[deploy/infisical/machine-identities.md](../../../deploy/infisical/machine-identities.md).

File-path rule: the `api` service consumes `env_file: - .env.staging`
relative to the compose file's directory
(`deploy/staging/docker-compose.staging.yml`, `api` service), so the
effective file is ALWAYS
`/home/deploy/iptv/deploy/staging/.env.staging`. A `.env.staging` at the
repo/host ROOT is NOT consumed by compose — do not create or edit one.
Every compose invocation below runs from `cd /home/deploy/iptv` in the
canonical form:

```sh
docker compose -p iptv-staging --env-file deploy/staging/.env.staging \
  -f deploy/staging/docker-compose.staging.yml <subcommand>
```

### 1. Prerequisites (cofre operator owns this step)

- The cofre operator/operadora creates a dedicated Universal Auth machine
  identity (client-id + client-secret) for the staging API, bound to a
  minimal project role: read-only on the API-owned secret paths for the
  `staging` environment, no write, no worker paths.
- The agent NEVER creates, rotates, or re-issues credentials; it only
  receives the four values through the host channel in step 2.
- CINEVISION/MK Ativador credentials already live in the cofre as secrets —
  raw values stay in the operator's vault, never in this repo.

### 2. Fill the four vars in the compose env_file (no Git/PR/log/ticket)

On the host, over SSH, from `cd /home/deploy/iptv`, edit
`deploy/staging/.env.staging` directly with an editor (no `echo` into shared
history, no paste into tickets or PRs): uncomment the
`STAGING-INFISICAL-ACTIVATION 2026-10-17` block and fill it:

```text
INFISICAL_SITE_URL=<from the operator>
INFISICAL_PROJECT_ID=<from the operator>
INFISICAL_CLIENT_ID=<from the operator>
INFISICAL_CLIENT_SECRET=<from the operator>
```

`INFISICAL_ENVIRONMENT=staging` is already active. The commented
placeholders in the repo-side `deploy/staging/.env.staging.example` stay
as-is; the real host file is gitignored. Back up the previous file first —
rollback needs it.

### 3. Activate at least one real ref

Point at least one already-registered secret in the cofre's `staging`
environment, stored as a `secret_ref` in the
`infisical://<environment>/<path...>/<key>` grammar
([packages/secrets](../../../packages/secrets/README.md); lab-documented
shape `infisical://dev/browser-worker/CINEVISION_URL` — real key names are
read from the cofre panel, never invented here).

### 4. Apply (api service only)

```sh
cd /home/deploy/iptv
docker compose -p iptv-staging --env-file deploy/staging/.env.staging \
  -f deploy/staging/docker-compose.staging.yml up -d --force-recreate api
```

Restricted to the `api` service. Never `down` the stack for this change;
never `down -v` (a FRESH re-provision is a DR decision, not an activation
step).

### 5. Smoke (proves the activation; health/ready alone do not)

`/v1/health` and `/v1/health/ready` CANNOT prove the activation: the adapter
resolves and authenticates lazily, only inside `getSecret`.

a) Effective-env name inventory (after the recreate, with the four vars
   filled) — names only, never values:

```sh
docker exec iptv-staging-api sh -c "env | grep -oE '^INFISICAL_[A-Z_]+' | sort"
```

Expect the four names (`INFISICAL_SITE_URL`, `INFISICAL_PROJECT_ID`,
`INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`) plus
`INFISICAL_ENVIRONMENT`.

b) Real cofre read through the adapter's own mechanics, running the repo's
   standalone script INSIDE the api container. The image ships no linkable
   `node_modules/@iptv` copy and no script, so the script travels over stdin
   (delivery validated on the host; removed right after the run):

```sh
cd /home/deploy/iptv
docker exec -i iptv-staging-api sh -c 'cat > /tmp/infisical-smoke.mjs && node /tmp/infisical-smoke.mjs <SECRET_KEY> staging <SECRET_PATH>; rc=$?; rm -f /tmp/infisical-smoke.mjs; exit $rc' < packages/secrets/scripts/infisical-smoke.mjs
```

- `<SECRET_KEY>` is a REAL key already in the cofre (the operator reads the
  name from the cofre panel, e.g. a CINEVISION/MK key — values are never
  invented or printed).
- `<SECRET_PATH>` is optional: REQUIRED when the activated ref lives in a
  folder (copy the secretPath shown in the panel, e.g. `/api`); omit it for a
  root secret (default `/`).
- The relative `packages/secrets/scripts/...` path is the host's `git archive`
  tree, resolved from `cd /home/deploy/iptv`.
- Success expect: `ok: secret presente, len=N` — nothing else printed. The
  script performs Universal Auth login + raw read, the same login/read flow
  as the adapter.

Honest scope note: `@iptv/secrets` is only exercised end-to-end at the API's
first real consumption (the adapter is lazy); this smoke validates
credential + RBAC + presence with the adapter's SAME login/read flow
(Infisical UA login + `/api/v3/secrets/raw`), in the api's effective
environment.

c) Complementary process/database check (not activation proof):

```sh
curl -i http://127.0.0.1:3001/v1/health
curl -i http://127.0.0.1:3001/v1/health/ready
```

Expect `200` on both. Never print secret values — presence/length only.

### 6. Rollback

Restore the backed-up `deploy/staging/.env.staging` (without the four vars)
and recreate `api` as in step 4. The stack returns to the noop fail-closed
state (boot ok, secret consumption refused with typed `CONFIG` errors).

### 7. Safety restrictions

- The self-hosted Infisical server on this host runs as the NEIGHBOUR
  project's container (`infisical`, synkroo production) — never mutate,
  restart, or reconfigure it, nor `synkroo-prod-*` / `traefik` from this lane.
- Secrets never enter the repo, logs, docs, or tickets — refs only.
- Do not re-grant `iptv_app` to the outbox path: stranded-row triage stays
  forward-fix via the worker (see "Outbox worker activation" above).

## Public entrypoint (staging tunnel, opt-in)

Exposes the staging stack publicly WITHOUT touching the neighbour `traefik`
lane: a lane-owned Cloudflare Zero Trust tunnel (`iptv-staging`,
remote-managed `config_src=cloudflare`) with ingress
`staging-api.synkroo.com.br -> http://127.0.0.1:3001` and
`staging-web.synkroo.com.br -> http://127.0.0.1:3000`, plus proxied CNAMEs to
`<tunnel-id>.cfargotunnel.com`. TLS terminates at the Cloudflare edge; origins
stay loopback-bound no matter what binds there.

### 1. Provision (operator/CF admin owns the edge state)

Tunnel, ingress and DNS are first-class Cloudflare objects, created and
updated from the Cloudflare API or dashboard — never hand-carried values. The
only LOCAL artefact is `IPTV_STAGING_TUNNEL_TOKEN` in the compose env_file
(host-only, gitignored file, never in Git/PR/log/ticket).

### 2. Apply

1. Land the changed deploy files on the pinned tree. The staging host is a
   PINNED-COPY deploy (`.staging-revision` marker, no `.git`): fetch a
   reference checkout locally and `scp` the runtime file(s) you changed —
   for this entrance, `deploy/staging/docker-compose.staging.yml` — from it,
   backing the old file up as `.bak-pre-<tag>` first (mode 600) and md5sum
   both. The `.staging-revision` marker stays AS-IS for a partial-copy sync
   (the tree is not a full checkout of the pinned revision); record the
   synced-file md5s in the artifacts report.
2. Ensure `IPTV_STAGING_TUNNEL_TOKEN` is set in `deploy/staging/.env.staging`.
3. Boot the tunnel only:
   `docker compose -p iptv-staging --env-file deploy/staging/.env.staging -f
   deploy/staging/docker-compose.staging.yml up -d tunnel`
4. Re-bake the public origin into the web build and recreate both app
   services (web var is BUILD-time; api vars are runtime):
   `docker compose -p iptv-staging --env-file deploy/staging/.env.staging -f
   deploy/staging/docker-compose.staging.yml build web`
   `docker compose -p iptv-staging --env-file deploy/staging/.env.staging -f
   deploy/staging/docker-compose.staging.yml up -d --force-recreate api web`
5. Smoke: `curl -i https://staging-api.synkroo.com.br/v1/health` (expect 200),
   `curl -i https://staging-web.synkroo.com.br/` (expect 200), and grep the
   served web bundle for the api hostname (pattern of
   `evidence/p7-rehearsal/report.md:29`). Expect the CONTROL CENTER login to
   actually reach the API from a public browser session now (prior state was
   the baked `staging.example.com` placeholder, i.e., total NETWORK_ERROR).

### 3. Rollback

Remove (or empty) the `IPTV_STAGING_TUNNEL_TOKEN` line and
`docker compose -p iptv-staging ... rm -sf tunnel`, or flip the tunnel paused
at the Cloudflare edge (Zero Trust -> Tunnels). Baked origins revert only by
re-rebuilding web with the private assumptions; API-side vars revert by
recreate with the restored env (see the generic Rollback section below). Also
restore `docker-compose.staging.yml` from `.bak-pre-<tag>` (and re-sync the
marker protocol expectations) so the tree matches what the edge no longer
points to.

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
  Privilege-boundary rule (STAGING-P0 correction): restore WITH owners — NEVER
  `--no-owner` (it flattens the 050/051 boundary: everything lands on the
  restoring superuser and `SECURITY DEFINER` would execute as superuser).
  Pre-provision the scenario-B roles first (`iptv_app` / `outbox_worker` LOGIN
  NOBYPASSRLS, `outbox_executor` NOLOGIN NOINHERIT NOBYPASSRLS), restore as the
  owner superuser, then VERIFY post-restore (050/051 tables + six lifecycle
  functions `outbox_executor`-owned `SECURITY DEFINER`, exact EXECUTE grants,
  `set()` granted to nobody) BEFORE `migrate no-op` + `ready`. Proven
  2026-10-07 (`evidence/staging-p0-051/report.md` §4).

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
  `deploy/pgbouncer/pgbouncer.ini` plus a local, gitignored userlist
  (`deploy/pgbouncer/userlist.staging.txt` on staging — same SCRAM-plaintext
  rule as the dev `userlist.txt`). Certified 2026-10-08 on the 059 tree in
  lane `iptv-cutover` (readiness + full A/B matrix through the pooler,
  identical to direct): see `evidence/rls-cutover/report.md`.
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
  publisher (050 leased protocol under the 051 runtime interlock).
  Long-running but NEVER default: see
  "Outbox worker activation (051 interlock, opt-in)" above. `check` is the compose
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