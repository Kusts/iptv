# syntax=docker/dockerfile:1
#
# @iptv/browser-worker image — CLI packaging and boundary only.
#
# READ THIS BEFORE TRUSTING THIS IMAGE FOR RUNTIME.
#
# What the worker IS: a single-binding, read-only operator smoke CLI
# (apps/browser-worker/README.md). It drives a real Chromium against the
# CINEVISION panel, holds a per-binding profile directory with a `.lock`
# sidecar, and resolves three secrets through its own Infisical identity
# (`BROWSER_INFISICAL_*`). There is no HTTP server and no scheduler: it is run
# interactively, one subcommand at a time, and exits.
#
# What this image is NOT: a certified headless runner.
#   - `BROWSER_WORKER_HEADLESS=0` (headed) is the realistic mode, and headed
#     Chromium needs a display plus the browser sandbox. This image ships
#     Playwright's driver but does NOT run `playwright install`, so the
#     browser binary is absent; running it would require `npx playwright
#     install --with-deps chromium` inside a derived image (adds ~300 MB and
#     shared-memory requirements).
#   - Headless Chromium in a container changes what the page renders and how
#     challenges behave. The provider-drift/challenge detection in this repo
#     was certified against a desktop browser, so a container is a NEW,
#     uncertified execution environment — do not use it to decide whether a
#     challenge is "just drift".
#   - The OS user container assumption behind `BROWSER_WORKER_PROFILE_ROOT`
#     (Windows) does not hold in a Linux container; profile isolation then
#     relies on the container's own uid.
#
# Intended usage (see deploy/staging/docker-compose.staging.yml, profile
# `worker`): an operator runs it on demand, from a host that HAS a display and
# a real profile directory, and inspects the single JSON envelope it prints:
#
#   docker compose -f deploy/staging/docker-compose.staging.yml \
#     --profile worker run --rm browser-worker read-credit-balance
#
# The image exists so the worker's dependency graph is reproducible and so the
# container boundary (non-root uid, no writable repo, ephemeral profile
# volume) is reviewable — not so routine operation moves into Docker.
#
# Base image is digest-pinned (same convention as deploy/infisical).

ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE} AS base
# No NODE_ENV here: pnpm would skip devDependencies.
ENV PNPM_HOME=/pnpm \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate && pnpm --version

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
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
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/browser-worker apps/browser-worker
COPY packages packages
RUN pnpm --filter @iptv/browser-worker... build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
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
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@iptv/browser-worker..."

COPY --from=build /app/apps/browser-worker/dist ./apps/browser-worker/dist
COPY --from=build /app/packages/secrets/dist ./packages/secrets/dist

# Profile directory: writable by the non-root uid, created as an empty dir so
# the compose volume has the right ownership from the first run. Populated per
# binding and never shared between runs.
RUN mkdir -p /app/profile && chown -R node:node /app/profile
VOLUME ["/app/profile"]

USER node

# No EXPOSE and no HEALTHCHECK on purpose: this is a one-shot CLI, not a
# service. `docker compose run --rm browser-worker <subcommand>` is the
# supported invocation.
ENTRYPOINT ["node", "apps/browser-worker/dist/cli.js"]
CMD ["--help"]