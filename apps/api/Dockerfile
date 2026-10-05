# syntax=docker/dockerfile:1
#
# @iptv/api image (also serves the `migrate` job — same build, different
# entrypoint, see deploy/staging/docker-compose.staging.yml).
#
# Layout: base (pinned toolchain) → deps (lockfile install) → build (tsc) →
# runtime (prod-only install + built dist). Multi-stage so the runtime carries
# no compiler, no dev dependencies and no source tree.
#
# pnpm workspace notes (this repo is pnpm 10.15.0 + Turborepo):
# - `pnpm-lock.yaml` + every workspace `package.json` are copied BEFORE any
#   install, otherwise `--frozen-lockfile` cannot match the lockfile importers.
# - The runtime install is FILTERED (`--filter @iptv/api...`) on purpose: a
#   full-workspace prod install would drag next/react (web) and playwright
#   (browser-worker) into the API image for nothing. Verified: the filtered
#   install resolves only the 9 projects the API needs.
# - Sources are copied AFTER the install so editing code does not invalidate the
#   dependency layer.
#
# Known trade-offs (deliberate, not accidental):
# - The migration job reuses this image: `node packages/database/dist/bin/
#   iptv-migrate.js` with the owner `DATABASE_URL`. One build, two roles.
# - Migrations are NEVER run by the API on boot (`CMD` starts the HTTP server
#   only); the dedicated job owns schema changes.
#
# Base image is digest-pinned (same convention as deploy/infisical and the
# pgbouncer service in docker-compose.yml). Refresh with:
#   docker buildx imagetools inspect node:22-alpine

ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# ---------------------------------------------------------------------------
# base: pinned node + corepack-managed pnpm (never the distro `npm`).
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
# Corepack downloads pnpm on demand: silence the interactive prompt so a build
# can never block on a TTY.
#
# NOTE: `NODE_ENV` is deliberately NOT set here. pnpm skips devDependencies
# when it sees `NODE_ENV=production`, which would leave the build stage without
# typescript. Production mode is set in the runtime stage instead.
ENV PNPM_HOME=/pnpm \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate && pnpm --version

# ---------------------------------------------------------------------------
# deps: full (dev+prod) install of the whole workspace. The lockfile demands
# every importer, so all manifests are present here.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/browser-worker/package.json apps/browser-worker/package.json
COPY packages/ai-runtime/package.json packages/ai-runtime/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/secrets/package.json packages/secrets/package.json
COPY packages/workflows/package.json packages/workflows/package.json
# Workspace links are relative, so the directory layout must match the repo.
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build: compile ONLY the api and its workspace dependencies. `tsc` is driven
# through pnpm's topological filter (each package runs its own build script),
# so no turbo cache/telemetry is involved in the image build.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages packages
RUN pnpm --filter @iptv/api... build

# ---------------------------------------------------------------------------
# runtime: prod-only deps for the api subset + the built output. No sources,
# no TypeScript, no test tooling.
# ---------------------------------------------------------------------------
FROM base AS runtime
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/browser-worker/package.json apps/browser-worker/package.json
COPY packages/ai-runtime/package.json packages/ai-runtime/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/secrets/package.json packages/secrets/package.json
COPY packages/workflows/package.json packages/workflows/package.json
# `--ignore-scripts`: no production dependency of the api graph ships a
# required build/postinstall step (nestjs, fastify, kysely, pg, zod are pure
# JS), and running install scripts as root during a build is a needless risk.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@iptv/api..."

COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/ai-runtime/dist ./packages/ai-runtime/dist
COPY --from=build /app/packages/auth/dist ./packages/auth/dist
COPY --from=build /app/packages/config/dist ./packages/config/dist
COPY --from=build /app/packages/database/dist ./packages/database/dist
COPY --from=build /app/packages/domain/dist ./packages/domain/dist
COPY --from=build /app/packages/observability/dist ./packages/observability/dist
COPY --from=build /app/packages/secrets/dist ./packages/secrets/dist
COPY --from=build /app/packages/workflows/dist ./packages/workflows/dist
# Migrations travel with the image: the `migrate` job applies them, the API
# only reads the schema. Append-only files, checksum-verified by the runner.
COPY db/migrations ./db/migrations

ENV MIGRATIONS_DIR=/app/db/migrations \
    NODE_ENV=production
# A repository `.npmrc` (none today) MUST be added to both COPY lines above
# before it exists, otherwise `--frozen-lockfile` would install with different
# settings than CI.
# `LOG_LEVEL` is NOT defaulted here on purpose: the Fastify logger is disabled
# when it is unset (apps/api/src/request-id.ts), and a container that boots
# silently is worse than one that refuses to be configured by accident.
# deploy/staging/.env.staging.example documents the required values.

# Non-root (uid/gid 1000 from the base image). Everything above is read-only at
# runtime, so no chown pass is needed.
USER node

EXPOSE 3001

# Readiness, not liveness: `/v1/health/ready` additionally proves the database
# answers `SELECT 1`, which is what "able to serve traffic" means for this API.
# alpine has no curl/wget, hence node's own fetch. Unhealthy does NOT restart
# the container (no `restart` on health failure): a database blip must not
# turn into a restart loop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/v1/health/ready').then(function(r){if(!r.ok)process.exit(1)}).catch(function(){process.exit(1)})"

CMD ["node", "apps/api/dist/main.js"]