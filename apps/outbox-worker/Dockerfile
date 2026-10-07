# syntax=docker/dockerfile:1
#
# @iptv/outbox-worker image — CLI packaging and boundary only.
#
# The worker drains `platform.outbox_messages` through the four migration-050
# lifecycle functions as the least-privilege `outbox_worker` role (EXECUTE on
# the functions, NO direct table grants). Boot order inside the process is
# config → connect → roleGuard → activation gate → claim loop, so a
# misconfigured container refuses to start instead of publishing half-fenced
# outcomes.
#
# Readiness: this is a long-running CLI, not an HTTP service — there is no
# EXPOSE and no HTTP HEALTHCHECK. Readiness/liveness for compose is the boot
# rehearsal with zero claims:
#
#   node apps/outbox-worker/dist/cli.js check   # exit 0 ready, 2 not-ready
#
# (see deploy compose healthcheck). `run --once` is the staging smoke (one
# bounded batch, then exit).
#
# Base image is digest-pinned (same convention as browser-worker).

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
COPY apps/outbox-worker/package.json apps/outbox-worker/package.json
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
COPY apps/outbox-worker apps/outbox-worker
COPY packages packages
RUN pnpm --filter @iptv/outbox-worker... build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/browser-worker/package.json apps/browser-worker/package.json
COPY apps/outbox-worker/package.json apps/outbox-worker/package.json
COPY packages/ai-runtime/package.json packages/ai-runtime/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/secrets/package.json packages/secrets/package.json
COPY packages/workflows/package.json packages/workflows/package.json
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@iptv/outbox-worker..."

COPY --from=build /app/apps/outbox-worker/dist ./apps/outbox-worker/dist
COPY --from=build /app/packages/domain/dist ./packages/domain/dist

USER node

# No EXPOSE and no HEALTHCHECK on purpose: readiness is `cli.js check`
# (used as the compose healthcheck), not an HTTP endpoint.
ENTRYPOINT ["node", "apps/outbox-worker/dist/cli.js"]
CMD ["run"]
